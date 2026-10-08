import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
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

for (const kind of ["timeout", "aborted"]) {
  for (const stdio of ["ignore", "inherit"]) {
    test(`runProcess ${kind} kills a resistant descendant with ${stdio} pipes after its leader exits`,
      { skip: process.platform !== "linux", timeout: 10000 }, async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "switchboard-runner-"))
        const pidfile = path.join(directory, "descendant.pid")
        const controller = new AbortController()
        let pid
        let execution
        try {
          const descendant = `
process.on('SIGTERM', () => {})
require('node:fs').writeFileSync(${JSON.stringify(pidfile)}, String(process.pid))
setInterval(() => {}, 1000)
`
          const leader = `
require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ${JSON.stringify(stdio)} })
setInterval(() => {}, 1000)
`
          execution = runProcess({
            command: process.execPath,
            args: ["-e", leader],
            cwd: directory,
            timeoutMs: kind === "timeout" ? 1500 : 5000,
            maxOutputBytes: 1024,
            signal: controller.signal,
          })
          const readyDeadline = Date.now() + 3000
          while (!pid && Date.now() < readyDeadline) {
            try { pid = Number(await readFile(pidfile, "utf8")) } catch (error) {
              if (error.code !== "ENOENT") throw error
            }
            if (!pid) await delay(10)
          }
          assert.ok(pid, "descendant installed its SIGTERM handler")
          if (kind === "aborted") controller.abort()
          const result = await execution
          assert.equal(result.status, kind)

          // A killed orphan can remain a zombie until the host reaps it.
          let alive = true
          const deadline = Date.now() + 1000
          while (alive && Date.now() < deadline) {
            try {
              const stat = await readFile(`/proc/${pid}/stat`, "utf8")
              alive = !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0])
            } catch (error) {
              if (error.code !== "ENOENT") throw error
              alive = false
            }
            if (alive) await delay(10)
          }
          assert.equal(alive, false, "descendant must not survive terminal cleanup")
        } finally {
          controller.abort()
          if (pid) {
            try { process.kill(pid, "SIGKILL") } catch (error) {
              if (error.code !== "ESRCH") throw error
            }
          }
          if (execution) await execution
          await rm(directory, { recursive: true, force: true })
        }
      })
  }
}
