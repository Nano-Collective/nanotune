import test from "ava";
import { execa, type ResultPromise } from "execa";
import type { MLXTrainingOptions } from "./mlx.js";
import {
  abortTraining,
  buildLoraConfigYaml,
  buildTrainingArgs,
  needsLoraConfig,
  shouldTreatAsStop,
  stopOnAbort,
} from "./mlx.js";

test("MLX output parsing regex works correctly", (t) => {
  // Test the regex pattern used to parse MLX training output
  const pattern =
    /Iter\s+(\d+)(?:\s*\([^)]+\))?:\s*Train loss\s+([\d.]+)(?:,\s*Val loss\s+([\d.]+))?/i;

  // Test standard format
  const line1 = "Iter 10: Train loss 1.234, Val loss 1.456";
  const match1 = line1.match(pattern);
  t.truthy(match1);
  t.is(match1?.[1], "10");
  t.is(match1?.[2], "1.234");
  t.is(match1?.[3], "1.456");
});

test("MLX output parsing handles format without val loss", (t) => {
  const pattern =
    /Iter\s+(\d+)(?:\s*\([^)]+\))?:\s*Train loss\s+([\d.]+)(?:,\s*Val loss\s+([\d.]+))?/i;

  const line = "Iter 50: Train loss 0.456";
  const match = line.match(pattern);
  t.truthy(match);
  t.is(match?.[1], "50");
  t.is(match?.[2], "0.456");
  t.is(match?.[3], undefined);
});

test("MLX output parsing handles format with iteration speed", (t) => {
  const pattern =
    /Iter\s+(\d+)(?:\s*\([^)]+\))?:\s*Train loss\s+([\d.]+)(?:,\s*Val loss\s+([\d.]+))?/i;

  const line = "Iter 100 (15.2 it/s): Train loss 0.342, Val loss 0.298";
  const match = line.match(pattern);
  t.truthy(match);
  t.is(match?.[1], "100");
  t.is(match?.[2], "0.342");
  t.is(match?.[3], "0.298");
});

test("TrainingProgress structure is correct", (t) => {
  const progress = {
    iteration: 50,
    totalIterations: 150,
    trainLoss: 0.456,
    valLoss: 0.423,
  };

  t.is(progress.iteration, 50);
  t.is(progress.totalIterations, 150);
  t.is(progress.trainLoss, 0.456);
  t.is(progress.valLoss, 0.423);
});

function trainingOptions(
  overrides: Partial<MLXTrainingOptions> = {},
): MLXTrainingOptions {
  return {
    model: "Qwen/Qwen2.5-Coder-1.5B-Instruct",
    dataPath: "/path/to/data",
    adapterPath: "/path/to/adapters",
    iterations: 150,
    learningRate: 5e-5,
    batchSize: 4,
    numLayers: 16,
    stepsPerEval: 50,
    saveEvery: 50,
    resume: false,
    fineTuneType: "lora",
    loraRank: 8,
    loraAlpha: 20,
    loraDropout: 0,
    maxSeqLength: 2048,
    gradCheckpoint: false,
    valBatches: 25,
    seed: 0,
    ...overrides,
  };
}

// Reads the value that follows `flag`, so a test fails loudly if a flag is
// dropped or wired to the wrong field rather than passing on a bare includes().
function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

test("buildTrainingArgs passes the hyperparameter flags through to mlx_lm", (t) => {
  const args = buildTrainingArgs(
    trainingOptions({
      fineTuneType: "dora",
      maxSeqLength: 1024,
      valBatches: 10,
      seed: 42,
    }),
  );

  t.is(argValue(args, "--fine-tune-type"), "dora");
  t.is(argValue(args, "--max-seq-length"), "1024");
  t.is(argValue(args, "--val-batches"), "10");
  t.is(argValue(args, "--seed"), "42");
});

test("buildTrainingArgs adds --grad-checkpoint only when enabled", (t) => {
  t.false(buildTrainingArgs(trainingOptions()).includes("--grad-checkpoint"));
  t.true(
    buildTrainingArgs(trainingOptions({ gradCheckpoint: true })).includes(
      "--grad-checkpoint",
    ),
  );
});

test("buildTrainingArgs passes the lora config path when given one", (t) => {
  const args = buildTrainingArgs(trainingOptions(), "/tmp/lora.yaml");
  t.is(argValue(args, "-c"), "/tmp/lora.yaml");
});

test("buildTrainingArgs omits -c when no lora config was written", (t) => {
  t.false(buildTrainingArgs(trainingOptions()).includes("-c"));
});

test("buildTrainingArgs still wires --resume-adapter-file", (t) => {
  const args = buildTrainingArgs(trainingOptions({ resume: true }));
  t.is(
    argValue(args, "--resume-adapter-file"),
    "/path/to/adapters/adapters.safetensors",
  );
});

test("needsLoraConfig is false for full fine-tuning only", (t) => {
  // `full` trains weights directly, so mlx_lm never reads lora_parameters.
  t.true(needsLoraConfig("lora"));
  t.true(needsLoraConfig("dora"));
  t.false(needsLoraConfig("full"));
});

test("buildLoraConfigYaml produces the expected lora_parameters block", (t) => {
  const yaml = buildLoraConfigYaml(8, 20, 0);
  t.is(yaml, "lora_parameters:\n  rank: 8\n  scale: 20\n  dropout: 0\n");
});

test("buildLoraConfigYaml reflects overridden values", (t) => {
  const yaml = buildLoraConfigYaml(16, 32, 0.05);
  t.is(yaml, "lora_parameters:\n  rank: 16\n  scale: 32\n  dropout: 0.05\n");
});

test("buildLoraConfigYaml avoids exponent notation PyYAML would read as a string", (t) => {
  // PyYAML's 1.1 float resolver rejects `1e-7`, so String() is not enough.
  const yaml = buildLoraConfigYaml(8, 20, 1e-7);
  t.false(yaml.includes("e-"));
  t.regex(yaml, /dropout: 0\.0000001/);
});

// ── graceful stop (Ctrl+C) ────────────────────────────────────────────

function fakeSubprocess() {
  const signals: string[] = [];
  const subprocess = {
    kill(signal: string) {
      signals.push(signal);
      return true;
    },
  } as unknown as ResultPromise;
  return { subprocess, signals };
}

test("abortTraining sends SIGINT so MLX can flush its checkpoint", (t) => {
  const { subprocess, signals } = fakeSubprocess();
  abortTraining(subprocess);
  t.deepEqual(signals, ["SIGINT"]);
});

test("stopOnAbort does nothing until the signal aborts", (t) => {
  const { subprocess, signals } = fakeSubprocess();
  const controller = new AbortController();
  stopOnAbort(subprocess, controller.signal);
  t.deepEqual(signals, []);

  controller.abort();
  t.deepEqual(signals, ["SIGINT"]);
});

test("stopOnAbort stops a signal that is already aborted", (t) => {
  // An already-aborted signal never fires an `abort` event, so a bare
  // addEventListener would leave the trainer running forever.
  const { subprocess, signals } = fakeSubprocess();
  const controller = new AbortController();
  controller.abort();
  stopOnAbort(subprocess, controller.signal);
  t.deepEqual(signals, ["SIGINT"]);
});

test("stopOnAbort signals only once", (t) => {
  const { subprocess, signals } = fakeSubprocess();
  const controller = new AbortController();
  stopOnAbort(subprocess, controller.signal);
  controller.abort();
  controller.abort();
  t.deepEqual(signals, ["SIGINT"]);
});

test("stopOnAbort without a signal never touches the subprocess", (t) => {
  const { subprocess, signals } = fakeSubprocess();
  stopOnAbort(subprocess, undefined);
  t.deepEqual(signals, []);
});

test("stopOnAbort terminates a real running child process", async (t) => {
  const child = execa("node", ["-e", "setInterval(() => {}, 1000)"]);
  t.truthy(child.pid);

  const controller = new AbortController();
  stopOnAbort(child, controller.signal);
  controller.abort();

  // The child would run forever, so this only settles because it was killed.
  t.truthy(await t.throwsAsync(child));
});

test("shouldTreatAsStop returns true when signal is aborted", (t) => {
  const controller = new AbortController();
  controller.abort();
  t.true(shouldTreatAsStop(controller.signal));
});

test("shouldTreatAsStop returns false when signal is not aborted", (t) => {
  const controller = new AbortController();
  t.false(shouldTreatAsStop(controller.signal));
});

test("shouldTreatAsStop returns false when signal is undefined", (t) => {
  t.false(shouldTreatAsStop(undefined));
});
