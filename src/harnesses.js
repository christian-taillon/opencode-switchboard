const MODES = new Set(["plan", "edit", "full"])

export const HARNESS_IDS = Object.freeze(["antigravity", "claude", "gemini", "codex"])

function normalizeMode(mode) {
  if (mode === undefined) return "edit"
  if (!MODES.has(mode)) throw new Error(`unsupported mode: ${mode}`)
  return mode
}

function jsonObject(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === "object" ? value : undefined
  } catch {
    return undefined
  }
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0)
}

function parseAntigravity(stdout) {
  const value = jsonObject(stdout.trim())
  if (!value || Array.isArray(value)) {
    return {
      protocolError: "Antigravity returned invalid JSON; expected a terminal result object",
      rawOutput: stdout,
    }
  }
  const deniedActions = Array.isArray(value.denied_actions) && value.denied_actions.length > 0
    ? value.denied_actions : undefined
  const result = {
    response: typeof value.response === "string" ? value.response : undefined,
    sessionID: firstString(value.conversation_id, value.conversationId, value.session_id),
    usage: value.usage,
    providerStatus: value.status,
    providerFailed: value.status !== "SUCCESS" || Boolean(value.error) || Boolean(deniedActions),
    error: firstString(value.error?.message, value.error),
    deniedActions,
  }
  if (deniedActions && !result.error) {
    const actions = deniedActions.map((entry) => firstString(entry?.action) ?? "unknown").join(", ")
    result.error = `Antigravity tools were denied in headless mode: ${actions}. Configure scoped permissions.allow rules in Antigravity settings before retrying.`
  }
  let protocolError
  if (typeof value.status !== "string") {
    protocolError = "Antigravity result is missing its terminal status"
  } else if (value.status === "SUCCESS" && !result.response?.trim()) {
    protocolError = "Antigravity success result is missing a nonempty response"
  }
  return protocolError ? { ...result, protocolError, rawOutput: stdout } : result
}

function parseClaude(stdout) {
  const value = jsonObject(stdout.trim())
  if (!value) return { response: stdout.trim() }
  return {
    response: firstString(value.result, value.response, value.message),
    sessionID: firstString(value.session_id, value.sessionId, value.sessionID),
    usage: value.usage,
    providerStatus: value.subtype ?? value.status,
    providerFailed: value.is_error === true || value.subtype === "error",
    error: firstString(value.error?.message, value.error),
  }
}

function parseGemini(stdout) {
  const value = jsonObject(stdout.trim())
  if (!value) return { response: stdout.trim() }
  return {
    response: firstString(value.response, value.result, value.message),
    sessionID: firstString(value.session_id, value.sessionId, value.sessionID),
    usage: value.stats ?? value.usage,
    providerStatus: value.status,
    providerFailed: Boolean(value.error),
    error: firstString(value.error?.message, value.error),
  }
}

function parseCodex(stdout) {
  let sessionID
  let response
  let usage
  let error
  let providerStatus

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const event = jsonObject(line)
    if (!event) continue

    sessionID = firstString(
      event.thread_id,
      event.threadId,
      event.session_id,
      event.sessionId,
      event.thread?.id,
      sessionID,
    )

    const item = event.item
    if (item && typeof item === "object" && item.type === "agent_message") {
      response = firstString(item.text, item.content, response)
    }
    if (event.type === "agent_message") {
      response = firstString(event.text, event.content, response)
    }
    if (event.type === "message" && event.role === "assistant") {
      response = firstString(event.text, event.content, response)
    }

    usage = event.usage ?? event.turn?.usage ?? usage
    providerStatus = firstString(event.status, event.type, providerStatus)
    error = firstString(event.error?.message, event.error, error)
  }

  return {
    response: response ?? stdout.trim(),
    sessionID,
    usage,
    providerStatus,
    providerFailed: Boolean(error),
    error,
  }
}

function effortArgs(effort) {
  if (effort === undefined) return []
  const levels = ["low", "medium", "high", "xhigh", "max"]
  if (!levels.includes(effort)) {
    throw new Error(`unsupported effort: ${effort}; expected ${levels.join(", ")}`)
  }
  return ["--effort", effort]
}

function antigravity({ prompt, mode, sessionID, model, effort, timeoutSeconds }) {
  const printTimeoutSeconds = Math.max(1, timeoutSeconds - 2)
  const args = ["-p", prompt, "--output-format", "json", "--print-timeout", `${printTimeoutSeconds}s`]
  if (mode === "plan") args.push("--mode=plan")
  if (mode === "edit") args.push("--mode=accept-edits")
  if (mode === "full") args.push("--mode=accept-edits", "--dangerously-skip-permissions")
  if (sessionID) args.push("--conversation", sessionID)
  if (model) args.push("--model", model)
  args.push(...effortArgs(effort))
  return args
}

// Claude Code adds Co-Authored-By trailers and PR footers unless user settings
// disable them; enforce that here so delegated commits never carry attribution.
const CLAUDE_SETTINGS = JSON.stringify({ attribution: { commit: "", pr: "" } })

function claude({ prompt, mode, sessionID, model, effort }) {
  const permission = mode === "plan" ? "plan" : mode === "full" ? "auto" : "acceptEdits"
  const args = ["-p", prompt, "--output-format", "json", "--permission-mode", permission, "--settings", CLAUDE_SETTINGS]
  if (sessionID) args.push("--resume", sessionID)
  if (model) args.push("--model", model)
  args.push(...effortArgs(effort))
  return args
}

function gemini({ prompt, mode, sessionID, model, effort }) {
  if (effort !== undefined) throw new Error("Gemini CLI effort selection is not supported")
  const approval = mode === "plan" ? "plan" : mode === "full" ? "yolo" : "auto_edit"
  const args = ["-p", prompt, "--output-format", "json", "--approval-mode", approval]
  if (sessionID) args.push("--resume", sessionID)
  if (model) args.push("--model", model)
  return args
}

function codex({ prompt, mode, sessionID, model, effort }) {
  if (sessionID) {
    throw new Error("Codex session resume is not enabled in Switchboard v0.0.1")
  }
  if (model) {
    throw new Error("Codex model override is not enabled in Switchboard v0.0.1")
  }
  if (effort !== undefined) {
    throw new Error("Codex effort selection is not enabled in Switchboard v0.0.1")
  }
  const args = ["exec", "--json", "--skip-git-repo-check"]
  if (mode !== "plan") args.push("--full-auto")
  args.push(prompt)
  return args
}

const DEFINITIONS = Object.freeze({
  antigravity: {
    id: "antigravity",
    label: "Google Antigravity",
    command: "agy",
    resume: true,
    installHint: "Install and authenticate the Antigravity CLI (`agy`).",
    buildArgs: antigravity,
    parse: parseAntigravity,
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    resume: true,
    installHint: "Install and authenticate Claude Code (`claude`).",
    buildArgs: claude,
    parse: parseClaude,
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    command: "gemini",
    resume: true,
    installHint: "Install and authenticate Gemini CLI (`gemini`).",
    buildArgs: gemini,
    parse: parseGemini,
  },
  codex: {
    id: "codex",
    label: "Codex CLI",
    command: "codex",
    resume: false,
    installHint: "Install and authenticate Codex CLI (`codex`).",
    buildArgs: codex,
    parse: parseCodex,
  },
})

export function getHarness(id, options) {
  if (!HARNESS_IDS.includes(id)) throw new Error(`unknown harness: ${id}`)
  const definition = DEFINITIONS[id]
  const configured = options.harnesses[id]
  if (!configured?.enabled) throw new Error(`harness is disabled: ${id}`)
  return {
    ...definition,
    command: configured.command ?? definition.command,
  }
}

export function buildInvocation(harness, input) {
  const mode = normalizeMode(input.mode)
  const payload = { ...input, mode }
  return {
    mode,
    command: harness.command,
    args: harness.buildArgs(payload),
  }
}

export function parseHarnessOutput(harness, stdout, { truncated = false } = {}) {
  const result = harness.parse(stdout)
  return truncated
    ? {
      ...result,
      protocolError: `${harness.label} stdout was truncated; terminal result cannot be verified`,
      rawOutput: stdout,
    }
    : result
}

export function harnessDefinitions(options) {
  return HARNESS_IDS.map((id) => {
    const definition = DEFINITIONS[id]
    const configured = options.harnesses[id]
    return {
      id,
      label: definition.label,
      command: configured.command ?? definition.command,
      enabled: configured.enabled,
      resume: definition.resume,
      installHint: definition.installHint,
    }
  })
}
