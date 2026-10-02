import test from "node:test"
import assert from "node:assert/strict"
import { buildWorkerPrompt } from "../src/prompt.js"

test("worker prompt carries bounded execution discipline", () => {
  const result = buildWorkerPrompt("Fix the test", "edit")
  assert.match(result, /bounded external coding worker/)
  assert.match(result, /Do not widen scope/)
  assert.match(result, /Do not leave required work running in the background/)
  assert.match(result, /EXECUTION MODE: EDIT/)
  assert.match(result, /Fix the test$/)
})

test("worker prompt rejects empty input", () => {
  assert.throws(() => buildWorkerPrompt("  "), /must not be empty/)
})

test("plan worker prompt explicitly prohibits mutation", () => {
  const result = buildWorkerPrompt("Review the diff", "plan")
  assert.match(result, /EXECUTION MODE: PLAN/)
  assert.match(result, /Do not modify files/)
})
