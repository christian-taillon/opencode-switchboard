import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { acquireWorkspaceLock, resolveWorkspace, resolveWorkingDirectory } from "../src/workspace.js"

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

test("session workspace and subpath determine cwd, with a checkout-wide lock directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchboard-session-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const nested = path.join(root, "src")
  await mkdir(nested)
  await mkdir(path.join(root, ".git"))
  const session = { location: { directory: root }, subpath: "src" }

  assert.deepEqual(await resolveWorkspace(session), { cwd: nested, lockDirectory: root })
  assert.deepEqual(await resolveWorkspace(session, "."), { cwd: root, lockDirectory: root })
  assert.deepEqual(await resolveWorkspace({ location: { directory: nested } }), { cwd: nested, lockDirectory: root })
})

test("workspace validation rejects missing locations, files, and symlink escapes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchboard-boundary-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, "workspace")
  const outside = path.join(root, "outside")
  await mkdir(workspace)
  await mkdir(outside)
  await symlink(outside, path.join(workspace, "escape"))
  await writeFile(path.join(workspace, "file"), "not a directory")
  await mkdir(path.join(workspace, "..allowed"))
  const session = { location: { directory: workspace } }

  await assert.rejects(() => resolveWorkspace({}), /no absolute workspace/)
  await assert.rejects(() => resolveWorkspace({ location: { directory: "." } }), /no absolute workspace/)
  await assert.rejects(() => resolveWorkspace(session, "file"), /not a directory/)
  await assert.rejects(() => resolveWorkspace(session, "escape"), /must stay inside/)
  await assert.rejects(() => resolveWorkspace({ ...session, subpath: "../outside" }), /must stay inside/)
  assert.equal((await resolveWorkspace(session, "..allowed")).cwd, path.join(workspace, "..allowed"))
})

test("linked worktrees lock independently, while aliases resolve to the same checkout", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchboard-worktrees-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const checkout = path.join(root, "checkout")
  const worktree = path.join(root, "worktree")
  const alias = path.join(root, "alias")
  await mkdir(checkout)
  await mkdir(path.join(checkout, ".git"))
  await mkdir(worktree)
  await writeFile(path.join(worktree, ".git"), `gitdir: ${checkout}/.git/worktrees/task\n`)
  await symlink(checkout, alias)

  assert.equal((await resolveWorkspace({ location: { directory: alias } })).lockDirectory, checkout)
  assert.equal((await resolveWorkspace({ location: { directory: worktree } })).lockDirectory, worktree)
  const release = acquireWorkspaceLock(checkout, "antigravity")
  t.after(release)
  const releaseWorktree = acquireWorkspaceLock(worktree, "claude")
  releaseWorktree()
})

test("non-Git workspaces lock their root and overlapping writers are rejected", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchboard-lock-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const nested = path.join(root, "src")
  await mkdir(nested)
  assert.deepEqual(await resolveWorkspace({ location: { directory: root } }, "src"), {
    cwd: nested,
    lockDirectory: root,
  })
  const release = acquireWorkspaceLock(nested, "antigravity")
  t.after(release)
  for (const directory of [root, nested, path.join(nested, "deeper")]) {
    assert.throws(() => acquireWorkspaceLock(directory, "claude"), (error) => {
      assert.equal(error.activeHarness, "antigravity")
      assert.match(error.message, /already running/)
      return true
    })
  }
  release()
  const next = acquireWorkspaceLock(root, "claude")
  release()
  assert.throws(() => acquireWorkspaceLock(nested, "antigravity"), /already running/)
  next()
})
