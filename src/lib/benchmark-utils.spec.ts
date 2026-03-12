import test from "ava";
import type { BenchmarkTest } from "../types/index.js";
import {
  buildFullPrompt,
  formatConversationForJudge,
  getTestDisplayPrompt,
} from "./benchmark-utils.js";

// ── getTestDisplayPrompt ────────────────────────────────────────────

test("getTestDisplayPrompt returns prompt for single-turn test", (t) => {
  const singleTurn: BenchmarkTest = {
    id: 1,
    prompt: "list all files",
    acceptable: ["ls"],
    category: "basic",
  };
  t.is(getTestDisplayPrompt(singleTurn), "list all files");
});

test("getTestDisplayPrompt returns last user message for multi-turn test", (t) => {
  const multiTurn: BenchmarkTest = {
    id: 2,
    messages: [
      { role: "user", content: "My name is Alice" },
      { role: "assistant", content: "Hello Alice!" },
      { role: "user", content: "What's my name?" },
    ],
    acceptable: ["Alice"],
    category: "memory",
  };
  t.is(getTestDisplayPrompt(multiTurn), "What's my name?");
});

test("getTestDisplayPrompt returns empty string for test with neither", (t) => {
  const empty: BenchmarkTest = { id: 3, category: "other" };
  t.is(getTestDisplayPrompt(empty), "");
});

// ── buildFullPrompt ─────────────────────────────────────────────────

const ctx = { role: "system", content: "You are helpful." };

test("buildFullPrompt single-turn matches existing format", (t) => {
  const singleTurn: BenchmarkTest = {
    id: 1,
    prompt: "list all files",
    acceptable: ["ls"],
    category: "basic",
  };
  const result = buildFullPrompt(singleTurn, ctx);
  t.is(result, "You are helpful.\n\nUser: list all files\n\nAssistant:");
});

test("buildFullPrompt multi-turn formats conversation with trailing Assistant:", (t) => {
  const multiTurn: BenchmarkTest = {
    id: 2,
    messages: [
      { role: "user", content: "My name is Alice" },
      { role: "assistant", content: "Hello Alice!" },
      { role: "user", content: "What's my name?" },
    ],
    acceptable: ["Alice"],
    category: "memory",
  };
  const result = buildFullPrompt(multiTurn, ctx);
  t.is(
    result,
    "You are helpful.\n\nUser: My name is Alice\n\nAssistant: Hello Alice!\n\nUser: What's my name?\n\nAssistant:",
  );
});

test("buildFullPrompt multi-turn without trailing user does not add extra Assistant:", (t) => {
  const multiTurn: BenchmarkTest = {
    id: 3,
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ],
    acceptable: ["Hi"],
    category: "test",
  };
  const result = buildFullPrompt(multiTurn, ctx);
  t.is(
    result,
    "You are helpful.\n\nUser: Hello\n\nAssistant: Hi there!",
  );
});

// ── formatConversationForJudge ──────────────────────────────────────

test("formatConversationForJudge includes context and labeled turns", (t) => {
  const messages = [
    { role: "user", content: "My name is Alice" },
    { role: "assistant", content: "Hello Alice!" },
    { role: "user", content: "What's my name?" },
  ];
  const result = formatConversationForJudge(messages, ctx);
  t.is(
    result,
    "[Context (system)]: You are helpful.\n[User]: My name is Alice\n[Assistant]: Hello Alice!\n[User]: What's my name?",
  );
});

test("formatConversationForJudge omits context line when content is empty", (t) => {
  const messages = [{ role: "user", content: "Hello" }];
  const result = formatConversationForJudge(messages, {
    role: "system",
    content: "",
  });
  t.is(result, "[User]: Hello");
});
