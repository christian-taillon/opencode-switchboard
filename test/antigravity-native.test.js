import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const read = (path) => readFile(new URL(path, import.meta.url), "utf8")

test("antigravity-native is a thin OpenCode subagent adapter", async () => {
  const agent = await read("../integrations/antigravity-native/agents/antigravity.md")

  assert.match(agent, /mode:\s*subagent/)
  assert.match(agent, /model:\s*openai\/gpt-6-luna#medium/)
  assert.match(agent, /harness: "antigravity"/)
  assert.match(agent, /action:\s*switchboard_delegate/)
  assert.match(agent, /Do not inspect, edit, test, review, or implement the repository yourself\./)
  assert.doesNotMatch(
    agent,
    /action:\s*(read|edit|shell|subagent)\s*\n\s*resource:[\s\S]*?effect:\s*allow/,
  )
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
