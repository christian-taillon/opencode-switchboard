import test from "node:test"
import assert from "node:assert/strict"
import {
  createModelCatalog,
  modelValidationError,
  modelsFromExecution,
  parseModelList,
  resolveModelSelection,
  selectionReport,
} from "../src/models.js"

test("model listing parses IDs, bounds errors, and validates resolved role selections", () => {
  const live = parseModelList("Model ID  Display name\nclaude-opus-5-5-medium  Claude Opus\ngemini-3.8-flash-medium  Gemini Flash\n")
  assert.deepEqual(live, [
    { id: "claude-opus-5-5-medium", label: "Claude Opus" },
    { id: "gemini-3.8-flash-medium", label: "Gemini Flash" },
  ])
  const roles = { default: { model: "claude-opus-5-5-medium", effort: "medium", pool: "claude" } }
  const selection = resolveModelSelection(roles, { effort: "high" })
  assert.deepEqual(selection, { role: "default", model: "claude-opus-5-5-medium", effort: "high", pool: "claude" })
  assert.deepEqual(selectionReport(selection), {
    requestedModel: "claude-opus-5-5-medium", requestedEffort: "high", requestedRole: "default", pool: "claude",
  })
  assert.equal(modelValidationError("antigravity", selection, live, roles), undefined)
  assert.match(modelValidationError("antigravity", { ...selection, model: "missing" }, live, roles), /valid model IDs/)
  assert.deepEqual(resolveModelSelection(roles, { model: "native-id" }), { model: "native-id", effort: undefined })
  assert.equal(modelsFromExecution({ id: "antigravity" }, { status: "completed", stdout: "bad output" }).length, 0)
  assert.throws(() => modelsFromExecution({ id: "antigravity" }, { status: "timeout", error: "listing timed out" }), /listing timed out/)
})

test("model catalog caches successful listings but retries failures", async () => {
  let now = 100
  let calls = 0
  let fails = true
  const catalog = createModelCatalog({
    now: () => now,
    ttlMs: 50,
    list: async () => {
      calls += 1
      if (fails) throw new Error("not ready")
      return [{ id: "model-a", label: "A" }]
    },
  })
  const harness = { id: "antigravity", modelListArgs: ["models"] }
  assert.match((await catalog.live(harness)).liveError, /not ready/)
  fails = false
  assert.deepEqual((await catalog.live(harness)).live, [{ id: "model-a", label: "A" }])
  assert.deepEqual((await catalog.live(harness)).live, [{ id: "model-a", label: "A" }])
  assert.equal(calls, 2)
  now += 51
  await catalog.live(harness)
  assert.equal(calls, 3)
  assert.match((await catalog.live({ id: "claude" })).liveError, /not supported/)
})
