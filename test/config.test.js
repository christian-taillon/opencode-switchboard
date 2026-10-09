import test from "node:test"
import assert from "node:assert/strict"
import { normalizeOptions, resolveTimeoutSeconds } from "../src/config.js"

test("does not assume agent names by default", () => {
  assert.deepEqual(normalizeOptions().awareAgents, [])
})

test("security configuration rejects malformed profiles and allowlists rather than falling back", () => {
  for (const executionProfiles of [null, [], { bad: null }, { bad: { approved: "true", command: "/launcher", args: [] } },
    { bad: { approved: true, command: "launcher", args: [] } },
    { bad: { approved: true, command: "/launcher", args: [7] } }]) {
    assert.throws(() => normalizeOptions({ executionProfiles }))
  }
  for (const envAllowlist of [null, "PATH", ["BAD-NAME"], [7], [""], ["A=B"], ["PATH\n"]]) {
    assert.throws(() => normalizeOptions({ harnesses: { claude: { envAllowlist } } }), /envAllowlist/)
  }
  for (const executionProfile of [null, false, ""]) {
    assert.throws(() => normalizeOptions({ harnesses: { claude: { executionProfile } } }), /executionProfile/)
  }
  assert.deepEqual(normalizeOptions({ harnesses: { claude: { envAllowlist: [] } } }).harnesses.claude.envAllowlist, [])
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
