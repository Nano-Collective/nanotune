import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { chmod, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { execa } from "execa";
import type { QuantizationType } from "../types/index.js";

const LLAMA_CPP_DIR = join(homedir(), ".nanotune", "llama.cpp");
const LLAMA_CPP_BIN_DIR = join(LLAMA_CPP_DIR, "bin");

// We'll fetch the latest release dynamically
const GITHUB_API_LATEST =
  "https://api.github.com/repos/ggerganov/llama.cpp/releases/latest";

export function getLlamaCppPath(): string {
  return LLAMA_CPP_DIR;
}

export function getLlamaCppBinDir(): string {
  return LLAMA_CPP_BIN_DIR;
}

export async function checkLlamaCppInstalled(): Promise<boolean> {
  const quantizePath = join(LLAMA_CPP_BIN_DIR, "llama-quantize");
  const convertScript = join(LLAMA_CPP_DIR, "convert_hf_to_gguf.py");
  const ggufPyDir = join(LLAMA_CPP_DIR, "gguf-py");
  // Need all three: binary, convert script, and gguf-py
  return (
    existsSync(quantizePath) && existsSync(convertScript) && existsSync(ggufPyDir)
  );
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

async function getLatestRelease(): Promise<{
  tag: string;
  downloadUrl: string;
}> {
  const response = await fetch(GITHUB_API_LATEST, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch release info: ${response.statusText}`);
  }

  const release = (await response.json()) as GitHubRelease;

  // Find the macOS arm64 binary (Apple Silicon)
  const asset = release.assets.find(
    (a) => a.name.includes("macos-arm64") && a.name.endsWith(".tar.gz"),
  );

  if (!asset) {
    throw new Error("Could not find macOS arm64 binary in latest release");
  }

  return {
    tag: release.tag_name,
    downloadUrl: asset.browser_download_url,
  };
}

async function downloadAndExtract(url: string, destDir: string): Promise<void> {
  const tarPath = join(destDir, "llama.tar.gz");

  // Download
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download: ${response.statusText}`);
  }

  // Save to file
  const fileStream = createWriteStream(tarPath);
  await pipeline(response.body as unknown as NodeJS.ReadableStream, fileStream);

  // Extract
  await execa("tar", ["-xzf", tarPath, "-C", destDir, "--strip-components=1"]);

  // Clean up tarball
  await rm(tarPath);

  // Make binaries executable
  const binaries = ["llama-quantize", "llama-cli", "llama-gguf-split"];
  for (const bin of binaries) {
    const binPath = join(destDir, bin);
    if (existsSync(binPath)) {
      await chmod(binPath, 0o755);
    }
  }
}

async function downloadConvertScript(tag: string): Promise<void> {
  const scriptPath = join(LLAMA_CPP_DIR, "convert_hf_to_gguf.py");
  const ggufPyDir = join(LLAMA_CPP_DIR, "gguf-py");

  // Clean up old versions first
  if (existsSync(scriptPath)) {
    await rm(scriptPath);
  }
  if (existsSync(ggufPyDir)) {
    await rm(ggufPyDir, { recursive: true });
  }

  // Download the convert script matching the release version
  const scriptUrl = `https://raw.githubusercontent.com/ggerganov/llama.cpp/${tag}/convert_hf_to_gguf.py`;

  const response = await fetch(scriptUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download convert script: ${response.statusText}`);
  }

  const fileStream = createWriteStream(scriptPath);
  await pipeline(response.body as unknown as NodeJS.ReadableStream, fileStream);
  await chmod(scriptPath, 0o755);

  // Download the bundled gguf-py package (the script uses this instead of pip gguf)
  mkdirSync(ggufPyDir, { recursive: true });

  // Download gguf-py as a tarball from the release
  const ggufTarUrl = `https://github.com/ggerganov/llama.cpp/archive/${tag}.tar.gz`;
  const ggufTarPath = join(LLAMA_CPP_DIR, "repo.tar.gz");

  const ggufResponse = await fetch(ggufTarUrl);
  if (!ggufResponse.ok || !ggufResponse.body) {
    throw new Error(`Failed to download gguf-py: ${ggufResponse.statusText}`);
  }

  const ggufFileStream = createWriteStream(ggufTarPath);
  await pipeline(
    ggufResponse.body as unknown as NodeJS.ReadableStream,
    ggufFileStream,
  );

  // Extract just the gguf-py directory
  await execa("tar", [
    "-xzf",
    ggufTarPath,
    "-C",
    LLAMA_CPP_DIR,
    "--strip-components=1",
    `llama.cpp-${tag}/gguf-py`,
  ]);

  // Clean up tarball
  await rm(ggufTarPath);
}

export async function* installLlamaCpp(): AsyncGenerator<string> {
  // Create directories
  if (!existsSync(LLAMA_CPP_DIR)) {
    mkdirSync(LLAMA_CPP_DIR, { recursive: true });
  }
  if (!existsSync(LLAMA_CPP_BIN_DIR)) {
    mkdirSync(LLAMA_CPP_BIN_DIR, { recursive: true });
  }

  yield "Fetching latest llama.cpp release...";

  const { tag, downloadUrl } = await getLatestRelease();

  yield `Downloading llama.cpp ${tag} (pre-built binary)...`;

  await downloadAndExtract(downloadUrl, LLAMA_CPP_BIN_DIR);

  yield "Downloading convert script...";

  await downloadConvertScript(tag);

  yield "llama.cpp installation complete!";
}

export interface ConvertProgress {
  step: string;
  progress?: number;
}

export async function* convertToGGUF(
  inputPath: string,
  outputPath: string,
): AsyncGenerator<ConvertProgress> {
  const convertScript = join(LLAMA_CPP_DIR, "convert_hf_to_gguf.py");

  yield { step: "Converting to GGUF format..." };

  try {
    await execa("python3", [
      convertScript,
      inputPath,
      "--outfile",
      outputPath,
      "--outtype",
      "f16",
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // Check for common issues
    if (message.includes("gguf")) {
      throw new Error(
        `Conversion failed. You may need to install gguf: pip3 install gguf\n\n${message}`,
      );
    }
    throw err;
  }

  yield { step: "Conversion complete!", progress: 100 };
}

export async function* quantize(
  inputPath: string,
  outputPath: string,
  quantType: QuantizationType,
): AsyncGenerator<ConvertProgress> {
  const quantizeBin = join(LLAMA_CPP_BIN_DIR, "llama-quantize");

  yield { step: `Quantizing to ${quantType}...` };

  await execa(quantizeBin, [inputPath, outputPath, quantType]);

  yield { step: "Quantization complete!", progress: 100 };
}

export async function* exportModel(
  fusedModelPath: string,
  outputPath: string,
  quantization: QuantizationType,
): AsyncGenerator<ConvertProgress> {
  // Step 1: Convert to GGUF (f16)
  const f16Path = outputPath.replace(/\.gguf$/, "-f16.gguf");

  yield { step: "Step 1/2: Converting to GGUF...", progress: 0 };

  for await (const progress of convertToGGUF(fusedModelPath, f16Path)) {
    yield { step: progress.step, progress: 25 };
  }

  // Step 2: Quantize if needed
  if (quantization === "f16") {
    // Already done, just rename
    const { rename } = await import("node:fs/promises");
    await rename(f16Path, outputPath);
    yield { step: "Export complete!", progress: 100 };
    return;
  }

  yield { step: `Step 2/2: Quantizing to ${quantization}...`, progress: 50 };

  for await (const progress of quantize(f16Path, outputPath, quantization)) {
    yield { step: progress.step, progress: 100 };
  }

  // Clean up f16 intermediate file
  const { unlink } = await import("node:fs/promises");
  try {
    await unlink(f16Path);
  } catch {
    // Ignore cleanup errors
  }

  yield { step: "Export complete!", progress: 100 };
}

export async function runGGUFInference(
  modelPath: string,
  prompt: string,
  maxTokens = 100,
): Promise<string> {
  // Use llama-completion for non-interactive single-shot inference
  const completionBin = join(LLAMA_CPP_BIN_DIR, "llama-completion");

  const result = await execa(completionBin, [
    "-m",
    modelPath,
    "-p",
    prompt,
    "-n",
    String(maxTokens),
    "--no-display-prompt",
  ], {
    input: "",  // Close stdin immediately
    stderr: "ignore",  // Suppress Metal/GPU logs
  });

  // Clean up output - remove "EOF by user" and extra prompts
  let output = result.stdout.trim();
  output = output.replace(/\n?>\s*\n?EOF by user\s*$/i, "").trim();
  output = output.replace(/\n?>\s*$/i, "").trim();

  return output;
}
