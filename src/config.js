export const DEFAULTS = Object.freeze({
  awareAgents: ["autopilot", "orchestrator"],
  defaultTimeoutSeconds: 900,
  maxTimeoutSeconds: 3600,
  maxOutputBytes: 8 * 1024 * 1024,
})

const HARNESS_IDS = ["antigravity", "claude", "gemini", "codex"]

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value <= 0) return fallback
  return Math.min(value, maximum)
}

export function normalizeOptions(raw = {}) {
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
    harnesses[id] = {
      enabled: input?.enabled !== false,
      command:
        typeof input?.command === "string" && input.command.trim().length > 0
          ? input.command.trim()
          : undefined,
    }
  }

  return {
    awareAgents,
    defaultTimeoutSeconds,
    maxTimeoutSeconds,
    maxOutputBytes,
    harnesses,
  }
}

export function resolveTimeoutSeconds(requested, options) {
  if (requested === undefined) return options.defaultTimeoutSeconds
  return positiveInteger(requested, options.defaultTimeoutSeconds, options.maxTimeoutSeconds)
}
