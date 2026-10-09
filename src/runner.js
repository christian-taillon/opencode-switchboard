import { spawn } from "node:child_process"
import { access } from "node:fs/promises"
import path from "node:path"
import { constants as fsConstants } from "node:fs"
import { DEFAULT_ENV_ALLOWLIST, normalizeEnvAllowlist } from "./config.js"

export function subprocessEnvironment(names = DEFAULT_ENV_ALLOWLIST, source = process.env) {
  return Object.fromEntries(normalizeEnvAllowlist(names).filter((name) => Object.hasOwn(source, name)).map((name) => [name, source[name]]))
}

function appendCapped(state, chunk, limit) {
  if (state.size >= limit) {
    state.truncated = true
    return
  }
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  const remaining = limit - state.size
  if (buffer.length > remaining) {
    state.chunks.push(buffer.subarray(0, remaining))
    state.size += remaining
    state.truncated = true
    return
  }
  state.chunks.push(buffer)
  state.size += buffer.length
}

function render(state) {
  return Buffer.concat(state.chunks, state.size).toString("utf8")
}

async function executablePath(command, env = process.env) {
  if (command.includes("/")) {
    const candidate = path.resolve(command)
    await access(candidate, fsConstants.X_OK)
    return candidate
  }
  const paths = (env.PATH ?? "").split(path.delimiter).filter(Boolean)
  for (const entry of paths) {
    const candidate = path.join(entry, command)
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // Continue searching PATH.
    }
  }
  return undefined
}

export async function findExecutable(command, env = process.env) {
  try {
    return await executablePath(command, env)
  } catch {
    return undefined
  }
}

function terminate(child, signal) {
  if (!child.pid) return
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch (error) {
    if (error?.code !== "ESRCH") throw error
  }
}

export async function runProcess({
  command,
  args = [],
  cwd,
  env = subprocessEnvironment(),
  timeoutMs,
  maxOutputBytes,
  signal,
}) {
  const stdout = { chunks: [], size: 0, truncated: false }
  const stderr = { chunks: [], size: 0, truncated: false }
  const started = Date.now()

  return await new Promise((resolve) => {
    let settled = false
    let timeoutHandle
    let killHandle
    let termination = undefined
    let pendingResult

    const finish = (result) => {
      if (settled) return
      // The group may outlive its leader and close the captured pipes early.
      if (killHandle) {
        pendingResult = result
        return
      }
      settled = true
      clearTimeout(timeoutHandle)
      clearTimeout(killHandle)
      signal?.removeEventListener("abort", onAbort)
      resolve({
        ...result,
        stdout: render(stdout),
        stderr: render(stderr),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        outputTruncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - started,
      })
    }

    let child
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      })
    } catch (error) {
      finish({ status: "failed", exitCode: null, signal: null, error: error.message })
      return
    }

    child.stdout?.on("data", (chunk) => appendCapped(stdout, chunk, maxOutputBytes))
    child.stderr?.on("data", (chunk) => appendCapped(stderr, chunk, maxOutputBytes))

    const beginTermination = (kind) => {
      if (termination) return
      termination = kind
      try {
        terminate(child, "SIGTERM")
      } catch (error) {
        finish({ status: kind, exitCode: null, signal: null, error: error.message })
        return
      }
      killHandle = setTimeout(() => {
        try {
          terminate(child, "SIGKILL")
        } catch {
          // The process may already be gone.
        }
        killHandle = undefined
        if (pendingResult) finish(pendingResult)
      }, 500)
    }

    const onAbort = () => beginTermination("aborted")
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })

    timeoutHandle = setTimeout(() => beginTermination("timeout"), timeoutMs)
    timeoutHandle.unref?.()

    child.on("error", (error) => {
      finish({ status: termination ?? "failed", exitCode: null, signal: null, error: error.message })
    })

    child.on("close", (code, closeSignal) => {
      const status = termination ?? (code === 0 ? "completed" : "failed")
      finish({ status, exitCode: code, signal: closeSignal, error: undefined })
    })
  })
}
