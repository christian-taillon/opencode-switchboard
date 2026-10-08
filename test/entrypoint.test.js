import test from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Skill } from "@opencode/plugin"
import plugin from "../index.js"
import sourcePlugin from "../src/index.js"

test("local discovery and package exports load the same Switchboard plugin", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))

  assert.equal(plugin, sourcePlugin)
  assert.equal(plugin.id, "switchboard")
  assert.equal(typeof plugin.setup, "function")
  assert.equal(manifest.exports["."], "./index.js")
  assert.ok(manifest.files.includes("index.js"))
})

test("setup registers a schema-valid skill and both tools", async () => {
  let skill
  const tools = []
  await plugin.setup({
    options: {},
    location: { directory: process.cwd() },
    skill: {
      transform: async (callback) => callback({
        add: (definition) => { skill = Skill.Info.make(definition) },
      }),
    },
    tool: {
      transform: async (callback) => callback({
        namespace: () => {},
        add: (definition) => tools.push(definition),
      }),
    },
  })

  assert.equal(skill.id, "switchboard")
  assert.equal(skill.path, fileURLToPath(new URL("../skills/switchboard/SKILL.md", import.meta.url)))
  assert.ok(skill.content.startsWith("# Switchboard"))
  assert.equal(skill.autoinvoke, true)
  assert.deepEqual(tools.map((tool) => tool.name), ["harnesses", "delegate"])
  assert.equal(tools.find((tool) => tool.name === "delegate").input.properties.effort.type, "string")
})

test("delegate fails closed on Antigravity denials and empty success, retaining diagnostics", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "switchboard-result-"))
  try {
    const command = path.join(directory, "agy-fixture")
    let delegate
    await plugin.setup({
      options: { harnesses: { antigravity: { command } } },
      location: { directory },
      skill: { transform: async (callback) => callback({ add: () => {} }) },
      tool: {
        transform: async (callback) => callback({
          namespace: () => {},
          add: (tool) => { if (tool.name === "delegate") delegate = tool },
        }),
      },
    })
    const deniedActions = [{ action: "read_url", display_name: "ReadUrlContent" }]
    const cases = [
      { status: "SUCCESS", response: "", denied_actions: deniedActions },
      { status: "SUCCESS", response: "" },
      { status: "SUCCESS", response: "done" },
    ]
    for (const value of cases) {
      const notice = value.denied_actions
        ? "no output produced: read_url was auto-denied in headless mode" : "fixture diagnostic"
      const stdout = JSON.stringify({ ...value, conversation_id: "agy-fixture-session" })
      await writeFile(command, `#!${process.execPath}
const args = process.argv.slice(2)
if (args[args.indexOf('--model') + 1] !== 'gemini-3.8-flash-medium' ||
    args[args.indexOf('--effort') + 1] !== 'medium') process.exit(1)
process.stdout.write(${JSON.stringify(stdout)})
process.stderr.write(${JSON.stringify(notice)})
`)
      await chmod(command, 0o700)
      const output = await delegate.execute({
        harness: "antigravity", prompt: "fixture", mode: "plan", model: "gemini-3.8-flash-medium", effort: "medium",
      }, {
        progress: async () => {},
      })
      const result = JSON.parse(output.content)
      assert.equal(result.exitCode, 0)
      assert.equal(result.requestedModel, "gemini-3.8-flash-medium")
      assert.equal(result.requestedEffort, "medium")
      assert.equal(result.sessionID, "agy-fixture-session")
      assert.equal(result.providerStatus, "SUCCESS")
      assert.equal(result.stderr, notice)
      if (value.response === "") {
        assert.equal(result.status, "failed")
        assert.match(result.protocolError, /nonempty response/)
        assert.equal(result.rawOutput, stdout)
        if (value.denied_actions) {
          assert.deepEqual(result.deniedActions, deniedActions)
          assert.match(result.error, /read_url.*scoped permissions.allow/)
        } else {
          assert.equal(result.error, result.protocolError)
        }
      } else {
        assert.equal(result.status, "completed")
        assert.equal(result.response, "done")
        assert.equal(result.error, undefined)
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
