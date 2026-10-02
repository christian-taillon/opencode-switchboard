import test from "node:test"
import assert from "node:assert/strict"
import { normalizeOptions, resolveTimeoutSeconds } from "../src/config.js"

test("does not assume agent names by default", () => {
  assert.deepEqual(normalizeOptions().awareAgents, [])
})

test("normalizes defaults and clamps requested timeout", () => {
  const options = normalizeOptions({
    defaultTimeoutSeconds: 20,
    maxTimeoutSeconds: 30,
    awareAgents: ["router", "", 7],
    harnesses: { claude: { enabled: false, command: "/opt/claude" } },
  })

  assert.deepEqual(options.awareAgents, ["router"])
  assert.equal(options.harnesses.claude.enabled, false)
  assert.equal(options.harnesses.claude.command, "/opt/claude")
  assert.equal(resolveTimeoutSeconds(undefined, options), 20)
  assert.equal(resolveTimeoutSeconds(999, options), 30)
})
