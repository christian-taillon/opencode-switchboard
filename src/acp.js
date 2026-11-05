import { spawn } from "node:child_process"
import path from "node:path"
import { realpath } from "node:fs/promises"

const MAX_FRAME_BYTES = 1024 * 1024
const MAX_DIAGNOSTIC_BYTES = 64 * 1024

async function insideWorkspace(candidate, cwd) {
  if (typeof candidate !== "string" || !candidate) return false
  const resolved = path.resolve(cwd, candidate)
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) return false
  // Resolve symlinks in the target or nearest existing ancestor of a new file.
  let ancestor = resolved
  for (;;) {
    try {
      const canonical = await realpath(ancestor)
      return canonical === cwd || canonical.startsWith(cwd + path.sep)
    } catch (error) {
      if (error.code !== "ENOENT") return false
      const parent = path.dirname(ancestor)
      if (parent === ancestor) return false
      ancestor = parent
    }
  }
}

// ACP is a separate execution boundary; OpenCode shell hooks do not apply.
// Only explicit trusted operations may be auto-approved.
export async function selectAcpPermission(request, { cwd, mode, allowedCommands = [] }) {
  const call = request?.toolCall
  const options = request?.options
  if (!call || !Array.isArray(options)) return undefined
  const once = options.find((option) => option?.kind === "allow_once")
  if (!once || typeof once.optionId !== "string") return undefined
  const locations = Array.isArray(call.locations) ? call.locations : []
  if (call.kind === "edit" && ["edit", "full"].includes(mode) && locations.length > 0 &&
      (await Promise.all(locations.map((location) => insideWorkspace(location?.path, cwd)))).every(Boolean)) return once.optionId
  const command = call.rawInput?.command
  if (mode === "full" && call.kind === "execute" && typeof command === "string" &&
      allowedCommands.includes(command)) return once.optionId
  return undefined
}

function configChoices(config) {
  return Array.isArray(config?.options) ? config.options.flatMap((option) => option.options ?? [option]) : []
}

function selectConfigValue(options, id, requested) {
  const config = options.find((option) => option?.id === id || option?.configId === id)
  if (!config) throw new Error("Antigravity ACP does not advertise the " + id + " setting")
  const choices = configChoices(config)
  if (!choices.some((option) => option?.value === requested)) {
    throw new Error("Antigravity ACP does not offer " + id + "=" + requested)
  }
}

async function applyConfig(send, sessionID, state, id, value) {
  selectConfigValue(state.configOptions ?? [], id, value)
  const changed = await send("session/set_config_option", { sessionId: sessionID, configId: id, value })
  if (Array.isArray(changed?.configOptions)) state.configOptions = changed.configOptions
}

/** Run one bounded ACP turn with Google's official Antigravity ACP stdio server. */
export async function runAntigravityAcp({
  command, args = [], cwd, env, prompt, mode, model, effort, sessionID, timeoutMs,
  maxOutputBytes, signal, allowedCommands = [], onProgress = async () => {},
}) {
  if (mode === "plan") throw new Error("Antigravity ACP has no verified read-only mode; use the CLI plan transport")
  const started = Date.now()
  const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] })
  let input = Buffer.alloc(0)
  let stderr = Buffer.alloc(0)
  let responseText = ""
  let stdoutTruncated = false
  let stderrTruncated = false
  let error
  let termination
  let externalID = sessionID
  let nextID = 0
  const pending = new Map()
  const deniedActions = []
  let protocolError
  function rejectPending(error) {
    for (const { reject } of pending.values()) reject(error)
    pending.clear()
  }
  const exit = new Promise((resolve) => {
    child.once("close", (code, closeSignal) => {
      rejectPending(new Error("Antigravity ACP process exited"))
      resolve({ code, closeSignal })
    })
  })
  const spawned = new Promise((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })
  child.stdin.on("error", () => {})

  function write(message) {
    if (child.stdin.destroyed) throw new Error("Antigravity ACP stdin closed")
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
  }
  function request(method, params) {
    if (protocolError || termination) return Promise.reject(new Error(protocolError ?? "ACP run was interrupted"))
    const id = ++nextID
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try { write({ id, method, params }) }
      catch (err) { pending.delete(id); reject(err) }
    })
  }
  let killTimer
  function stop(kind) {
    if (termination) return
    termination = kind
    if (externalID && kind !== "cleanup") {
      try { write({ method: "session/cancel", params: { sessionId: externalID } }) } catch {}
    }
    if (child.pid) {
      try {
        if (process.platform === "win32") child.kill("SIGTERM")
        else process.kill(-child.pid, "SIGTERM")
      } catch {}
      killTimer = setTimeout(() => {
        try {
          if (process.platform === "win32") child.kill("SIGKILL")
          else process.kill(-child.pid, "SIGKILL")
        } catch {}
      }, 500)
    }
  }
  function append(part) {
    if (typeof part !== "string") return
    const remaining = maxOutputBytes - Buffer.byteLength(responseText)
    if (Buffer.byteLength(part) > remaining) {
      responseText += Buffer.from(part).subarray(0, Math.max(remaining, 0)).toString("utf8")
      stdoutTruncated = true
    } else responseText += part
  }
  async function handleServerRequest(message) {
    if (termination || protocolError) return
    try {
      if (message.method !== "session/request_permission") {
        write({ id: message.id, error: { code: -32601, message: "Unsupported ACP client method" } })
        return
      }
      const selected = await selectAcpPermission(message.params, { cwd, mode, allowedCommands })
      if (termination || protocolError) return
      if (!selected) deniedActions.push({
        title: message.params?.toolCall?.title ?? "unknown",
        kind: message.params?.toolCall?.kind ?? "unknown",
      })
      write({ id: message.id, result: { outcome: selected
        ? { outcome: "selected", optionId: selected } : { outcome: "cancelled" } } })
    } catch (err) {
      if (termination || protocolError) return
      deniedActions.push({ title: "permission handler error", error: err.message })
      try { write({ id: message.id, result: { outcome: { outcome: "cancelled" } } }) } catch {}
    }
  }
  function processMessage(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message !== "object") {
      throw new Error("Invalid ACP JSON-RPC response")
    }
    if (message.id !== undefined && !message.method) {
      const item = pending.get(message.id)
      if (!item) return
      pending.delete(message.id)
      if (message.error) {
        item.reject(new Error("ACP " + (message.error.code ?? "error") + ": " + (message.error.message ?? "request failed")))
      } else item.resolve(message.result)
      return
    }
    if (message.id !== undefined && message.method) { void handleServerRequest(message); return }
    if (message.method !== "session/update") return
    if (externalID && message.params?.sessionId !== externalID) return
    const update = message.params?.update
    if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") append(update.content.text)
    if (["tool_call", "tool_call_update"].includes(update?.sessionUpdate)) {
      const title = typeof update.title === "string" ? update.title.slice(0, 120) : "Antigravity tool"
      void Promise.resolve().then(() => onProgress({ status: title + ": " + (update.status ?? "running") })).catch(() => {})
    }
  }
  child.stdout.on("data", (chunk) => {
    if (protocolError) return
    input = Buffer.concat([input, chunk])
    try {
      for (;;) {
        const position = input.indexOf(10)
        if (position < 0) break
        if (position > MAX_FRAME_BYTES) throw new Error("ACP frame exceeded size limit")
        const frame = input.subarray(0, position).toString("utf8").trim()
        input = input.subarray(position + 1)
        if (frame) processMessage(JSON.parse(frame))
      }
      if (input.length > MAX_FRAME_BYTES) throw new Error("ACP frame exceeded size limit")
    } catch (err) {
      protocolError = err.message
      rejectPending(new Error(protocolError))
      stop("failed")
    }
  })
  child.stderr.on("data", (chunk) => {
    const remaining = MAX_DIAGNOSTIC_BYTES - stderr.length
    if (chunk.length > remaining) stderrTruncated = true
    if (remaining > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)])
  })
  const onAbort = () => stop("aborted")
  const timer = setTimeout(() => stop("timeout"), timeoutMs)
  signal?.addEventListener("abort", onAbort, { once: true })
  if (signal?.aborted) onAbort()
  let result
  let processExit
  try {
    await spawned
    if (termination) throw new Error("ACP run was interrupted")
    const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} })
    if (init?.protocolVersion !== 1) throw new Error("Antigravity ACP did not negotiate protocol v1")
    const state = sessionID
      ? await request("session/load", { sessionId: sessionID, cwd, mcpServers: [] })
      : await request("session/new", { cwd, mcpServers: [] })
    externalID = sessionID ?? state?.sessionId
    if (!externalID) throw new Error("Antigravity ACP did not return a session ID")
    const settings = { configOptions: state.configOptions }
    const modeConfig = settings.configOptions?.find((item) => item.id === "mode" || item.configId === "mode")
    const availableModes = modeConfig
      ? configChoices(modeConfig).map((option) => option.value)
      : (state.modes?.availableModes ?? []).map((option) => option.id)
    const editMode = ["accept-edits", "auto_edit"].find((value) => availableModes.includes(value))
    if (!editMode) throw new Error("Antigravity ACP does not advertise a supported edit mode (accept-edits or auto_edit)")
    if (modeConfig) {
      await applyConfig(request, externalID, settings, "mode", editMode)
      const selected = settings.configOptions?.find((item) => item.id === "mode" || item.configId === "mode")
      if (selected?.currentValue !== editMode) throw new Error("Antigravity ACP did not confirm the requested edit mode: " + editMode)
    } else {
      await request("session/set_mode", { sessionId: externalID, modeId: editMode })
    }
    if (model) await applyConfig(request, externalID, settings, "model", model)
    if (effort) {
      const key = settings.configOptions?.some((item) => item.id === "thinking_level" || item.configId === "thinking_level")
        ? "thinking_level" : "thought_level"
      await applyConfig(request, externalID, settings, key, effort)
    }
    const response = await request("session/prompt", { sessionId: externalID, prompt: [{ type: "text", text: prompt }] })
    if (response?.stopReason !== "end_turn") throw new Error("Antigravity ACP stopped: " + (response?.stopReason ?? "unknown"))
    if (deniedActions.length) throw new Error("Antigravity ACP denied " + deniedActions.length + " tool permission request(s)")
    if (!responseText.trim()) throw new Error("Antigravity ACP returned no final response")
    if (stdoutTruncated) throw new Error("Antigravity ACP response exceeded the output limit")
    if (protocolError) throw new Error(protocolError)
    result = { status: "completed" }
  } catch (err) {
    error = protocolError ?? err.message
    result = { status: termination === "aborted" ? "aborted" : termination === "timeout" ? "timeout" : "failed" }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
    stop("cleanup")
    processExit = await exit
    clearTimeout(killTimer)
  }
  return {
    ...result, sessionID: externalID, response: responseText,
    providerStatus: result.status === "completed" ? "end_turn" : "failed",
    deniedActions: deniedActions.length ? deniedActions : undefined,
    protocolError, error, stderr: stderr.toString("utf8"), stdoutTruncated,
    stderrTruncated, outputTruncated: stdoutTruncated || stderrTruncated,
    exitCode: processExit.code,
    signal: processExit.closeSignal,
    durationMs: Date.now() - started,
  }
}
