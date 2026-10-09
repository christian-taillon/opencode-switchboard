import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const read = (path) => readFile(new URL(path, import.meta.url), "utf8")
const exec = promisify(execFile)

test("claude-native agent is a thin subagent adapter", async () => {
  const agent = await read("../integrations/claude-native/agents/claude.md")

  assert.match(agent, /mode:\s*subagent/)
  assert.match(agent, /model:\s*openai\/gpt-6-luna#high/)
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
  assert.match(agent, /model: "claude-opus-5-5"`, `effort: "high"/)
  assert.match(agent, /`claude-sonnet-5-5` with `xhigh` effort/)
  assert.match(agent, /`claude-haiku-4-5` with no effort selector/)
  assert.match(agent, /Parent selections win over task-based choices/)
  assert.match(agent, /`externalModel` and `externalEffort`/)
  assert.match(agent, /Explicitly resend both retained `model` and `effort`/)
  assert.match(agent, /do not silently downgrade, retry, escalate, or switch provider\/harness/)
  assert.match(agent, /Distinguish requested selectors from verified resolved metadata/)
  assert.match(agent, /stop and report the exact reason and requested model\/effort pair/)
})

test("/claude uses the native OpenCode child-session command path", async () => {
  const command = await read("../integrations/claude-native/commands/claude.md")

  assert.match(command, /^agent: claude$/m)
  assert.match(command, /subagent:\s*true/)
  assert.match(command, /\$ARGUMENTS/)
})

test("claude-native profile remains optional and independently installable", async () => {
  const install = await read("../integrations/claude-native/install.sh")
  const uninstall = await read("../integrations/claude-native/uninstall.sh")

  assert.match(install, /plugins\/switchboard/)
  assert.match(install, /agents\/claude-code\.md/)
  assert.ok(install.includes('backup_if_present "$agent_dir/claude.md" "agents/claude.md"'))
  assert.ok(install.includes('install -m 0644 "$integration_dir/agents/claude.md" "$agent_dir/claude.md"'))
  assert.ok(install.includes('rm -f "$agent_dir/claude-code.md"'))
  for (const id of ["claude-code", "claude"]) {
    assert.ok(uninstall.includes(`rm -f "$config_dir/agents/${id}.md"`))
  }
  assert.match(install, /commands\/claude\.md/)
  assert.match(uninstall, /--remove-plugin/)
  assert.match(uninstall, /\.installed-by-claude-native/)
})

for (const legacy of [false, true]) {
  test(`claude-native ${legacy ? "upgrade backs up and removes legacy routing" : "install exposes only canonical routing"}`, async (t) => {
    await mkdir("/tmp/opencode", { recursive: true })
    const config = await mkdtemp("/tmp/opencode/claude-native-test-")
    t.after(() => rm(config, { recursive: true, force: true }))
    const agents = join(config, "agents")
    const commands = join(config, "commands")
    const plugin = join(config, "plugins/switchboard")
    await Promise.all([agents, commands, plugin].map((path) => mkdir(path, { recursive: true })))
    const backend = '{"name":"preexisting-test-backend"}\n'
    await writeFile(join(plugin, "package.json"), backend)
    await writeFile(join(agents, "unrelated.md"), "untouched agent")
    const originals = {
      "agents/claude-code.md": "legacy wrapper",
      "agents/claude.md": "custom canonical wrapper",
      "commands/claude.md": "---\nagent: claude-code\nsubagent: true\n---\n$ARGUMENTS\n",
    }
    if (legacy) {
      for (const [path, content] of Object.entries(originals)) {
        await writeFile(join(config, path), content)
      }
    }
    const run = (script, args = []) => exec("bash", [
      fileURLToPath(new URL(`../integrations/claude-native/${script}.sh`, import.meta.url)), ...args,
    ], { env: { ...process.env, HOME: config, OPENCODE_CONFIG_DIR: config }, timeout: 10_000 })

    const { stdout } = await run("install")
    assert.match(stdout, /using existing Switchboard backend/)
    assert.deepEqual((await readdir(agents)).sort(), ["claude.md", "unrelated.md"])
    assert.equal(await readFile(join(agents, "claude.md"), "utf8"), await read("../integrations/claude-native/agents/claude.md"))
    assert.equal(await readFile(join(commands, "claude.md"), "utf8"), await read("../integrations/claude-native/commands/claude.md"))
    assert.equal(await readFile(join(plugin, "package.json"), "utf8"), backend)
    if (legacy) {
      const backups = await readdir(join(config, "backups"))
      assert.equal(backups.length, 1)
      for (const [path, content] of Object.entries(originals)) {
        assert.equal(await readFile(join(config, "backups", backups[0], path), "utf8"), content)
      }
      await writeFile(join(agents, "claude-code.md"), "legacy leftover")
    } else {
      await assert.rejects(readdir(join(config, "backups")), { code: "ENOENT" })
    }

    await run("uninstall", ["--remove-plugin"])
    assert.deepEqual(await readdir(agents), ["unrelated.md"])
    assert.deepEqual(await readdir(commands), [])
    assert.equal(await readFile(join(agents, "unrelated.md"), "utf8"), "untouched agent")
    assert.equal(await readFile(join(plugin, "package.json"), "utf8"), backend)
  })
}

test("native installers reuse a Switchboard plugin configured by path instead of installing a second copy", async (t) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const config = await mkdtemp("/tmp/opencode/native-configured-backend-")
  t.after(() => rm(config, { recursive: true, force: true }))
  const checkout = "/home/example/github/switchboard"
  await writeFile(join(config, "opencode.json"), JSON.stringify({
    plugins: ["@example/other@1.0.0", { package: checkout, options: {} }],
    permissions: [{ action: "switchboard_delegate", resource: "*", effect: "allow" }],
  }))
  for (const [integration, expected] of [
    ["claude-native", /using existing Switchboard backend: \/home\/example\/github\/switchboard/],
    ["antigravity-native", /using configured Switchboard backend: \/home\/example\/github\/switchboard/],
  ]) {
    const { stdout } = await exec("bash", [
      fileURLToPath(new URL(`../integrations/${integration}/install.sh`, import.meta.url)),
    ], { env: { ...process.env, HOME: config, OPENCODE_CONFIG_DIR: config }, timeout: 10_000 })
    assert.match(stdout, expected)
    assert.deepEqual(await readdir(join(config, "plugins")), [], `${integration} installed a duplicate backend`)
  }
})
