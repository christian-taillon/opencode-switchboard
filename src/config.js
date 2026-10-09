import path from "node:path"

export const DEFAULT_ENV_ALLOWLIST = Object.freeze(["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"])

export const DEFAULTS = Object.freeze({
  awareAgents: [],
  defaultTimeoutSeconds: 900,
  maxTimeoutSeconds: 3600,
  maxOutputBytes: 8 * 1024 * 1024,
})

const HARNESS_IDS = ["antigravity", "claude", "gemini", "codex"]

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
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
      if (!id || typeof profile.approved !== "boolean" || typeof profile.command !== "string" ||
          !path.isAbsolute(profile.command) || profile.command.includes("\0") || !Array.isArray(profile.args) ||
          profile.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
        throw new Error(`malformed execution profile: ${id}`)
      }
      executionProfiles[id] = { approved: profile.approved, command: profile.command, args: [...profile.args] }
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
    harnesses[id] = {
      enabled: input?.enabled !== false,
      command:
        typeof input?.command === "string" && input.command.trim().length > 0
          ? input.command.trim()
          : undefined,
      executionProfile: input?.executionProfile,
      envAllowlist: input?.envAllowlist === undefined ? [...DEFAULT_ENV_ALLOWLIST] : normalizeEnvAllowlist(input.envAllowlist),
    }
  }

  return {
    awareAgents,
    defaultTimeoutSeconds,
    maxTimeoutSeconds,
    maxOutputBytes,
    harnesses,
    executionProfiles,
  }
}

export function resolveTimeoutSeconds(requested, options) {
  if (requested === undefined) return options.defaultTimeoutSeconds
  return positiveInteger(requested, options.defaultTimeoutSeconds, options.maxTimeoutSeconds)
}
