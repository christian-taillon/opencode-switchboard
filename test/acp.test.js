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
  const resumed = await runAntigravityAcp(input({
    sessionID: first.sessionID, model: "test-model", effort: "medium",
  }))
  assert.equal(resumed.status, "completed")
  assert.equal(resumed.sessionID, first.sessionID)
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
