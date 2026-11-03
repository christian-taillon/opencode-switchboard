// Model roles, live model listing, and request-time model validation.
// Everything here describes requested selections; none of it verifies the
// model or effort a vendor actually resolved.

export const MODEL_LIST_TIMEOUT_MS = 30_000
export const MODEL_LIST_MAX_OUTPUT_BYTES = 256 * 1024
export const MODEL_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_ERROR_DETAIL = 500

export function unsupportedListingError(harnessID) {
  return `live model listing not supported for ${harnessID}`
}

// Parses "<id><2+ spaces><label>" lines. Blank or unparseable lines are skipped.
export function parseModelList(stdout) {
  const models = []
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const match = /^\s*(\S+)[ \t]{2,}(\S.*?)\s*$/.exec(line)
    if (match) models.push({ id: match[1], label: match[2] })
  }
  return models
}

function hasRole(roles, name) {
  return typeof name === "string" && Object.hasOwn(roles, name)
}

// A configured role name expands to its model and effort (explicit effort wins).
// Omitted model uses the `default` role when configured, otherwise the vendor
// default. Anything else is a raw harness-native model ID passed through.
export function resolveModelSelection(roles = {}, { model, effort } = {}) {
  const roleName = model === undefined ? (hasRole(roles, "default") ? "default" : undefined)
    : (hasRole(roles, model) ? model : undefined)
  if (roleName === undefined) return { model, effort }
  const role = roles[roleName]
  return {
    role: roleName,
    model: role.model,
    effort: effort ?? role.effort,
    ...(role.pool === undefined ? {} : { pool: role.pool }),
  }
}

export function selectionReport(selection) {
  return {
    requestedModel: selection.model ?? "unknown",
    requestedEffort: selection.effort,
    ...(selection.role === undefined ? {} : { requestedRole: selection.role }),
    ...(selection.pool === undefined ? {} : { pool: selection.pool }),
  }
}

export function modelValidationError(harnessID, selection, live, roles = {}) {
  if (selection.model === undefined || !Array.isArray(live)) return undefined
  if (live.some((entry) => entry.id === selection.model)) return undefined
  const prefix = selection.role === undefined
    ? `unknown model for ${harnessID}: ${selection.model}`
    : `role ${selection.role} points to unavailable model ${selection.model}`
  const valid = live.map((entry) => entry.id).join(", ") || "none"
  const roleNames = Object.keys(roles).join(", ") || "none"
  return `${prefix}; valid model IDs: ${valid}; configured roles: ${roleNames}`
}

function detail(text) {
  const trimmed = String(text ?? "").trim()
  return trimmed.length > MAX_ERROR_DETAIL ? `${trimmed.slice(0, MAX_ERROR_DETAIL)}…` : trimmed
}

// Converts a runner/Dungeon execution result into a parsed model list or throws.
export function modelsFromExecution(harness, execution) {
  const label = harness.label ?? harness.id
  if (execution.status !== "completed") {
    const reason = execution.status === "timeout" ? "timed out"
      : execution.status === "aborted" ? "was aborted"
        : `exited with code ${execution.exitCode}`
    throw new Error(execution.error ?? (detail(execution.stderr) || `${label} model listing ${reason}`))
  }
  if (execution.stdoutTruncated) throw new Error(`${label} model listing output was truncated`)
  return parseModelList(execution.stdout)
}

// In-memory, per-harness cache of successful live listings. Failures are not cached.
export function createModelCatalog({ list, now = Date.now, ttlMs = MODEL_CACHE_TTL_MS }) {
  const cache = new Map()

  async function live(harness, context) {
    if (!harness.modelListArgs) return { live: null, liveError: unsupportedListingError(harness.id) }
    const hit = cache.get(harness.id)
    if (hit && now() - hit.at < ttlMs) return { live: hit.models.map((entry) => ({ ...entry })) }
    try {
      const models = await list(harness, context)
      if (!Array.isArray(models) || models.length === 0) {
        throw new Error(`${harness.label ?? harness.id} model listing returned no parseable models`)
      }
      cache.set(harness.id, { at: now(), models: models.map((entry) => ({ ...entry })) })
      return { live: models.map((entry) => ({ ...entry })) }
    } catch (error) {
      return { live: null, liveError: error?.message ?? String(error) }
    }
  }

  return { live }
}
