import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
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
})
