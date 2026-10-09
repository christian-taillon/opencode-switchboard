import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const read = (path) => readFile(new URL(path, import.meta.url), "utf8")

test("antigravity-native is a thin OpenCode subagent adapter", async () => {
  const agent = await read("../integrations/antigravity-native/agents/antigravity.md")

  assert.match(agent, /mode:\s*subagent/)
  assert.match(agent, /model:\s*openai\/gpt-6-luna#high/)
  assert.match(agent, /harness: "antigravity"/)
  assert.match(agent, /action:\s*"\*"\s*\n\s*resource:\s*"\*"\s*\n\s*effect:\s*deny/)
  assert.match(agent, /action:\s*execute\s*\n\s*resource:\s*"\*"\s*\n\s*effect:\s*allow/)
  assert.match(agent, /tools\.switchboard\.delegate/)
  assert.match(agent, /tools\.switchboard\.harnesses/)
  assert.match(agent, /does not bypass nested tool permissions/)
  assert.match(agent, /action:\s*switchboard_harnesses/)
  assert.match(agent, /action:\s*switchboard_delegate/)
  assert.match(agent, /Do not inspect, edit, test, review, or implement the repository yourself\./)
  assert.doesNotMatch(
    agent,
    /action:\s*(read|edit|shell|subagent)\s*\n\s*resource:[\s\S]*?effect:\s*allow/,
  )
})

test("antigravity-native preserves permission blockers and requires explicit bypass authority", async () => {
  const agent = await read("../integrations/antigravity-native/agents/antigravity.md")

  assert.match(agent, /full` only when the parent explicitly authorizes both the bounded work and vendor permission bypass/)
  assert.match(agent, /authorizing tests or builds alone does not authorize that bypass/)
  for (const field of ["deniedActions", "protocolError", "exitCode", "providerStatus"]) {
    assert.ok(agent.includes(`\`${field}\``), `must report ${field}`)
  }
  assert.match(agent, /relevant stderr blockers/)
  assert.match(agent, /Provider success or exit code zero alone does not prove task completion/)
  assert.match(agent, /never escalate mode, bypass permissions, or silently retry/)
  assert.doesNotMatch(agent, /execution profile/)
  assert.match(agent, /model: "gemini-3\.8-flash-medium"`, `effort: "medium"/)
  assert.match(agent, /Parent selections win over task-based choices/)
  assert.match(agent, /`externalModel` and `externalEffort`/)
  assert.match(agent, /explicitly resend both retained `model` and `effort`/)
  assert.match(agent, /do not silently downgrade, retry, escalate, or switch provider\/harness/)
  assert.match(agent, /Distinguish requested selectors from verified resolved metadata/)
  assert.match(agent, /stop and report the exact reason and requested model\/effort pair/)
})

test("antigravity-native installs only a subagent profile", async () => {
  const install = await read("../integrations/antigravity-native/install.sh")
  const uninstall = await read("../integrations/antigravity-native/uninstall.sh")

  assert.match(install, /plugins\/switchboard/)
  assert.match(install, /agents\/antigravity\.md/)
  assert.doesNotMatch(install, /commands\//)
  assert.match(uninstall, /agents\/antigravity\.md/)
  assert.doesNotMatch(uninstall, /rm -rf .*plugins\/switchboard/)
})
