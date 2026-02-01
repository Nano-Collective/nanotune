import { Spinner, StatusMessage } from "@inkjs/ui";
import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import { Header, LossChart, Progress } from "../components/index.js";
import {
  configExists,
  getAdaptersDir,
  getDataDir,
  loadConfig,
} from "../lib/config.js";
import { countExamples, ensureValidationSet } from "../lib/data.js";
import {
  checkMLXInstalled,
  installMLX,
  type MLXTrainingOptions,
  runTraining,
} from "../lib/mlx.js";
import type { TrainingProgress } from "../types/index.js";

interface Props {
  options: {
    iterations?: string;
    lr?: string;
    resume?: boolean;
    dryRun?: boolean;
  };
}

type Status =
  | "checking"
  | "installing"
  | "validating"
  | "training"
  | "done"
  | "error";

export function TrainCommand({ options }: Props) {
  const { exit } = useApp();
  const [status, setStatus] = useState<Status>("checking");
  const [progress, setProgress] = useState<TrainingProgress | null>(null);
  const [lossHistory, setLossHistory] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [eta, setEta] = useState<string | null>(null);
  const [startTime, setStartTime] = useState<number | null>(null);

  useInput((input, key) => {
    if (key.escape && status !== "training") {
      exit();
    }
    if ((status === "done" || status === "error") && (key.return || input)) {
      exit();
    }
  });

  useEffect(() => {
    run();
  }, []);

  const run = async () => {
    try {
      // Check project exists
      if (!configExists()) {
        setError("Not a Nanotune project. Run `nanotune init` first.");
        setStatus("error");
        return;
      }

      // Check MLX
      setStatus("checking");
      const hasMLX = await checkMLXInstalled();
      if (!hasMLX) {
        setStatus("installing");
        await installMLX();
      }

      // Validate data
      setStatus("validating");
      const exampleCount = countExamples();
      if (exampleCount === 0) {
        setError(
          "No training data found. Run `nanotune data add` to add examples.",
        );
        setStatus("error");
        return;
      }

      // Ensure we have a validation set (MLX requires it)
      ensureValidationSet();

      // Load config
      const config = loadConfig();

      // Override with CLI options
      const iterations = options.iterations
        ? Number.parseInt(options.iterations, 10)
        : config.training.iterations;
      const learningRate = options.lr
        ? Number.parseFloat(options.lr)
        : config.training.learningRate;

      // Dry run check
      if (options.dryRun) {
        setStatus("done");
        return;
      }

      // Start training
      setStatus("training");
      setStartTime(Date.now());

      const trainingOptions: MLXTrainingOptions = {
        model: config.baseModel,
        dataPath: getDataDir(),
        adapterPath: getAdaptersDir(),
        iterations,
        learningRate,
        batchSize: config.training.batchSize,
        numLayers: config.training.numLayers,
        stepsPerEval: config.training.stepsPerEval,
        saveEvery: config.training.saveEvery,
        resume: options.resume,
      };

      for await (const update of runTraining(trainingOptions)) {
        setProgress(update);
        setLossHistory((prev) => [...prev, update.trainLoss]);

        // Calculate ETA
        if (startTime) {
          const elapsed = Date.now() - startTime;
          const iterationsComplete = update.iteration;
          const iterationsRemaining =
            update.totalIterations - iterationsComplete;
          if (iterationsComplete > 0) {
            const msPerIteration = elapsed / iterationsComplete;
            const msRemaining = msPerIteration * iterationsRemaining;
            const secondsRemaining = Math.round(msRemaining / 1000);
            const minutes = Math.floor(secondsRemaining / 60);
            const seconds = secondsRemaining % 60;
            setEta(`${minutes}m ${seconds}s`);
          }
        }
      }

      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Training failed");
      setStatus("error");
    }
  };

  if (!configExists()) {
    return (
      <Box flexDirection="column" padding={1}>
        <Header title="Training" />
        <StatusMessage variant="error">
          Not a Nanotune project. Run `nanotune init` first.
        </StatusMessage>
      </Box>
    );
  }

  const config = loadConfig();
  const exampleCount = countExamples();

  return (
    <Box flexDirection="column" padding={1}>
      <Header title="Training" />

      <Box flexDirection="column" marginBottom={1}>
        <Text>
          Model: <Text color="cyan">{config.baseModel}</Text>
        </Text>
        <Text>
          Examples: <Text color="cyan">{exampleCount}</Text>
        </Text>
        <Text>
          Iterations:{" "}
          <Text color="cyan">
            {options.iterations || config.training.iterations}
          </Text>
        </Text>
      </Box>

      {status === "checking" && <Spinner label="Checking dependencies..." />}

      {status === "installing" && (
        <Spinner label="Installing MLX (this may take a moment)..." />
      )}

      {status === "validating" && (
        <Spinner label="Validating training data..." />
      )}

      {status === "training" && progress && (
        <Box flexDirection="column">
          <Progress
            percent={(progress.iteration / progress.totalIterations) * 100}
            label="Progress"
          />

          <Text>
            Iteration: {progress.iteration}/{progress.totalIterations}
          </Text>

          <Box marginY={1}>
            <LossChart
              data={lossHistory}
              width={40}
              height={6}
              label="Training Loss"
            />
          </Box>

          <Box>
            <Text>
              Train Loss:{" "}
              <Text color="green">{progress.trainLoss.toFixed(4)}</Text>
            </Text>
            {progress.valLoss && (
              <Text>
                {" | "}Val Loss:{" "}
                <Text color="green">{progress.valLoss.toFixed(4)}</Text>
              </Text>
            )}
            {eta && (
              <Text>
                {" | "}ETA: <Text color="yellow">{eta}</Text>
              </Text>
            )}
          </Box>

          <Text> </Text>
          <Text dimColor>[Ctrl+C] Stop training (checkpoint saved)</Text>
        </Box>
      )}

      {status === "done" && (
        <Box flexDirection="column">
          <StatusMessage variant="success">Training complete!</StatusMessage>
          <Text> </Text>
          {progress && (
            <Text>
              Final loss:{" "}
              <Text color="green">{progress.trainLoss.toFixed(4)}</Text>
            </Text>
          )}
          <Text> </Text>
          <Text>
            Next: <Text color="cyan">nanotune export</Text>
          </Text>
          <Text> </Text>
          <Text dimColor>Press any key to exit</Text>
        </Box>
      )}

      {status === "error" && (
        <Box flexDirection="column">
          <StatusMessage variant="error">{error}</StatusMessage>
          <Text> </Text>
          <Text dimColor>Press Esc to exit</Text>
        </Box>
      )}
    </Box>
  );
}
