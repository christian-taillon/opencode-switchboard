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
  if (!value) return { response: stdout.trim() }
  return {
    response: firstString(value.response, value.result, value.message),
    sessionID: firstString(value.conversation_id, value.conversationId, value.session_id),
    usage: value.usage,
    providerStatus: value.status,
    providerFailed: typeof value.status === "string" && value.status !== "SUCCESS",
    error: firstString(value.error?.message, value.error),
  }
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

function antigravity({ prompt, mode, sessionID, model, timeoutSeconds }) {
  const printTimeoutSeconds = Math.max(1, timeoutSeconds - 2)
  const args = ["-p", prompt, "--output-format", "json", "--print-timeout", `${printTimeoutSeconds}s`]
  if (mode === "plan") args.push("--mode=plan")
  if (mode === "edit") args.push("--mode=accept-edits")
  if (mode === "full") args.push("--mode=accept-edits", "--dangerously-skip-permissions")
  if (sessionID) args.push("--conversation", sessionID)
  if (model) args.push("--model", model)
  return args
}

function claude({ prompt, mode, sessionID, model }) {
  const permission = mode === "plan" ? "plan" : mode === "full" ? "bypassPermissions" : "acceptEdits"
  const args = ["-p", prompt, "--output-format", "json", "--permission-mode", permission]
  if (sessionID) args.push("--resume", sessionID)
  if (model) args.push("--model", model)
  return args
}

function gemini({ prompt, mode, sessionID, model }) {
  const approval = mode === "plan" ? "plan" : mode === "full" ? "yolo" : "auto_edit"
  const args = ["-p", prompt, "--output-format", "json", "--approval-mode", approval]
  if (sessionID) args.push("--resume", sessionID)
  if (model) args.push("--model", model)
  return args
}

function codex({ prompt, mode, sessionID, model }) {
  if (sessionID) {
    throw new Error("Codex session resume is not enabled in Switchboard v0.0.1")
  }
  if (model) {
    throw new Error("Codex model override is not enabled in Switchboard v0.0.1")
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

export function parseHarnessOutput(harness, stdout) {
  return harness.parse(stdout)
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
