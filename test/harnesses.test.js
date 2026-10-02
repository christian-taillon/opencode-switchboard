import test from "node:test"
import assert from "node:assert/strict"
import { normalizeOptions } from "../src/config.js"
import {
  buildInvocation,
  getHarness,
  parseHarnessOutput,
} from "../src/harnesses.js"

const options = normalizeOptions()

test("Antigravity builds a resumable full invocation", () => {
  const harness = getHarness("antigravity", options)
  const invocation = buildInvocation(harness, {
    prompt: "do work",
    mode: "full",
    sessionID: "conv-123",
    model: "gemini-test",
    timeoutSeconds: 42,
  })

  assert.equal(invocation.command, "agy")
  assert.equal(invocation.mode, "full")
  assert.deepEqual(invocation.args, [
    "-p",
    "do work",
    "--output-format",
    "json",
    "--print-timeout",
    "40s",
    "--mode=accept-edits",
    "--dangerously-skip-permissions",
    "--conversation",
    "conv-123",
    "--model",
    "gemini-test",
  ])
})

test("Claude maps modes and session resume", () => {
  const harness = getHarness("claude", options)
  const invocation = buildInvocation(harness, {
    prompt: "review",
    mode: "plan",
    sessionID: "claude-session",
    timeoutSeconds: 60,
  })

  assert.deepEqual(invocation.args, [
    "-p",
    "review",
    "--output-format",
    "json",
    "--permission-mode",
    "plan",
    "--resume",
    "claude-session",
  ])
})

test("Gemini maps edit mode to auto_edit", () => {
  const harness = getHarness("gemini", options)
  const invocation = buildInvocation(harness, {
    prompt: "implement",
    mode: "edit",
    timeoutSeconds: 60,
  })
  assert.deepEqual(invocation.args, [
    "-p",
    "implement",
    "--output-format",
    "json",
    "--approval-mode",
    "auto_edit",
  ])
})

test("Codex uses full-auto for mutating execution and rejects resume", () => {
  const harness = getHarness("codex", options)
  const invocation = buildInvocation(harness, {
    prompt: "implement",
    mode: "edit",
    timeoutSeconds: 60,
  })
  assert.deepEqual(invocation.args, ["exec", "--json", "--full-auto", "implement"])

  assert.throws(
    () =>
      buildInvocation(harness, {
        prompt: "continue",
        mode: "edit",
        sessionID: "thread-123",
        timeoutSeconds: 60,
      }),
    /resume is not enabled/,
  )
})

test("parsers normalize vendor response and session fields", () => {
  const antigravity = parseHarnessOutput(
    getHarness("antigravity", options),
    JSON.stringify({
      status: "SUCCESS",
      conversation_id: "agy-1",
      response: "done",
      usage: { input: 1 },
    }),
  )
  assert.deepEqual(antigravity, {
    response: "done",
    sessionID: "agy-1",
    usage: { input: 1 },
    providerStatus: "SUCCESS",
    providerFailed: false,
    error: undefined,
  })

  const claude = parseHarnessOutput(
    getHarness("claude", options),
    JSON.stringify({ type: "result", subtype: "success", session_id: "c-1", result: "done" }),
  )
  assert.equal(claude.response, "done")
  assert.equal(claude.sessionID, "c-1")

  const gemini = parseHarnessOutput(
    getHarness("gemini", options),
    JSON.stringify({ response: "done", session_id: "g-1", stats: { total_tokens: 3 } }),
  )
  assert.equal(gemini.response, "done")
  assert.equal(gemini.sessionID, "g-1")
})

test("Codex JSONL parser captures thread, agent message, and usage", () => {
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "implemented" },
    }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } }),
  ].join("\n")

  const parsed = parseHarnessOutput(getHarness("codex", options), stdout)
  assert.equal(parsed.sessionID, "thread-1")
  assert.equal(parsed.response, "implemented")
  assert.deepEqual(parsed.usage, { input_tokens: 10, output_tokens: 3 })
})

test("Antigravity parser marks non-success terminal status as failed", () => {
  const parsed = parseHarnessOutput(
    getHarness("antigravity", options),
    JSON.stringify({ status: "WAITING", conversation_id: "agy-2", response: "permission required" }),
  )
  assert.equal(parsed.providerFailed, true)
  assert.equal(parsed.providerStatus, "WAITING")
})

test("Codex rejects unsupported model override rather than silently ignoring it", () => {
  const harness = getHarness("codex", options)
  assert.throws(
    () => buildInvocation(harness, { prompt: "work", mode: "plan", model: "gpt-test", timeoutSeconds: 60 }),
    /model override is not enabled/,
  )
})
