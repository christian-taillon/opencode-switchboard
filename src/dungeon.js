import path from "node:path"
import { lstat, open, realpath, unlink } from "node:fs/promises"
import { constants } from "node:fs"
import { createHash } from "node:crypto"
import { findExecutable, runProcess, subprocessEnvironment } from "./runner.js"

const LINE_LIMIT = 65536
const CLEANUP_GRACE_MS = 20000
const bindingWriters = new Set()

function strictEvent(text) {
  const objects = []
  for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}]/g)) {
    if (token[0] === "{") objects.push(new Set())
    else if (token[0] === "}") objects.pop()
    else if (/^\s*:/.test(text.slice(token.index + token[0].length))) {
      const key = JSON.parse(token[0])
      const keys = objects.at(-1)
      if (!keys || keys.has(key)) throw new Error("duplicate event key")
      keys.add(key)
    }
  }
  return JSON.parse(text)
}

export function dungeonKey(kind, value) {
  return `dungeon/${kind}/${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

// Workload bytes are never interpreted as Dungeon events.
export class DungeonOutput {
  constructor(sandboxID, limit) {
    this.sandboxID = sandboxID
    this.limit = limit
    this.pending = Buffer.alloc(0)
    this.seq = 0
    this.started = false
    this.terminal = undefined
    this.error = undefined
    this.streams = Object.fromEntries(["stdout", "stderr"].map((name) => [name, { chunks: [], size: 0, truncated: false }]))
  }

  feed(chunk) {
    if (this.error) return
    try {
      let offset = 0
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset)
        const end = newline < 0 ? chunk.length : newline
        if (this.pending.length + end - offset > LINE_LIMIT) throw new Error("Dungeon event exceeds its byte limit")
        this.pending = Buffer.concat([this.pending, chunk.subarray(offset, end)])
        if (newline < 0) break
        this.event(strictEvent(new TextDecoder("utf-8", { fatal: true }).decode(this.pending)))
        this.pending = Buffer.alloc(0)
        offset = newline + 1
      }
    } catch (error) {
      this.error = `Invalid Dungeon stream: ${error.message}`
      throw new Error(this.error)
    }
  }

  event(value) {
    if (!value || Array.isArray(value) || value.schema !== 1 || value.operation !== "exec" || this.terminal) {
      throw new Error("unexpected event envelope or trailing event")
    }
    // Prelaunch refusals use ordinary machine JSON, not JSONL execution events.
    if (this.seq === 0 && value.event === undefined && value.ok === false &&
        typeof value.error?.code === "string" && ["none", "unknown"].includes(value.error.effects)) {
      this.terminal = { ...value, cleanup: value.error.effects === "none" ? "not_started" : "unconfirmed",
        primary_transport_verified: false, exit_code: null }
      return
    }
    if (value.seq !== this.seq++) throw new Error("event sequence mismatch")
    if (value.event === "started" && !this.started && value.seq === 0 && value.sandbox_id === this.sandboxID) {
      this.started = true
      return
    }
    if (value.event === "finished" && typeof value.ok === "boolean" &&
        ["confirmed", "unconfirmed", "not_started"].includes(value.cleanup) &&
        typeof value.primary_transport_verified === "boolean" &&
        (value.cleanup !== "confirmed" || value.primary_transport_verified) &&
        (value.cleanup !== "not_started" || !value.primary_transport_verified) &&
        (value.cleanup === "not_started" ? !this.started : this.started) &&
        (value.ok ? this.started && value.cleanup === "confirmed" && value.primary_transport_verified && value.error === null &&
          Number.isInteger(value.exit_code) && value.exit_code >= 0 && value.exit_code <= 255
          : value.exit_code === null && typeof value.error?.code === "string" &&
            ["none", "unknown"].includes(value.error.effects))) {
      this.terminal = value
      return
    }
    if (value.event !== "output" || !this.started || !["stdout", "stderr"].includes(value.stream) ||
        value.encoding !== "base64" || typeof value.data !== "string" || value.data.length > 5464) {
      throw new Error("invalid event state or output frame")
    }
    const bytes = Buffer.from(value.data, "base64")
    if (bytes.length > 4096 || bytes.toString("base64") !== value.data) throw new Error("noncanonical output bytes")
    const stream = this.streams[value.stream]
    const retained = bytes.subarray(0, Math.max(0, this.limit - stream.size))
    if (retained.length) stream.chunks.push(retained)
    stream.size += retained.length
    stream.truncated ||= retained.length !== bytes.length
  }

  finish(execution) {
    const protocolError = execution.spawned === false ? undefined : this.error ?? (this.pending.length ? "Dungeon stream ended inside an event" : undefined) ??
      (!this.terminal ? "Dungeon stream is missing its finished event" : undefined) ??
      (this.terminal.ok && execution.exitCode !== this.terminal.exit_code ? "Dungeon terminal status disagrees with CLI exit" : undefined) ??
      (!this.terminal.ok && execution.exitCode !== 1 ? "Dungeon failure disagrees with CLI exit" : undefined)
    const confirmed = !protocolError && !execution.forcedTermination &&
      this.terminal?.primary_transport_verified === true && this.terminal.cleanup === "confirmed"
    const notStarted = execution.spawned === false || !protocolError && this.terminal?.cleanup === "not_started"
    const transportFailed = Boolean(protocolError) || this.terminal?.ok !== true
    const stdout = this.streams.stdout
    const stderr = this.streams.stderr
    return {
      ...execution,
      status: execution.status === "completed" && transportFailed ? "failed" : execution.status,
      stdout: Buffer.concat(stdout.chunks, stdout.size).toString("utf8"),
      stderr: Buffer.concat(stderr.chunks, stderr.size).toString("utf8"),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      outputTruncated: stdout.truncated || stderr.truncated,
      error: execution.error ?? protocolError ?? (transportFailed ? this.terminal?.error?.message : undefined),
      dungeon: {
        sandboxID: this.sandboxID,
        cleanup: confirmed ? "confirmed" : notStarted ? "not_started" : "unconfirmed",
        transportError: this.terminal?.error,
        protocolError,
        diagnostic: execution.stderr.trim() || undefined,
      },
    }
  }
}

export async function inspectDungeon(harness, workspace, signal) {
  if (process.platform !== "linux") throw new Error("Dungeon profiles require Linux")
  const command = await findExecutable(harness.profile.command)
  if (!command) throw new Error(`Dungeon executable not found: ${harness.profile.command}`)
  const config = await realpath(harness.profile.config)
  const result = await runProcess({
    command, args: ["--config", config, "machine", "--schema", "1", "status"],
    cwd: workspace.cwd, env: subprocessEnvironment(harness.envAllowlist),
    timeoutMs: 10000, maxOutputBytes: LINE_LIMIT, signal,
    terminationTarget: "leader", terminationGraceMs: CLEANUP_GRACE_MS,
  })
  let value
  try { value = strictEvent(result.stdout) } catch { throw new Error("Dungeon status did not return valid machine JSON") }
  if (result.status !== "completed" || result.stdoutTruncated || value?.schema !== 1 || value?.operation !== "status" || value?.ok !== true) {
    throw new Error(value?.error?.message ?? result.error ?? "Dungeon status failed")
  }
  const state = value.result
  const environment = state?.environment
  if (state?.phase !== "ready" || state.identity !== "verified" || state.policy !== "verified" ||
      state.initial_upload_pending !== false || state.copy_baseline_valid !== true ||
      environment?.project_transfer !== "copy" || environment.execution_location !== "local" ||
      environment.guest_project !== "/sandbox/project" ||
      typeof environment.fingerprint !== "string" || !environment.fingerprint ||
      typeof environment.sandbox_id !== "string" || !environment.sandbox_id) {
    throw new Error("Dungeon requires a verified Ready copy environment with a valid upload baseline")
  }
  if (await realpath(environment.project) !== workspace.root || await realpath(environment.config) !== config) {
    throw new Error("Dungeon project/config must match the calling session and approved profile")
  }
  const relative = path.relative(workspace.root, workspace.cwd)
  const guestCwd = relative ? `/sandbox/project/${relative.split(path.sep).join("/")}` : "/sandbox/project"
  return { command, config, project: workspace.root, fingerprint: environment.fingerprint,
    sandboxID: environment.sandbox_id, guestCwd }
}

export async function runDungeon({ harness, binding, args, timeoutMs, maxOutputBytes, signal }) {
  const output = new DungeonOutput(binding.sandboxID, maxOutputBytes)
  const execution = await runProcess({
    command: binding.command,
    args: ["--config", binding.config, "machine", "--schema", "1", "exec", "--owned", "--cwd", binding.guestCwd, "--", ...args],
    cwd: binding.project, env: subprocessEnvironment(harness.envAllowlist),
    timeoutMs, maxOutputBytes, signal, terminationTarget: "leader", terminationGraceMs: CLEANUP_GRACE_MS,
    onStdout: (chunk) => output.feed(chunk),
  })
  return output.finish(execution)
}

export function dungeonAdmissionPath(binding) {
  const identity = createHash("sha256").update(binding.sandboxID).digest("hex")
  return path.join(path.dirname(binding.config), `switchboard-${identity}.lock`)
}

export async function runDungeonGuarded(input) {
  if (input.signal?.aborted) return runDungeon(input)
  const record = dungeonAdmissionPath(input.binding)
  const parent = await lstat(path.dirname(record))
  if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0) {
    throw new Error("Dungeon admission requires a private owner-only configuration directory")
  }
  let file
  try {
    file = await open(record, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Dungeon admission is blocked: an earlier invocation may still be running. Recover it deliberately and provision a new environment before retrying. Record: ${record}`)
    throw error
  }
  const release = async () => {
    const held = await file.stat()
    const current = await lstat(record)
    if (!current.isFile() || held.dev !== current.dev || held.ino !== current.ino) throw new Error("Dungeon admission record changed; recovery is required")
    await unlink(record)
  }
  let executing = false
  try {
    await file.writeFile(JSON.stringify({ state: "running_or_cleanup_unconfirmed", ...resumeBinding(input.harness, input.binding) }))
    await file.sync()
    executing = true
    const result = await runDungeon(input)
    result.dungeon.admissionRecord = record
    if (["confirmed", "not_started"].includes(result.dungeon.cleanup)) {
      await release()
    }
    return result
  } catch (error) {
    if (!executing) await release()
    throw error
  } finally { await file.close() }
}

export function resumeBinding(harness, binding) {
  return { harness: harness.id, config: binding.config, project: binding.project,
    fingerprint: binding.fingerprint, sandboxID: binding.sandboxID, guestCwd: binding.guestCwd }
}

export function sameResumeBinding(stored, binding) {
  return Boolean(stored) && Object.entries(binding).every(([key, value]) => stored[key] === value)
}

export async function persistDungeonSession(storage, harness, binding, sessionID) {
  const key = dungeonKey("session", [harness.id, sessionID])
  if (bindingWriters.has(key)) throw new Error("Dungeon session binding is already being persisted")
  bindingWriters.add(key)
  try {
    const value = resumeBinding(harness, binding)
    const stored = await storage.get(key)
    if (stored && !sameResumeBinding(stored, value)) throw new Error("Dungeon session ID is already bound to another environment/project/cwd")
    if (!stored) await storage.set(key, value)
  } finally { bindingWriters.delete(key) }
}

export const GUEST_DISCOVERY = `const fs=require('node:fs'),path=require('node:path');const command=process.argv[1];const paths=command.includes('/')?[command]:(process.env.PATH??'').split(':').filter(Boolean).map(p=>path.join(p,command));const available=paths.some(p=>{try{fs.accessSync(p,fs.constants.X_OK);return fs.statSync(p).isFile()}catch{return false}});console.log(JSON.stringify({available}));`
