/**
 * Run selection inside MLX's validation callback. A log labelled "Iter N"
 * evaluates weights BEFORE update N; the callback's iteration is N - 1.
 * Copying checkpoint N based on that log would select unevaluated weights.
 * This wrapper leaves the normal MLX CLI and its argument parsing in charge.
 */
export const EARLY_STOPPING_SCRIPT = String.raw`
import json
import math
import sys
from pathlib import Path

import mlx.core as mx
from mlx.utils import tree_flatten
from mlx_lm import lora
from mlx_lm.tuner.callbacks import TrainingCallback

patience = int(sys.argv.pop(1))
load_best = sys.argv.pop(1) == "true"
best_path = Path(sys.argv.pop(1))
original_train = lora.train

class EarlyStop(Exception):
    pass

def emit(event):
    print("NANOTUNE_EVENT " + json.dumps(event), flush=True)

def train_with_selection(*args, **kwargs):
    model = kwargs["model"]
    previous = kwargs.get("training_callback")
    best_loss = None
    best_iteration = None
    stalled = 0
    early_stopped = False

    class Callback(TrainingCallback):
        def on_train_loss_report(self, info):
            if previous is not None:
                previous.on_train_loss_report(info)

        def on_val_loss_report(self, info):
            nonlocal best_loss, best_iteration, stalled
            if previous is not None:
                previous.on_val_loss_report(info)
            iteration = int(info["iteration"])
            loss = float(info["val_loss"])
            # Invalid evaluations count toward patience but never win selection.
            finite = math.isfinite(loss)
            emit({"type": "validation", "iteration": iteration,
                  "valLoss": loss if finite else None})
            if finite and (best_loss is None or loss < best_loss):
                if load_best or patience > 0:
                    weights = dict(tree_flatten(model.trainable_parameters()))
                    temporary = best_path.with_suffix(".tmp.safetensors")
                    mx.save_safetensors(str(temporary), weights)
                    temporary.replace(best_path)
                best_loss = loss
                best_iteration = iteration
                stalled = 0
            else:
                stalled += 1
            if patience > 0 and stalled >= patience:
                raise EarlyStop()

    kwargs["training_callback"] = Callback()
    try:
        original_train(*args, **kwargs)
    except EarlyStop:
        early_stopped = True

    emit({"type": "selection", "earlyStopped": early_stopped,
          "bestIteration": best_iteration, "bestValLoss": best_loss,
          "restoreBest": (early_stopped or load_best) and best_iteration is not None})

lora.train = train_with_selection
lora.main()
`.trim();

export interface SelectionEvent {
	type: 'selection';
	earlyStopped: boolean;
	bestIteration: number | null;
	bestValLoss: number | null;
	restoreBest: boolean;
}

export interface ValidationEvent {
	type: 'validation';
	iteration: number;
	valLoss: number | null;
}

/** Only accept the structured records emitted by the wrapper. */
export function parseSelectionEvent(
	line: string,
): SelectionEvent | ValidationEvent | null {
	if (!line.startsWith('NANOTUNE_EVENT ')) return null;
	let event: unknown;
	try {
		event = JSON.parse(line.slice('NANOTUNE_EVENT '.length));
	} catch {
		return null;
	}
	if (!event || typeof event !== 'object') return null;
	const value = event as Record<string, unknown>;
	const validIteration = (n: unknown) =>
		typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
	const validLoss = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
	if (
		value.type === 'validation' &&
		validIteration(value.iteration) &&
		(value.valLoss === null || validLoss(value.valLoss))
	) {
		return value as unknown as ValidationEvent;
	}
	if (
		value.type === 'selection' &&
		typeof value.earlyStopped === 'boolean' &&
		typeof value.restoreBest === 'boolean' &&
		(value.bestIteration === null || validIteration(value.bestIteration)) &&
		(value.bestValLoss === null || validLoss(value.bestValLoss))
	) {
		return value as unknown as SelectionEvent;
	}
	return null;
}
