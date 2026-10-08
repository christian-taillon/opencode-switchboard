import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const read = (path) => readFile(new URL(path, import.meta.url), "utf8")

test("claude-native agent is a thin subagent adapter", async () => {
  const agent = await read("../integrations/claude-native/agents/claude-code.md")

  assert.match(agent, /mode:\s*subagent/)
  assert.match(agent, /model:\s*openai\/gpt-6\.1-sol#high/)
  assert.match(agent, /action:\s*execute\s*\n\s*resource:\s*"\*"\s*\n\s*effect:\s*allow/)
  assert.match(agent, /tools\.switchboard\.delegate/)
  assert.match(agent, /tools\.switchboard\.harnesses/)
  assert.match(agent, /does not bypass nested tool permissions/)
  assert.match(agent, /action:\s*switchboard_delegate/)
  assert.match(agent, /action:\s*switchboard_harnesses/)
  assert.match(agent, /Do not implement, inspect, edit, test, or review the repository yourself\./)
  assert.doesNotMatch(agent, /action:\s*(read|edit|shell|subagent)\s*\n\s*resource:[\s\S]*?effect:\s*allow/)
  for (const field of ["deniedActions", "protocolError", "exitCode", "providerStatus"]) {
    assert.ok(agent.includes(`\`${field}\``), `must report ${field}`)
  }
  assert.match(agent, /relevant stderr blockers/)
  assert.match(agent, /never escalate mode, bypass permissions, or silently retry/)
  assert.match(agent, /model: "claude-sonnet-5-5"`, `effort: "xhigh"/)
  assert.match(agent, /`claude-opus-5-5` with `high` effort/)
  assert.match(agent, /`claude-haiku-5-5` with `high` effort/)
  assert.match(agent, /Parent selections win over task-based choices/)
  assert.match(agent, /`externalModel` and `externalEffort`/)
  assert.match(agent, /Explicitly resend both retained `model` and `effort`/)
  assert.match(agent, /do not silently downgrade, retry, escalate, or switch provider\/harness/)
  assert.match(agent, /Distinguish requested selectors from verified resolved metadata/)
  assert.match(agent, /stop and report the exact reason and requested model\/effort pair/)
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
  assert.ok(install.includes('backup_if_present "$agent_dir/claude.md" "agents/claude.md"'))
  for (const id of ["claude-code", "claude"]) {
    assert.ok(install.includes(`install -m 0644 "$integration_dir/agents/claude-code.md" "$agent_dir/${id}.md"`))
    assert.ok(uninstall.includes(`rm -f "$config_dir/agents/${id}.md"`))
  }
  assert.match(install, /commands\/claude\.md/)
  assert.match(uninstall, /--remove-plugin/)
  assert.match(uninstall, /\.installed-by-claude-native/)
})
