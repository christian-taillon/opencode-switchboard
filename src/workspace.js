import path from "node:path"
import { realpath, stat } from "node:fs/promises"

const writers = new Map()

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  )
}

async function directoryPath(directory) {
  const resolved = await realpath(directory)
  if (!(await stat(resolved)).isDirectory()) {
    throw new Error(`workingDirectory is not a directory: ${resolved}`)
  }
  return resolved
}

export async function resolveWorkingDirectory(projectRoot, requested) {
  const root = await directoryPath(projectRoot)
  if (requested === undefined || requested === null || requested === "") return root

  const raw = path.isAbsolute(requested) ? requested : path.resolve(root, requested)
  const resolved = await directoryPath(raw)
  if (!isWithin(root, resolved)) {
    throw new Error(`workingDirectory must stay inside the OpenCode project: ${root}`)
  }
  return resolved
}

export async function resolveWorkspace(session, requested) {
  const directory = session?.location?.directory
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw new Error("calling session has no absolute workspace directory")
  }
  const root = await directoryPath(directory)
  const cwd = await resolveWorkingDirectory(root, requested ?? session.subpath)

  for (let candidate = cwd; ; candidate = path.dirname(candidate)) {
    try {
      const marker = await stat(path.join(candidate, ".git"))
      if (marker.isDirectory() || marker.isFile()) return { cwd, lockDirectory: candidate }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error
    }
    if (path.dirname(candidate) === candidate) break
  }
  return { cwd, lockDirectory: root }
}

export function acquireWorkspaceLock(directory, harness) {
  for (const [activeDirectory, active] of writers) {
    if (!isWithin(directory, activeDirectory) && !isWithin(activeDirectory, directory)) continue
    const error = new Error(`another mutating Switchboard delegation is already running in ${activeDirectory}`)
    error.activeHarness = active.harness
    throw error
  }
  const owner = { harness }
  writers.set(directory, owner)
  return () => {
    if (writers.get(directory) === owner) writers.delete(directory)
  }
}
