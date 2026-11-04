let buffer = ""
let pendingPrompt
let conversation = "mock-conversation"
const configs = [
  { id: "mode", options: [{ value: "auto_edit" }, { value: "default" }] },
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
  if (method === "initialize") return result(id, { protocolVersion: 1 })
  if (method === "session/new") return result(id, { sessionId: conversation, configOptions: configs })
  if (method === "session/load") {
    conversation = params.sessionId
    return result(id, { configOptions: configs })
  }
  if (method === "session/set_config_option") return result(id, { configOptions: configs })
  if (method === "session/prompt") {
    pendingPrompt = id
    const text = params.prompt[0].text
    if (text.includes("hang")) return
    if (text.includes("approve")) {
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
