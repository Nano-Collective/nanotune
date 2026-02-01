import { execa, type ResultPromise } from "execa";
import type { DependencyStatus, TrainingProgress } from "../types/index.js";

export interface MLXTrainingOptions {
  model: string;
  dataPath: string;
  adapterPath: string;
  iterations: number;
  learningRate: number;
  batchSize: number;
  numLayers: number;
  stepsPerEval: number;
  saveEvery: number;
  resume?: boolean;
}

export async function checkPython(): Promise<{
  installed: boolean;
  version?: string;
}> {
  try {
    const result = await execa("python3", ["--version"]);
    const versionMatch = result.stdout.match(/Python (\d+\.\d+\.\d+)/);
    return {
      installed: true,
      version: versionMatch?.[1],
    };
  } catch {
    return { installed: false };
  }
}

export async function checkMLXInstalled(): Promise<boolean> {
  try {
    await execa("python3", ["-c", "import mlx_lm"]);
    return true;
  } catch {
    return false;
  }
}

export async function installMLX(): Promise<void> {
  await execa("pip3", ["install", "mlx-lm"], { stdio: "inherit" });
}

export async function checkDependencies(): Promise<DependencyStatus> {
  const python = await checkPython();
  const mlx = python.installed ? await checkMLXInstalled() : false;

  return {
    python: python.installed,
    pythonVersion: python.version,
    mlx,
    llamaCpp: false, // Will be checked separately
  };
}

export async function* runTraining(
  options: MLXTrainingOptions,
): AsyncGenerator<TrainingProgress> {
  const args = [
    "-m",
    "mlx_lm",
    "lora",
    "--model",
    options.model,
    "--train",
    "--data",
    options.dataPath,
    "--adapter-path",
    options.adapterPath,
    "--iters",
    String(options.iterations),
    "--learning-rate",
    String(options.learningRate),
    "--batch-size",
    String(options.batchSize),
    "--num-layers",
    String(options.numLayers),
    "--steps-per-eval",
    String(options.stepsPerEval),
    "--save-every",
    String(options.saveEvery),
  ];

  if (options.resume) {
    args.push(
      "--resume-adapter-file",
      `${options.adapterPath}/adapters.safetensors`,
    );
  }

  const subprocess = execa("python3", args, {
    stdout: "pipe",
    stderr: "pipe",
    buffer: false,
  });

  const stdout = subprocess.stdout;
  const stderr = subprocess.stderr;
  if (!stdout) {
    throw new Error("Failed to get stdout from training process");
  }

  // Collect stderr for error reporting
  let stderrOutput = "";
  if (stderr) {
    stderr.on("data", (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });
  }

  let buffer = "";

  for await (const chunk of stdout) {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      // Parse: "Iter 10: Train loss 1.234, Val loss 1.456"
      // or: "Iter 10 (15.2 it/s): Train loss 1.234"
      const match = line.match(
        /Iter\s+(\d+)(?:\s*\([^)]+\))?:\s*Train loss\s+([\d.]+)(?:,\s*Val loss\s+([\d.]+))?/i,
      );
      if (match) {
        yield {
          iteration: Number.parseInt(match[1], 10),
          totalIterations: options.iterations,
          trainLoss: Number.parseFloat(match[2]),
          valLoss: match[3] ? Number.parseFloat(match[3]) : undefined,
        };
      }
    }
  }

  try {
    await subprocess;
  } catch (err) {
    // Include stderr in the error message for better debugging
    const errorMessage =
      err instanceof Error ? err.message : "Training failed";
    const stderrTrimmed = stderrOutput.trim();
    if (stderrTrimmed) {
      // Extract the most relevant part of the error (last few lines usually have the actual error)
      const stderrLines = stderrTrimmed.split("\n");
      const relevantLines = stderrLines.slice(-10).join("\n");
      throw new Error(`${errorMessage}\n\nDetails:\n${relevantLines}`);
    }
    throw err;
  }
}

export async function fuseAdapters(
  model: string,
  adapterPath: string,
  outputPath: string,
): Promise<void> {
  await execa("python3", [
    "-m",
    "mlx_lm.fuse",
    "--model",
    model,
    "--adapter-path",
    adapterPath,
    "--save-path",
    outputPath,
  ]);
}

export async function runInference(
  model: string,
  prompt: string,
  maxTokens = 100,
): Promise<string> {
  const result = await execa("python3", [
    "-m",
    "mlx_lm.generate",
    "--model",
    model,
    "--prompt",
    prompt,
    "--max-tokens",
    String(maxTokens),
  ]);

  return result.stdout;
}

export function abortTraining(subprocess: ResultPromise): void {
  subprocess.kill("SIGINT");
}
