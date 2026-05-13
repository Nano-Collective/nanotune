import test from "ava";
import type { BenchmarkTest } from "../types/index.js";
import {
  buildMessages,
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

// ── buildMessages ───────────────────────────────────────────────────

const ctx = { role: "system", content: "You are helpful." };

test("buildMessages single-turn prepends context and user message", (t) => {
  const singleTurn: BenchmarkTest = {
    id: 1,
    prompt: "list all files",
    acceptable: ["ls"],
    category: "basic",
  };
  t.deepEqual(buildMessages(singleTurn, ctx), [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "list all files" },
  ]);
});

test("buildMessages multi-turn preserves messages array verbatim", (t) => {
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
  t.deepEqual(buildMessages(multiTurn, ctx), [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "My name is Alice" },
    { role: "assistant", content: "Hello Alice!" },
    { role: "user", content: "What's my name?" },
  ]);
});

test("buildMessages omits empty context message", (t) => {
  const singleTurn: BenchmarkTest = {
    id: 1,
    prompt: "hi",
    acceptable: ["hello"],
    category: "basic",
  };
  t.deepEqual(buildMessages(singleTurn, { role: "system", content: "" }), [
    { role: "user", content: "hi" },
  ]);
});

test("buildMessages uses custom context role", (t) => {
  const singleTurn: BenchmarkTest = {
    id: 1,
    prompt: "hi",
    acceptable: ["hello"],
    category: "basic",
  };
  const devCtx = { role: "developer", content: "code rules" };
  t.deepEqual(buildMessages(singleTurn, devCtx), [
    { role: "developer", content: "code rules" },
    { role: "user", content: "hi" },
  ]);
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
