import path from "node:path"

export const DEFAULT_ENV_ALLOWLIST = Object.freeze(["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"])

export const DEFAULTS = Object.freeze({
  awareAgents: [],
  defaultTimeoutSeconds: 900,
  maxTimeoutSeconds: 3600,
  maxOutputBytes: 8 * 1024 * 1024,
})

const HARNESS_IDS = ["antigravity", "claude", "gemini", "codex"]

export const EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"])
export const MODEL_ROLE_PATTERN = /^[a-z][a-z0-9-]*$/
const MODEL_ROLE_KEYS = new Set(["model", "effort", "pool"])

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0")
}

function normalizeModelRole(value, label) {
  const entry = object(value, label)
  for (const key of Object.keys(entry)) {
    if (!MODEL_ROLE_KEYS.has(key)) throw new Error(`${label} has unsupported field: ${key}`)
  }
  if (!nonemptyString(entry.model)) throw new Error(`${label}.model must be a nonempty string`)
  if (entry.effort !== undefined && !EFFORT_LEVELS.includes(entry.effort)) {
    throw new Error(`${label}.effort must be one of ${EFFORT_LEVELS.join(", ")}`)
  }
  if (entry.pool !== undefined && !nonemptyString(entry.pool)) throw new Error(`${label}.pool must be a nonempty string`)
  return {
    model: entry.model.trim(),
    ...(entry.effort === undefined ? {} : { effort: entry.effort }),
    ...(entry.pool === undefined ? {} : { pool: entry.pool.trim() }),
  }
}

export function normalizeModels(value, harnessID) {
  const models = {}
  if (value === undefined) return models
  const label = `harnesses.${harnessID}.models`
  for (const [role, entry] of Object.entries(object(value, label))) {
    if (!MODEL_ROLE_PATTERN.test(role)) throw new Error(`invalid model role name: ${harnessID}.${role}; expected ${MODEL_ROLE_PATTERN}`)
    models[role] = normalizeModelRole(entry, `${label}.${role}`)
  }
  return models
}

export function normalizeEnvAllowlist(value) {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !/^[A-Za-z_]/.test(name) || /[^A-Za-z0-9_]/.test(name))) {
    throw new Error("envAllowlist must be an array of environment variable names")
  }
  return [...new Set(value)]
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value <= 0) return fallback
  return Math.min(value, maximum)
}

export function normalizeOptions(raw = {}) {
  object(raw, "options")
  const executionProfiles = Object.create(null)
  if (raw.executionProfiles !== undefined) {
    for (const [id, value] of Object.entries(object(raw.executionProfiles, "executionProfiles"))) {
      const profile = object(value, `executionProfiles.${id}`)
      const type = profile.type === undefined ? "launcher" : profile.type
      if (!id || !["launcher", "dungeon"].includes(type) || typeof profile.approved !== "boolean" || typeof profile.command !== "string" ||
          !path.isAbsolute(profile.command) || profile.command.includes("\0") ||
          (type === "launcher" && (!Array.isArray(profile.args) || profile.args.some((arg) => typeof arg !== "string" || arg.includes("\0")))) ||
          (type === "dungeon" && (typeof profile.config !== "string" || !path.isAbsolute(profile.config) || profile.config.includes("\0") || profile.args !== undefined))) {
        throw new Error(`malformed execution profile: ${id}`)
      }
      executionProfiles[id] = type === "dungeon"
        ? { type, approved: profile.approved, command: profile.command, config: profile.config }
        : { type, approved: profile.approved, command: profile.command, args: [...profile.args] }
    }
  }
  if (raw.harnesses !== undefined) object(raw.harnesses, "harnesses")
  const maxTimeoutSeconds = positiveInteger(
    raw.maxTimeoutSeconds,
    DEFAULTS.maxTimeoutSeconds,
  )
  const defaultTimeoutSeconds = positiveInteger(
    raw.defaultTimeoutSeconds,
    DEFAULTS.defaultTimeoutSeconds,
    maxTimeoutSeconds,
  )
  const maxOutputBytes = positiveInteger(raw.maxOutputBytes, DEFAULTS.maxOutputBytes)

  const awareAgents = Array.isArray(raw.awareAgents)
    ? raw.awareAgents.filter((value) => typeof value === "string" && value.length > 0)
    : [...DEFAULTS.awareAgents]

  const harnesses = {}
  for (const id of HARNESS_IDS) {
    const input = raw.harnesses?.[id]
    if (input !== undefined) object(input, `harnesses.${id}`)
    if (input?.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error(`invalid enabled option: ${id}`)
    if (input?.command !== undefined && (typeof input.command !== "string" || !input.command.trim())) throw new Error(`invalid command: ${id}`)
    if (input?.executionProfile !== undefined && (typeof input.executionProfile !== "string" || !input.executionProfile)) {
      throw new Error(`invalid executionProfile: ${id}`)
    }
    if (id !== "antigravity" && ["transport", "acpCommand", "acpArgs", "acpApprovedCommands"].some((key) => input?.[key] !== undefined)) {
      throw new Error("ACP configuration is only supported by antigravity")
    }
    if (input?.transport !== undefined && !["cli", "acp"].includes(input.transport)) throw new Error("invalid transport: " + id)
    if (input?.acpCommand !== undefined && (typeof input.acpCommand !== "string" || !input.acpCommand.trim())) throw new Error("invalid acpCommand")
    for (const key of ["acpArgs", "acpApprovedCommands"]) {
      if (input?.[key] !== undefined && (!Array.isArray(input[key]) || input[key].some((v) => typeof v !== "string" || !v.trim() || v.includes("\0")))) {
        throw new Error("invalid " + key)
      }
    }
    harnesses[id] = {
      enabled: input?.enabled !== false,
      transport: input?.transport ?? "cli",
      acpCommand: input?.acpCommand?.trim() ?? "agy_acp_server.par",
      acpArgs: input?.acpArgs ?? (process.platform === "linux" ? ["--uid="] : []),
      acpApprovedCommands: input?.acpApprovedCommands ?? [],
      command:
        typeof input?.command === "string" && input.command.trim().length > 0
          ? input.command.trim()
          : undefined,
      executionProfile: input?.executionProfile,
      envAllowlist: input?.envAllowlist === undefined ? [...DEFAULT_ENV_ALLOWLIST] : normalizeEnvAllowlist(input.envAllowlist),
      models: normalizeModels(input?.models, id),
    }
  }

  if (raw.validateModels !== undefined && typeof raw.validateModels !== "boolean") {
    throw new Error("validateModels must be a boolean")
  }

  return {
    awareAgents,
    defaultTimeoutSeconds,
    maxTimeoutSeconds,
    maxOutputBytes,
    validateModels: raw.validateModels !== false,
    harnesses,
    executionProfiles,
  }
}

export function resolveTimeoutSeconds(requested, options) {
  if (requested === undefined) return options.defaultTimeoutSeconds
  return positiveInteger(requested, options.defaultTimeoutSeconds, options.maxTimeoutSeconds)
}
