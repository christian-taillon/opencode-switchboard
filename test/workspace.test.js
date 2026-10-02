import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { resolveWorkingDirectory } from "../src/workspace.js"

test("working directory may be project root or a real subdirectory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchboard-workspace-"))
  const nested = path.join(root, "src")
  await mkdir(nested)

  try {
    assert.equal(await resolveWorkingDirectory(root), root)
    assert.equal(await resolveWorkingDirectory(root, "src"), nested)
    assert.equal(await resolveWorkingDirectory(root, nested), nested)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("working directory may not escape project root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchboard-root-"))
  const outside = await mkdtemp(path.join(os.tmpdir(), "switchboard-outside-"))

  try {
    await assert.rejects(
      () => resolveWorkingDirectory(root, outside),
      /must stay inside the OpenCode project/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
