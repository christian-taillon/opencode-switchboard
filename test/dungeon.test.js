import test from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import path from "node:path"
import os from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import plugin from "../index.js"
import { DungeonOutput, dungeonAdmissionPath, dungeonKey, persistDungeonSession, runDungeonGuarded } from "../src/dungeon.js"
import { runProcess } from "../src/runner.js"
import { normalizeOptions } from "../src/config.js"

const started = { schema: 1, operation: "exec", seq: 0, event: "started", sandbox_id: "guest-id" }
const terminal = { schema: 1, operation: "exec", seq: 2, event: "finished", ok: true, exit_code: 0, error: null, cleanup: "confirmed", primary_transport_verified: true }
const output = (bytes) => ({ schema: 1, operation: "exec", seq: 1, event: "output", stream: "stdout", encoding: "base64", data: Buffer.from(bytes).toString("base64") })
const execution = { status: "completed", exitCode: 0, stdout: "", stderr: "", forcedTermination: false }
const encode = (events) => Buffer.from(events.map((event) => JSON.stringify(event) + "\n").join(""))

test("Dungeon decoder preserves fragmented bytes, caps retained output and verifies both completion layers", () => {
  const decoder = new DungeonOutput("guest-id", 3)
  const bytes = encode([started, output([0, 255, 10, 33]), terminal])
  for (const byte of bytes) decoder.feed(Buffer.from([byte]))
  const result = decoder.finish(execution)
  assert.equal(result.status, "completed")
  assert.equal(result.stdout, Buffer.from([0, 255, 10]).toString("utf8"))
  assert.equal(result.stdoutTruncated, true)
  assert.equal(result.dungeon.cleanup, "confirmed")
  assert.equal(decoder.finish({ ...execution, exitCode: 1 }).dungeon.cleanup, "unconfirmed")
  for (const events of [
    [started, { ...output("x"), seq: 9 }, terminal],
    [{ ...started, sandbox_id: "wrong" }, output("x"), terminal],
    [output("x"), terminal],
    [started, { ...output("x"), data: "AP9=" }, terminal],
    [started, output("x"), { ...terminal, cleanup: undefined }],
    [started, output("x"), { ...terminal, primary_transport_verified: undefined }],
    [started, output("x"), { ...terminal, primary_transport_verified: false }],
    [started, { ...terminal, seq: 1, ok: false, exit_code: null, cleanup: "not_started", error: { code: "operation_failed", effects: "unknown" } }],
    [{ ...terminal, seq: 0, ok: false, exit_code: null, cleanup: "confirmed", error: { code: "operation_failed", effects: "unknown" } }],
    [{ ...terminal, seq: 0, ok: false, exit_code: null, cleanup: "not_started", error: { code: "operation_failed", effects: "unknown" } }],
    [started, output("x"), terminal, terminal],
  ]) {
    const invalid = new DungeonOutput("guest-id", 1024)
    assert.throws(() => invalid.feed(encode(events)))
    assert.equal(invalid.finish(execution).dungeon.cleanup, "unconfirmed")
  }
  for (const bytes of [Buffer.from('{"schema":1,"schema":1}\n'), Buffer.alloc(65537, 120), Buffer.from([255,10])]) {
    assert.throws(() => new DungeonOutput("guest-id", 1024).feed(bytes))
  }
  const missing = new DungeonOutput("guest-id", 1024)
  missing.feed(encode([started, output("x")]))
  assert.equal(missing.finish(execution).status, "failed")
  missing.feed(Buffer.from('{"event":'))
  assert.match(missing.finish(execution).error, /inside an event/)
  const transport = new DungeonOutput("guest-id", 1024)
  transport.feed(encode([started, { ...terminal, seq: 1, ok: false, exit_code: null, error: { code: "operation_failed", effects: "unknown" }, cleanup: "unconfirmed", primary_transport_verified: false }]))
  assert.equal(transport.finish({ ...execution, status: "failed", exitCode: 1 }).dungeon.cleanup, "unconfirmed")
  const refused = new DungeonOutput("guest-id", 1024)
  refused.feed(encode([{ schema: 1, operation: "exec", ok: false, error: { code: "operation_failed", effects: "none" } }]))
  assert.equal(refused.finish({ ...execution, status: "failed", exitCode: 1 }).dungeon.cleanup, "not_started")
  const uncertain = new DungeonOutput("guest-id", 1024)
  uncertain.feed(encode([{ schema: 1, operation: "exec", ok: false, error: { code: "operation_failed", effects: "unknown" } }]))
  assert.equal(uncertain.finish({ ...execution, status: "failed", exitCode: 1 }).dungeon.cleanup, "unconfirmed")
  const trailing = new DungeonOutput("guest-id", 1024)
  trailing.feed(Buffer.concat([bytes, Buffer.from("{")]))
  assert.equal(trailing.finish(execution).dungeon.cleanup, "unconfirmed")
})

test("Dungeon profiles reject implicit launchers, relative configs and mixed argument authority", () => {
  const valid = { type: "dungeon", approved: true, command: "/trusted/dungeon", config: "/private/dungeon.json" }
  assert.deepEqual(normalizeOptions({ executionProfiles: { isolated: valid } }).executionProfiles.isolated, valid)
  for (const profile of [{ ...valid, config: "relative" }, { ...valid, args: [] }, { ...valid, type: "other" }, { ...valid, config: null }]) {
    assert.throws(() => normalizeOptions({ executionProfiles: { isolated: profile } }), /malformed/)
  }
})

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "switchboard-dungeon-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = path.join(root, "project")
  await mkdir(project)
  await mkdir(path.join(project, "sub"))
  const config = path.join(root, "dungeon.json")
  const command = path.join(root, "dungeon-fixture")
  const scenarioPath = path.join(root, "scenario.json")
  const calls = path.join(root, "calls.jsonl")
  const ready = path.join(root, "ready")
  await writeFile(config, "{}")
  const scenario = { project, config, sandboxID: "guest-id", fingerprint: "fingerprint", baseline: true, phase: "ready", pending: false }
  const update = async (value = {}) => writeFile(scenarioPath, JSON.stringify({ ...scenario, ...value }))
  await update()
  await writeFile(command, `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);const s=JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath)}));
const op=args[args.indexOf('--schema')+2];fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({op,args})+'\\n');
if(op==='status') { console.log(JSON.stringify({schema:1,operation:'status',ok:true,result:{bound:true,phase:s.phase,identity:'verified',policy:'verified',initial_upload_pending:s.pending,copy_baseline_valid:s.baseline,environment:{config:s.config,project:s.project,sandbox_id:s.sandboxID,fingerprint:s.fingerprint,project_transfer:'copy',execution_location:'local',guest_project:'/sandbox/project'}}}));process.exit(0) }
if(s.refusal) {console.log(JSON.stringify({schema:1,operation:'exec',ok:false,error:{code:'operation_failed',message:'Prelaunch refusal',effects:'none'}}));process.exit(1)}
let seq=0;const emit=v=>console.log(JSON.stringify({schema:1,operation:'exec',seq:seq++,...v}));
emit({event:'started',sandbox_id:s.sandboxID});
const discovery=args[args.indexOf('--')+1]==='/usr/bin/node';
if(s.transportFailure) {emit({event:'finished',ok:false,exit_code:null,error:{code:'operation_failed',message:'Primary transport failed',effects:'unknown'},cleanup:'unconfirmed',primary_transport_verified:false});process.exit(1)}
if(s.hold&&!discovery) {process.stdout.write('');setInterval(()=>{},1000);process.on('SIGTERM',()=>{emit({event:'finished',ok:false,exit_code:null,error:{code:'operation_failed',effects:'unknown'},cleanup:'confirmed',primary_transport_verified:true});process.exit(1)});fs.writeFileSync(${JSON.stringify(ready)},'ready');}
else { const response=discovery?JSON.stringify({available:true}):JSON.stringify({type:'result',subtype:'success',session_id:s.sessionID??'vendor-session',result:'guest response',permission_denials:s.denied?[{tool_name:'Bash'}]:[]});emit({event:'output',stream:'stdout',encoding:'base64',data:Buffer.from(response).toString('base64')});if(!s.broken)emit({event:'finished',ok:true,exit_code:0,error:null,cleanup:'confirmed',primary_transport_verified:true}); }
`)
  await chmod(command, 0o700)
  const data = new Map()
  const storage = { get: async (key) => data.get(key), set: async (key, value) => data.set(key, value), remove: async (key) => data.delete(key) }
  let tools
  const setup = async (overrides = {}) => {
    tools = {}
    await plugin.setup({
      options: { executionProfiles: { isolated: { type: "dungeon", approved: true, command, config } },
        harnesses: { claude: { command: "vendor-only-in-guest", executionProfile: "isolated" }, antigravity: { enabled: false }, gemini: { enabled: false }, codex: { enabled: false } } },
      session: { get: async () => ({ location: { directory: project } }) }, storage,
      skill: { transform: async (fn) => fn({ add() {} }) },
      tool: { transform: async (fn) => fn({ namespace() {}, add(tool) { tools[tool.name] = tool } }) },
      ...overrides,
    })
  }
  await setup()
  const context = { sessionID: "ses_fixture", progress: async () => {} }
  const delegate = async (input = {}, extra = {}) => JSON.parse((await tools.delegate.execute({ harness: "claude", prompt: "synthetic task", mode: "plan", ...input }, { ...context, ...extra })).content)
  return { project, config, command, data, update, setup, delegate, calls, ready, discover: async () => JSON.parse((await tools.harnesses.execute({}, context)).content) }
}

test("Dungeon runs guest-only executables, maps cwd, retains denials and persists resume across plugin setup", async (t) => {
  const f = await fixture(t)
  assert.equal((await f.discover()).harnesses[1].available, true)
  const result = await f.delegate({ workingDirectory: "sub" })
  assert.equal(result.status, "completed")
  assert.equal(result.sessionID, "vendor-session")
  assert.equal(result.dungeon.guestCwd, "/sandbox/project/sub")
  assert.equal(result.dungeon.hostChangesApplied, false)
  assert.equal(result.dungeon.cleanup, "confirmed")
  assert.ok(f.data.has(dungeonKey("session", ["claude", "vendor-session"])))
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map(JSON.parse)
  const args = calls.findLast((call) => call.op === "exec").args
  assert.equal(args[args.indexOf("--") + 1], "vendor-only-in-guest")
  assert.equal(args[args.indexOf("--cwd") + 1], "/sandbox/project/sub")
  await f.setup()
  assert.equal((await f.delegate({ workingDirectory: "sub", sessionID: "vendor-session" })).status, "completed")
  for (const input of [{ sessionID: "unknown" }, { sessionID: "vendor-session" }]) {
    assert.match((await f.delegate(input)).error, /resume session/)
  }
  await f.update({ sandboxID: "replacement" })
  assert.match((await f.delegate({ sessionID: "vendor-session", workingDirectory: "sub" })).error, /resume session/)
  await f.update()
  const collision = await f.delegate()
  assert.equal(collision.status, "failed")
  assert.equal(collision.sessionID, undefined)
  assert.equal(f.data.get(dungeonKey("session", ["claude", "vendor-session"])).guestCwd, "/sandbox/project/sub")
  await f.update({ denied: true, sessionID: "denied-session" })
  const denied = await f.delegate()
  assert.equal(denied.status, "failed")
  assert.equal(denied.dungeon.cleanup, "confirmed")
  assert.equal(denied.deniedActions[0].tool_name, "Bash")
  await f.update({ sessionID: "unpersisted-session" })
  await f.setup({ storage: { get: async () => undefined, set: async () => { throw new Error("storage unavailable") } } })
  const unpersisted = await f.delegate()
  assert.equal(unpersisted.status, "failed")
  assert.equal(unpersisted.sessionID, undefined)
  assert.match(unpersisted.error, /could not be persisted/)
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  const data = new Map()
  const storage = { get: async () => { await waiting; return undefined }, set: async (key, value) => data.set(key, value) }
  const binding = { config: f.config, project: f.project, fingerprint: "fingerprint", sandboxID: "guest-id", guestCwd: "/sandbox/project/sub" }
  const first = persistDungeonSession(storage, { id: "claude" }, binding, "simultaneous-session")
  await assert.rejects(persistDungeonSession(storage, { id: "claude" }, { ...binding, guestCwd: "/sandbox/project" }, "simultaneous-session"), /already being persisted/)
  release()
  await first
  assert.equal(data.get(dungeonKey("session", ["claude", "simultaneous-session"])).guestCwd, "/sandbox/project/sub")
})

test("Dungeon admission refuses unuploaded/pending/wrong scope and blocks reuse after uncertain completion", async (t) => {
  const f = await fixture(t)
  for (const scenario of [{ baseline: false }, { pending: true }, { phase: "stopped" }, { project: path.dirname(f.project) }]) {
    await f.update(scenario)
    assert.equal((await f.delegate()).status, "failed")
  }
  assert.ok(!(await readFile(f.calls, "utf8")).includes('"op":"exec"'))
  await f.update({ refusal: true })
  assert.equal((await f.delegate()).dungeon.cleanup, "not_started")
  await f.update({ broken: true })
  const failed = await f.delegate()
  assert.equal(failed.status, "failed")
  assert.equal(failed.dungeon.cleanup, "unconfirmed")
  assert.equal(failed.sessionID, undefined)
  assert.ok(!f.data.has(dungeonKey("session", ["claude", "vendor-session"])))
  await f.update()
  await f.setup()
  assert.match((await f.delegate()).error, /admission is blocked/)
  const crashed = await fixture(t)
  const record = dungeonAdmissionPath({ sandboxID: "guest-id", config: crashed.config })
  const crash = spawn(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(record)},'interrupted invocation',{flag:'wx',mode:0o600});process.exit(1)`])
  assert.equal(await new Promise((resolve) => crash.on("close", resolve)), 1)
  await crashed.setup()
  assert.match((await crashed.delegate()).error, /admission is blocked/)
  assert.equal(await readFile(record, "utf8"), "interrupted invocation")
})

test("Dungeon admission is exclusive across processes and retains primary-transport uncertainty", async (t) => {
  const f = await fixture(t)
  await f.update({ hold: true })
  const binding = { command: f.command, config: f.config, project: f.project, sandboxID: "guest-id", fingerprint: "fingerprint", guestCwd: "/sandbox/project" }
  const input = { harness: { id: "claude" }, binding, args: ["guest-command"], timeoutMs: 30000, maxOutputBytes: 1024 }
  const worker = spawn(process.execPath, ["--input-type=module", "-e", `
import { runDungeonGuarded } from ${JSON.stringify(new URL("../src/dungeon.js", import.meta.url).href)};
const controller=new AbortController();process.on('SIGTERM',()=>controller.abort());
const result=await runDungeonGuarded({...${JSON.stringify(input)},signal:controller.signal});console.log(JSON.stringify(result));
`], { stdio: ["ignore", "pipe", "pipe"] })
  const stdout = []
  const stderr = []
  worker.stdout.on("data", (chunk) => stdout.push(chunk))
  worker.stderr.on("data", (chunk) => stderr.push(chunk))
  const closed = new Promise((resolve) => worker.on("close", resolve))
  t.after(async () => { worker.kill("SIGTERM"); await closed })
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    try { if ((await readFile(f.ready, "utf8")) === "ready") break } catch {}
    await delay(10)
  }
  assert.equal(await readFile(f.ready, "utf8"), "ready")
  assert.match((await f.delegate()).error, /admission is blocked/)
  worker.kill("SIGTERM")
  assert.equal(await closed, 0, Buffer.concat(stderr).toString())
  assert.equal(JSON.parse(Buffer.concat(stdout).toString()).dungeon.cleanup, "confirmed")
  await assert.rejects(readFile(dungeonAdmissionPath(binding)), { code: "ENOENT" })
  await f.update({ transportFailure: true })
  assert.equal((await f.delegate()).dungeon.cleanup, "unconfirmed")
  assert.equal(JSON.parse(await readFile(dungeonAdmissionPath(binding))).state, "running_or_cleanup_unconfirmed")
  await f.update()
  await f.setup()
  assert.match((await f.delegate()).error, /admission is blocked/)
})

test("Dungeon known pre-spawn failures and pre-abort do not retain admission", async (t) => {
  const f = await fixture(t)
  const nul = await f.delegate({ prompt: "task\0invalid" })
  assert.equal(nul.status, "failed")
  assert.equal(nul.dungeon.cleanup, "not_started")
  const binding = { command: path.join(f.project, "missing"), config: f.config, project: f.project, sandboxID: "guest-id" }
  const input = { harness: { id: "claude" }, binding, args: ["guest-command"], timeoutMs: 1000, maxOutputBytes: 1024 }
  assert.equal((await runDungeonGuarded(input)).dungeon.cleanup, "not_started")
  const controller = new AbortController()
  controller.abort()
  const aborted = await runDungeonGuarded({ ...input, signal: controller.signal })
  assert.equal(aborted.status, "aborted")
  assert.equal(aborted.dungeon.cleanup, "not_started")
  await assert.rejects(readFile(dungeonAdmissionPath(binding)), { code: "ENOENT" })
  assert.equal((await f.delegate()).status, "completed")
})

test("Dungeon serializes plan calls and confirmed cancellation permits later reuse", async (t) => {
  const f = await fixture(t)
  await f.update({ hold: true })
  const controller = new AbortController()
  const running = f.delegate({}, { signal: controller.signal })
  t.after(async () => { controller.abort(); await running })
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    try { if ((await readFile(f.ready, "utf8")) === "ready") break } catch {}
    await delay(10)
  }
  assert.equal(await readFile(f.ready, "utf8"), "ready")
  assert.match((await f.delegate()).error, /already running/)
  controller.abort()
  const cancelled = await running
  assert.equal(cancelled.status, "aborted")
  assert.equal(cancelled.dungeon.cleanup, "confirmed")
  await f.update()
  assert.equal((await f.delegate()).status, "completed")
})

test("leader cancellation waits for cleanup rather than group-killing its helper", async () => {
  const result = await runProcess({ command: process.execPath, args: ["-e", `
const {spawn}=require('node:child_process');const helper=spawn(process.execPath,['-e','setTimeout(()=>console.log("helper survived TERM"),800)'],{stdio:['ignore','inherit','inherit']});
process.on('SIGTERM',()=>helper.once('exit',()=>process.exit(1)));setInterval(()=>{},1000);
`], timeoutMs: 300, maxOutputBytes: 1024, terminationTarget: "leader", terminationGraceMs: 1500 })
  assert.equal(result.status, "timeout")
  assert.match(result.stdout, /helper survived TERM/)
  assert.equal(result.forcedTermination, false)
  const forced = await runProcess({ command: process.execPath, args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], timeoutMs: 200,
    maxOutputBytes: 1024, terminationTarget: "leader", terminationGraceMs: 100 })
  assert.equal(forced.forcedTermination, true)
  assert.equal(forced.status, "timeout")
  const exited = await runProcess({ command: process.execPath, args: ["-e", `
const {spawn}=require('node:child_process');
process.on('SIGTERM',()=>{spawn(process.execPath,['-e','setTimeout(()=>console.log("helper tail"),700)'],{stdio:['ignore','inherit','inherit']});setTimeout(()=>process.exit(1),100)});setInterval(()=>{},1000);
`], timeoutMs: 200, maxOutputBytes: 1024, terminationTarget: "leader", terminationGraceMs: 300 })
  assert.equal(exited.exitCode, 1)
  assert.equal(exited.forcedTermination, false)
  assert.match(exited.stdout, /helper tail/)
  const retained = await runProcess({ command: process.execPath, args: ["-e", `
require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},2400)'],{stdio:['ignore','inherit','inherit']});process.exit(1);
`], timeoutMs: 5000, maxOutputBytes: 1024, terminationTarget: "leader" })
  assert.equal(retained.status, "failed")
  assert.equal(retained.exitCode, null)
  assert.match(retained.error, /output pipes did not close/)
})
