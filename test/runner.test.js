import test from "node:test"
import assert from "node:assert/strict"
import { findExecutable, runProcess } from "../src/runner.js"

test("findExecutable resolves an absolute executable", async () => {
  assert.equal(await findExecutable(process.execPath), process.execPath)
})

test("runProcess captures stdout, stderr, exit code, and duration", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "console.log('hello'); console.error('note')"],
    cwd: process.cwd(),
    timeoutMs: 2000,
    maxOutputBytes: 1024,
  })

  assert.equal(result.status, "completed")
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.trim(), "hello")
  assert.equal(result.stderr.trim(), "note")
  assert.equal(result.outputTruncated, false)
  assert.equal(result.stdoutTruncated, false)
  assert.equal(result.stderrTruncated, false)
  assert.ok(result.durationMs >= 0)
})

test("runProcess drains output but caps retained bytes", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(4096))"],
    cwd: process.cwd(),
    timeoutMs: 2000,
    maxOutputBytes: 128,
  })

  assert.equal(result.status, "completed")
  assert.equal(Buffer.byteLength(result.stdout), 128)
  assert.equal(result.outputTruncated, true)
  assert.equal(result.stdoutTruncated, true)
  assert.equal(result.stderrTruncated, false)
})

test("stderr truncation is separate from terminal stdout truncation", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "console.log('done'); console.error('x'.repeat(4096))"],
    cwd: process.cwd(),
    timeoutMs: 2000,
    maxOutputBytes: 128,
  })
  assert.equal(result.stdoutTruncated, false)
  assert.equal(result.stderrTruncated, true)
  assert.equal(result.outputTruncated, true)
})

test("runProcess times out and terminates the foreground process group", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    timeoutMs: 80,
    maxOutputBytes: 1024,
  })

  assert.equal(result.status, "timeout")
  assert.notEqual(result.signal, undefined)
})

test("runProcess honors AbortSignal", async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 50)

  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    timeoutMs: 2000,
    maxOutputBytes: 1024,
    signal: controller.signal,
  })

  assert.equal(result.status, "aborted")
})
