import { StatusMessage, TextInput } from "@inkjs/ui";
import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";
import { Header } from "../components/index.js";
import {
  configExists,
  createDefaultConfig,
  initializeProjectDirs,
  saveConfig,
} from "../lib/config.js";

type Step = "name" | "model" | "prompt" | "confirm" | "done" | "error";

export function InitCommand() {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>(() => {
    if (configExists()) {
      return "error";
    }
    return "name";
  });
  const [name, setName] = useState(process.cwd().split("/").pop() || "project");
  const [model, setModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [errorMessage, setErrorMessage] = useState(
    "A Nanotune project already exists in this directory.",
  );

  useInput((_input, key) => {
    if (key.escape) {
      exit();
    }
  });

  const handleNameSubmit = (value: string) => {
    if (value.trim()) {
      setName(value.trim());
      setStep("model");
    }
  };

  const handleModelSubmit = (value: string) => {
    if (value.trim()) {
      setModel(value.trim());
      setStep("prompt");
    }
  };

  const handlePromptSubmit = (value: string) => {
    if (value.trim()) {
      setSystemPrompt(value.trim());
      setStep("confirm");
    }
  };

  useInput((input) => {
    if (step === "confirm") {
      if (input.toLowerCase() === "y") {
        try {
          initializeProjectDirs();
          const config = createDefaultConfig(name, model, systemPrompt);
          saveConfig(config);
          setStep("done");
          setTimeout(() => exit(), 100);
        } catch (err) {
          setErrorMessage(err instanceof Error ? err.message : "Unknown error");
          setStep("error");
        }
      } else if (input.toLowerCase() === "n") {
        exit();
      }
    }
  });

  if (step === "error") {
    return (
      <Box flexDirection="column" padding={1}>
        <Header title="Initialize Project" />
        <StatusMessage variant="error">{errorMessage}</StatusMessage>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Header title="Initialize Project" />

      {step === "name" && (
        <Box flexDirection="column">
          <Text>Project name:</Text>
          <TextInput
            defaultValue={name}
            onSubmit={handleNameSubmit}
            placeholder="Enter project name..."
          />
        </Box>
      )}

      {step === "model" && (
        <Box flexDirection="column">
          <Text>
            Base model <Text dimColor>(HuggingFace ID)</Text>:
          </Text>
          <TextInput
            onSubmit={handleModelSubmit}
            placeholder="Enter a model ID..."
          />
          <Box marginTop={1}>
            <Text dimColor italic>
              Examples: Qwen/Qwen2.5-Coder-1.5B-Instruct,
              meta-llama/Llama-3.2-1B-Instruct
            </Text>
          </Box>
        </Box>
      )}

      {step === "prompt" && (
        <Box flexDirection="column">
          <Text>System prompt:</Text>
          <TextInput
            onSubmit={handlePromptSubmit}
            placeholder="You are a helpful assistant..."
          />
          <Box marginTop={1}>
            <Text dimColor italic>
              This prompt will be used for all training examples
            </Text>
          </Box>
        </Box>
      )}

      {step === "confirm" && (
        <Box flexDirection="column">
          <Text bold>Configuration Summary:</Text>
          <Text> </Text>
          <Text>
            Name: <Text color="cyan">{name}</Text>
          </Text>
          <Text>
            Model: <Text color="cyan">{model}</Text>
          </Text>
          <Text>
            System Prompt:{" "}
            <Text color="cyan">{systemPrompt.slice(0, 50)}...</Text>
          </Text>
          <Text> </Text>
          <Text>
            Create project? <Text color="green">(y/n)</Text>
          </Text>
        </Box>
      )}

      {step === "done" && (
        <Box flexDirection="column">
          <StatusMessage variant="success">Project initialized!</StatusMessage>
          <Text> </Text>
          <Text bold>Next steps:</Text>
          <Text>
            {" "}
            1. Add training data: <Text color="cyan">nanotune data add</Text>
          </Text>
          <Text>
            {" "}
            2. Train the model: <Text color="cyan">nanotune train</Text>
          </Text>
          <Text>
            {" "}
            3. Export to GGUF: <Text color="cyan">nanotune export</Text>
          </Text>
        </Box>
      )}

      <Text> </Text>
      <Text dimColor>[Esc] Cancel</Text>
    </Box>
  );
}
