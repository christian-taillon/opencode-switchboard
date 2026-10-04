import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const read = (path) => readFile(new URL(path, import.meta.url), "utf8")

test("claude-native agent is a thin subagent adapter", async () => {
  const agent = await read("../integrations/claude-native/agents/claude-code.md")

  assert.match(agent, /mode:\s*subagent/)
  assert.match(agent, /model:\s*openai\/gpt-6-luna#medium/)
  assert.match(agent, /action:\s*switchboard_delegate/)
  assert.match(agent, /action:\s*switchboard_harnesses/)
  assert.match(agent, /Do not implement, inspect, edit, test, or review the repository yourself\./)
  assert.doesNotMatch(agent, /action:\s*(read|edit|shell|subagent)\s*\n\s*resource:[\s\S]*?effect:\s*allow/)
})

test("/claude uses the native OpenCode child-session command path", async () => {
  const command = await read("../integrations/claude-native/commands/claude.md")

  assert.match(command, /agent:\s*claude-code/)
  assert.match(command, /subagent:\s*true/)
  assert.match(command, /\$ARGUMENTS/)
})

test("claude-native profile remains optional and independently installable", async () => {
  const install = await read("../integrations/claude-native/install.sh")
  const uninstall = await read("../integrations/claude-native/uninstall.sh")

  assert.match(install, /plugins\/switchboard/)
  assert.match(install, /agents\/claude-code\.md/)
  assert.match(install, /commands\/claude\.md/)
  assert.match(uninstall, /--remove-plugin/)
  assert.match(uninstall, /\.installed-by-claude-native/)
})
