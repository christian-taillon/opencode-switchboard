let buffer = ""
let pendingPrompt
let conversation = "mock-conversation"
const scenario = process.argv[2] ?? "legacy"
if (["bad-after-init", "permission-after-stop"].includes(scenario)) process.on("SIGTERM", () => setTimeout(() => process.exit(0), 100))
const editMode = ["native", "unacknowledged-mode"].includes(scenario) ? "accept-edits" : "auto_edit"
let currentMode = "default"
const configs = [
  { id: "mode", currentValue: currentMode, options: [{ value: scenario === "unsupported-mode" ? "yolo" : editMode }, { value: "default" }] },
  { id: "model", options: [{ value: "test-model" }] },
  { id: "thought_level", options: [{ value: "medium" }] },
]
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
const result = (id, body) => send({ id, result: body })
function update(content) {
  send({ method: "session/update", params: { sessionId: conversation, update: content } })
}
function finish(text) {
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } })
  result(pendingPrompt, { stopReason: "end_turn" })
}
function handle(message) {
  const { id, method, params } = message
  if (method === "initialize") {
    if (scenario === "bad-stdout") return process.stdout.write("Refresh failed (fixture)\n")
    if (scenario === "bad-after-init") return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: 1 } }) + "\nRefresh failed (fixture)\n")
    if (scenario === "exit-before-init") return process.exit(23)
    return result(id, { protocolVersion: 1, authMethods: [{ id: "oauth-personal", name: "Log in with Google" }] })
  }
  if (method === "session/new") {
    if (scenario === "bad-after-init") process.stderr.write("Unexpected session/new after malformed stdout\n")
    if (scenario === "auth-required") return send({ id, error: { code: -32000, message: "Authentication required" } })
    if (scenario === "legacy-modes") return result(id, {
      sessionId: conversation,
      modes: { currentModeId: currentMode, availableModes: [{ id: "default" }, { id: editMode }] },
    })
    return result(id, { sessionId: conversation, configOptions: configs })
  }
  if (method === "session/load") {
    conversation = params.sessionId
    return result(id, { configOptions: configs })
  }
  if (method === "session/set_config_option") {
    if (scenario !== "unacknowledged-mode") {
      const config = configs.find((item) => item.id === params.configId)
      config.currentValue = params.value
      if (params.configId === "mode") currentMode = params.value
    }
    return result(id, { configOptions: configs })
  }
  if (method === "session/set_mode") {
    currentMode = params.modeId
    return result(id, {})
  }
  if (method === "session/prompt") {
    pendingPrompt = id
    if (currentMode !== editMode) return send({ id, error: { code: -32000, message: "Edit mode not selected" } })
    if (scenario === "large-stderr") return process.stderr.write("x".repeat(65537), () => finish("completed"))
    if (scenario === "permission-after-stop") return process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: "permission-one",
      method: "session/request_permission",
      params: {
        sessionId: conversation,
        toolCall: { kind: "edit", title: "Pending edit", locations: [{ path: process.cwd() + "/example.js" }] },
        options: [{ kind: "allow_once", optionId: "yes" }],
      },
    }) + "\nRefresh failed (fixture)\n")
    const text = params.prompt[0].text
    if (text === "hang") return
    if (text.startsWith("approve ")) {
      send({
        id: "permission-one",
        method: "session/request_permission",
        params: {
          sessionId: conversation,
          toolCall: {
            kind: text.includes("edit") ? "edit" : "execute",
            title: "Test tool",
            locations: [{ path: process.cwd() + "/example.js" }],
            rawInput: { command: "pnpm test" },
          },
          options: [{ kind: "allow_once", optionId: "yes" }],
        },
      })
      return
    }
    return finish("completed")
  }
  if (id === "permission-one") {
    if (scenario === "permission-after-stop") {
      if (message.result?.outcome?.outcome === "selected") process.stderr.write("Unexpected permission approval after stop\n")
      return
    }
    return finish(message.result?.outcome?.outcome === "selected" ? "approved" : "denied")
  }
}
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString()
  for (;;) {
    const eol = buffer.indexOf("\n")
    if (eol < 0) break
    const line = buffer.slice(0, eol)
    buffer = buffer.slice(eol + 1)
    if (line.trim()) handle(JSON.parse(line))
  }
})
