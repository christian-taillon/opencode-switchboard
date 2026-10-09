import test from "node:test"
import assert from "node:assert/strict"
import { normalizeOptions } from "../src/config.js"
import {
  buildInvocation,
  getHarness,
  parseHarnessOutput,
} from "../src/harnesses.js"

const options = normalizeOptions()

test("Antigravity full mode requires an approved execution profile", () => {
  assert.throws(
    () => buildInvocation(getHarness("antigravity", options), { prompt: "do work", mode: "full" }),
    /full mode requires an approved execution profile/,
  )
  const unapproved = normalizeOptions({
    executionProfiles: { vetted: { approved: false, command: "/usr/bin/env", args: [] } },
    harnesses: { antigravity: { executionProfile: "vetted" } },
  })
  assert.throws(() => getHarness("antigravity", unapproved), /execution profile is not approved: vetted/)
})

test("Antigravity builds a resumable full invocation", () => {
  const harness = getHarness("antigravity", normalizeOptions({
    executionProfiles: { vetted: { approved: true, command: "/usr/bin/env", args: [] } },
    harnesses: { antigravity: { executionProfile: "vetted" } },
  }))
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
    "--settings",
    '{"attribution":{"commit":"","pr":""}}',
    "--resume",
    "claude-session",
  ])
})

test("Claude full mode uses auto permissions, not bypass", () => {
  const harness = getHarness("claude", options)
  const invocation = buildInvocation(harness, {
    prompt: "implement",
    mode: "full",
    timeoutSeconds: 60,
  })
  const index = invocation.args.indexOf("--permission-mode")
  assert.equal(invocation.args[index + 1], "auto")
  assert.ok(!invocation.args.includes("bypassPermissions"))
})

test("Antigravity and Claude preserve native model/effort selectors on new and resumed calls", () => {
  const pairs = [
    ["antigravity", "gemini-3.8-flash-medium", "medium"],
    ["claude", "claude-sonnet-5-5", "xhigh"],
    ["claude", "claude-opus-5-5", "high"],
    ["claude", "claude-opus-5-5", "xhigh"],
  ]
  for (const [id, model, effort] of pairs) {
    for (const sessionID of [undefined, "retained-session"]) {
      const invocation = buildInvocation(getHarness(id, options), {
        prompt: "bounded task", mode: "plan", model, effort, sessionID, timeoutSeconds: 60,
      })
      assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], model)
      assert.equal(invocation.args[invocation.args.indexOf("--effort") + 1], effort)
      if (sessionID) assert.ok(invocation.args.includes(sessionID))
    }
  }
})

test("effort selections fail explicitly instead of being silently ignored", () => {
  for (const id of ["antigravity", "claude"]) {
    assert.throws(() => buildInvocation(getHarness(id, options), {
      prompt: "task", mode: "plan", effort: "unsupported", timeoutSeconds: 60,
    }), /unsupported effort/)
  }
  for (const id of ["gemini", "codex"]) {
    assert.throws(() => buildInvocation(getHarness(id, options), {
      prompt: "task", mode: "plan", effort: "high", timeoutSeconds: 60,
    }), /effort selection is not/)
  }
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

test("Codex permits non-Git workspaces, uses full-auto only for mutation, and rejects resume", () => {
  const harness = getHarness("codex", options)
  for (const mode of ["plan", "edit", "full"]) {
    const invocation = buildInvocation(harness, {
      prompt: "implement",
      mode,
      timeoutSeconds: 60,
    })
    assert.deepEqual(invocation.args, [
      "exec", "--json", "--skip-git-repo-check",
      ...(mode === "plan" ? [] : ["--full-auto"]),
      "implement",
    ])
  }

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
    deniedActions: undefined,
  })

  const claude = parseHarnessOutput(
    getHarness("claude", options),
    JSON.stringify({ type: "result", subtype: "success", session_id: "c-1", result: "done" }),
  )
  assert.equal(claude.response, "done")
  assert.equal(claude.sessionID, "c-1")
  assert.equal(claude.providerFailed, false)
  assert.equal(claude.protocolError, undefined)

  const gemini = parseHarnessOutput(
    getHarness("gemini", options),
    JSON.stringify({ response: "done", session_id: "g-1", stats: { total_tokens: 3 } }),
  )
  assert.equal(gemini.response, "done")
  assert.equal(gemini.sessionID, "g-1")
  assert.equal(gemini.providerFailed, false)
  assert.equal(gemini.protocolError, undefined)
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
  assert.equal(parsed.providerStatus, "turn.completed")
  assert.equal(parsed.providerFailed, false)
  assert.equal(parsed.protocolError, undefined)
})

test("Claude and Gemini reject malformed, non-terminal, and blank success output", () => {
  for (const [id, cases] of [
    ["claude", [
      { type: "system", subtype: "init", session_id: "c" },
      { type: "assistant", message: "partial" },
      { result: "done" },
      { type: "result", subtype: "success" },
      { type: "result", subtype: "success", result: " \n" },
      { type: "result", subtype: "success", result: 123 },
    ]],
    ["gemini", [
      { session_id: "g", stats: {} },
      { type: "init", message: "partial" },
      { result: "done" },
      { response: " \n" },
      { response: 123 },
    ]],
  ]) {
    for (const stdout of ["", "not JSON", "[]", "null", "123", ...cases.map((value) => JSON.stringify(value))]) {
      const parsed = parseHarnessOutput(getHarness(id, options), stdout)
      assert.ok(parsed.protocolError, `${id}: ${stdout}`)
      assert.equal(parsed.rawOutput, stdout)
    }
  }
})

test("Claude and Gemini preserve terminal failures without requiring a response", () => {
  const claude = parseHarnessOutput(getHarness("claude", options), JSON.stringify({
    type: "result", subtype: "error_max_turns", is_error: true,
    session_id: "c", errors: ["turn limit reached"],
  }))
  assert.equal(claude.providerFailed, true)
  assert.equal(claude.providerStatus, "error_max_turns")
  assert.equal(claude.sessionID, "c")
  assert.equal(claude.error, "turn limit reached")
  assert.equal(claude.protocolError, undefined)

  const gemini = parseHarnessOutput(getHarness("gemini", options), JSON.stringify({
    session_id: "g", error: { type: "AuthenticationError", message: "not authenticated" },
  }))
  assert.equal(gemini.providerFailed, true)
  assert.equal(gemini.sessionID, "g")
  assert.equal(gemini.error, "not authenticated")
  assert.equal(gemini.protocolError, undefined)
})

test("Codex requires valid events, terminal completion, and a completed agent message", () => {
  const started = { type: "thread.started", thread_id: "t" }
  const message = { type: "item.completed", item: { type: "agent_message", text: "done" } }
  const completed = { type: "turn.completed" }
  for (const events of [
    [], ["not JSON"], ["[]"], ["{}"], [started], [started, message],
    [started, completed],
    [{ type: "item.started", item: message.item }, completed],
    [message, completed, "malformed tail"],
    [message, completed, { type: "turn.started" }],
    [message, completed, started],
    [message, completed, { type: "item.started", item: message.item }],
    [{ ...message, item: { type: "agent_message", text: " \n" } }, completed],
  ]) {
    const stdout = events.map((event) => typeof event === "string" ? event : JSON.stringify(event)).join("\n")
    const parsed = parseHarnessOutput(getHarness("codex", options), stdout)
    assert.ok(parsed.protocolError, stdout)
    assert.equal(parsed.rawOutput, stdout)
  }
})

test("Codex error events and failed turns fail even without an error message", () => {
  for (const event of [
    { type: "turn.failed" },
    { type: "turn.failed", error: { message: "turn failed" } },
    { type: "error", message: "stream failed" },
    { type: "error" },
  ]) {
    const parsed = parseHarnessOutput(getHarness("codex", options), JSON.stringify(event))
    assert.equal(parsed.providerFailed, true)
    assert.equal(parsed.error, event.error?.message ?? event.message)
    assert.equal(parsed.protocolError, undefined)
  }
})

test("Antigravity parser marks non-success terminal status as failed", () => {
  const parsed = parseHarnessOutput(
    getHarness("antigravity", options),
    JSON.stringify({ status: "WAITING", conversation_id: "agy-2", response: "permission required" }),
  )
  assert.equal(parsed.providerFailed, true)
  assert.equal(parsed.providerStatus, "WAITING")
})

test("Antigravity retains headless permission denials despite SUCCESS and exit-zero output", () => {
  const deniedActions = [{ action: "read_url", display_name: "ReadUrlContent" }]
  const stdout = JSON.stringify({
    conversation_id: "agy-denied",
    status: "SUCCESS",
    response: "",
    denied_actions: deniedActions,
    usage: { input_tokens: 12605, output_tokens: 1503 },
  })
  const parsed = parseHarnessOutput(getHarness("antigravity", options), stdout)
  assert.equal(parsed.providerFailed, true)
  assert.equal(parsed.providerStatus, "SUCCESS")
  assert.equal(parsed.sessionID, "agy-denied")
  assert.deepEqual(parsed.deniedActions, deniedActions)
  assert.match(parsed.error, /read_url.*scoped permissions.allow/)
  assert.match(parsed.protocolError, /nonempty response/)
  assert.equal(parsed.rawOutput, stdout)

  const withResponse = parseHarnessOutput(getHarness("antigravity", options), JSON.stringify({
    status: "SUCCESS", response: "Unable to fetch the URL", denied_actions: deniedActions,
  }))
  assert.equal(withResponse.providerFailed, true)
  assert.equal(withResponse.protocolError, undefined)
})

test("Antigravity requires valid JSON, terminal status, and a nonblank success response", () => {
  const harness = getHarness("antigravity", options)
  for (const stdout of ["", "not JSON", "[]", '{"response":"done"}',
    '{"status":"SUCCESS"}', '{"status":"SUCCESS","response":"  \\n"}',
    '{"status":"SUCCESS","response":123}', '{"status":"SUCCESS","message":"done"}']) {
    const parsed = parseHarnessOutput(harness, stdout)
    assert.ok(parsed.protocolError, stdout)
    assert.equal(parsed.rawOutput, stdout)
  }
  const failed = parseHarnessOutput(harness, '{"status":"ERROR","response":"","error":"unauthenticated"}')
  assert.equal(failed.providerFailed, true)
  assert.equal(failed.error, "unauthenticated")
  assert.equal(failed.protocolError, undefined)
})

test("truncated stdout cannot establish a terminal result even when retained JSON parses", () => {
  const parsed = parseHarnessOutput(getHarness("antigravity", options),
    '{"status":"SUCCESS","response":"done"}', { truncated: true })
  assert.equal(parsed.response, "done")
  assert.match(parsed.protocolError, /stdout was truncated/)
})

test("Codex rejects unsupported model override rather than silently ignoring it", () => {
  const harness = getHarness("codex", options)
  assert.throws(
    () => buildInvocation(harness, { prompt: "work", mode: "plan", model: "gpt-test", timeoutSeconds: 60 }),
    /model override is not enabled/,
  )
})
