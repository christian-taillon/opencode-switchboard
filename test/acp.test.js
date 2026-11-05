import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { runAntigravityAcp } from "../src/acp.js"

const fixture = fileURLToPath(new URL("../fixtures/acp-server.mjs", import.meta.url))
function input(overrides = {}) {
  return {
    command: process.execPath, args: [fixture], cwd: os.tmpdir(), env: process.env,
    prompt: "test", mode: "edit", timeoutMs: 3000, maxOutputBytes: 16384, ...overrides,
  }
}

test("ACP handshake, terminal response and session resume", async () => {
  const first = await runAntigravityAcp(input())
  assert.equal(first.status, "completed")
  assert.equal(first.sessionID, "mock-conversation")
  assert.equal(first.response, "completed")
  assert.equal(first.exitCode, null)
  assert.equal(first.signal, "SIGTERM")
  const resumed = await runAntigravityAcp(input({
    sessionID: first.sessionID, model: "test-model", effort: "medium",
  }))
  assert.equal(resumed.status, "completed")
  assert.equal(resumed.sessionID, first.sessionID)
})

test("ACP selects the native accept-edits mode", async () => {
  const result = await runAntigravityAcp(input({ args: [fixture, "native"] }))
  assert.equal(result.status, "completed")
  assert.equal(result.response, "completed")
})

test("ACP retains the legacy session mode API", async () => {
  const result = await runAntigravityAcp(input({ args: [fixture, "legacy-modes"] }))
  assert.equal(result.status, "completed")
})

test("ACP refuses unsupported or unconfirmed edit modes", async () => {
  const unsupported = await runAntigravityAcp(input({ args: [fixture, "unsupported-mode"] }))
  assert.equal(unsupported.status, "failed")
  assert.match(unsupported.error, /does not advertise a supported edit mode/)
  const unconfirmed = await runAntigravityAcp(input({ args: [fixture, "unacknowledged-mode"] }))
  assert.equal(unconfirmed.status, "failed")
  assert.match(unconfirmed.error, /did not confirm the requested edit mode/)
})

test("ACP returns authentication-required failures without prompting or retrying", async () => {
  const result = await runAntigravityAcp(input({ args: [fixture, "auth-required"] }))
  assert.equal(result.status, "failed")
  assert.equal(result.error, "ACP -32000: Authentication required")
  assert.equal(result.sessionID, undefined)
  assert.equal(result.protocolError, undefined)
})

test("ACP preserves malformed-stdout errors instead of masking them with process exit", async () => {
  const result = await runAntigravityAcp(input({ args: [fixture, "bad-stdout"] }))
  assert.equal(result.status, "failed")
  assert.ok(result.protocolError)
  assert.equal(result.error, result.protocolError)
  assert.equal(result.sessionID, undefined)
  assert.equal(result.signal, "SIGTERM")
})

test("ACP does not send another request after malformed stdout follows initialization", async () => {
  const result = await runAntigravityAcp(input({ args: [fixture, "bad-after-init"] }))
  assert.equal(result.status, "failed")
  assert.equal(result.error, result.protocolError)
  assert.equal(result.sessionID, undefined)
  assert.equal(result.stderr, "")
})

test("ACP does not approve an asynchronous edit permission after protocol failure", async () => {
  const result = await runAntigravityAcp(input({ args: [fixture, "permission-after-stop"] }))
  assert.equal(result.status, "failed")
  assert.ok(result.protocolError)
  assert.equal(result.error, result.protocolError)
  assert.equal(result.stderr, "")
})

test("ACP retains an unsuccessful process exit code", async () => {
  const result = await runAntigravityAcp(input({ args: [fixture, "exit-before-init"] }))
  assert.equal(result.status, "failed")
  assert.equal(result.error, "Antigravity ACP process exited")
  assert.equal(result.exitCode, 23)
  assert.equal(result.signal, null)
})

test("ACP reports diagnostic truncation without truncating the successful response", async () => {
  const result = await runAntigravityAcp(input({ args: [fixture, "large-stderr"] }))
  assert.equal(result.status, "completed")
  assert.equal(result.response, "completed")
  assert.equal(Buffer.byteLength(result.stderr), 65536)
  assert.equal(result.stdoutTruncated, false)
  assert.equal(result.stderrTruncated, true)
  assert.equal(result.outputTruncated, true)
})

test("ACP rejects unsupported model instead of substituting", async () => {
  const result = await runAntigravityAcp(input({ model: "unavailable" }))
  assert.equal(result.status, "failed")
  assert.match(result.error, /does not offer model/)
})

test("ACP scoped approval denies unexpected commands", async () => {
  const denied = await runAntigravityAcp(input({ prompt: "approve command", mode: "full" }))
  assert.equal(denied.status, "failed")
  assert.equal(denied.deniedActions.length, 1)
  const allowed = await runAntigravityAcp(input({
    prompt: "approve command", mode: "full", allowedCommands: ["pnpm test"],
  }))
  assert.equal(allowed.status, "completed")
  assert.equal(allowed.response, "approved")
  const edits = await runAntigravityAcp(input({ prompt: "approve edit" }))
  assert.equal(edits.status, "completed")
})

test("ACP refuses unsupported plan mode", async () => {
  await assert.rejects(() => runAntigravityAcp(input({ mode: "plan" })), /no verified read-only mode/)
})

test("ACP times out and terminates the child", async () => {
  const result = await runAntigravityAcp(input({ prompt: "hang", timeoutMs: 50 }))
  assert.equal(result.status, "timeout")
})
