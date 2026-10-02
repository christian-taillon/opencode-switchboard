import path from "node:path"
import { realpath } from "node:fs/promises"

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export async function resolveWorkingDirectory(projectRoot, requested) {
  const root = await realpath(projectRoot)
  if (requested === undefined || requested === null || requested === "") return root

  const raw = path.isAbsolute(requested) ? requested : path.resolve(root, requested)
  const resolved = await realpath(raw)
  if (!isWithin(root, resolved)) {
    throw new Error(`workingDirectory must stay inside the OpenCode project: ${root}`)
  }
  return resolved
}
