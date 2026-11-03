import { Plugin } from "@opencode/plugin"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { normalizeOptions, resolveTimeoutSeconds } from "./config.js"
import {
  buildInvocation,
  getHarness,
  harnessDefinitions,
  parseHarnessOutput,
} from "./harnesses.js"
import { buildWorkerPrompt } from "./prompt.js"
import { findExecutable, runProcess, subprocessEnvironment } from "./runner.js"
import { acquireWorkspaceLock, resolveWorkspace } from "./workspace.js"
import { dungeonKey, GUEST_DISCOVERY, inspectDungeon, persistDungeonSession, resumeBinding, runDungeonGuarded, sameResumeBinding } from "./dungeon.js"
import {
  createModelCatalog,
  MODEL_LIST_MAX_OUTPUT_BYTES,
  MODEL_LIST_TIMEOUT_MS,
  modelsFromExecution,
  modelValidationError,
  resolveModelSelection,
  selectionReport,
} from "./models.js"

const SKILL_LOCATION = fileURLToPath(new URL("../skills/switchboard/SKILL.md", import.meta.url))

const AWARENESS =
  "External coding harnesses are available through Switchboard. When another harness would materially help, load the `switchboard` skill and follow its delegation, foreground, and external-session discipline. Treat Switchboard workers as bounded external subagents whose output must be inspected before acceptance."

function withoutFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) return markdown.trim()
  const end = markdown.indexOf("\n---\n", 4)
  if (end < 0) return markdown.trim()
  return markdown.slice(end + 5).trim()
}

function jsonContent(value) {
  return { content: JSON.stringify(value, null, 2) }
}

function failure(harness, error, extra = {}) {
  return jsonContent({
    status: "failed",
    harness,
    error,
    ...extra,
  })
}

export default Plugin.define({
  id: "switchboard",
  async setup(ctx) {
    const options = normalizeOptions(ctx.options)
    const skillMarkdown = await readFile(SKILL_LOCATION, "utf8")

    // Runs a short non-delegation harness subcommand (for example `agy models`)
    // through the same host, launcher-profile, or Dungeon path and environment
    // allowlist used for delegation, with a short timeout and small output cap.
    async function runAuxiliary(harness, args, context) {
      const limits = {
        timeoutMs: MODEL_LIST_TIMEOUT_MS,
        maxOutputBytes: Math.min(options.maxOutputBytes, MODEL_LIST_MAX_OUTPUT_BYTES),
        signal: context.signal,
      }
      const session = await ctx.session.get({ sessionID: context.sessionID })
      const workspace = await resolveWorkspace(session)
      if (harness.profile?.type === "dungeon") {
        const release = acquireWorkspaceLock(workspace.lockDirectory, harness.id)
        try {
          const binding = await inspectDungeon(harness, workspace, context.signal)
          return await runDungeonGuarded({ harness, binding, args: [harness.command, ...args], ...limits })
        } finally {
          release()
        }
      }
      const executable = await findExecutable(harness.command)
      if (!executable) throw new Error(`CLI executable not found: ${harness.command}`)
      let command = executable
      let launchArgs = [...args]
      if (harness.profile) {
        command = await findExecutable(harness.profile.command)
        if (!command) throw new Error(`execution profile launcher not found: ${harness.executionProfile}`)
        launchArgs = [...harness.profile.args.map((arg) => arg.replaceAll("{cwd}", workspace.cwd)), "--", executable, ...args]
      }
      return await runProcess({
        command,
        args: launchArgs,
        cwd: workspace.cwd,
        env: subprocessEnvironment(harness.envAllowlist),
        ...limits,
      })
    }

    const catalog = createModelCatalog({
      list: async (harness, context) => modelsFromExecution(harness, await runAuxiliary(harness, harness.modelListArgs, context)),
    })

    await ctx.skill.transform((editor) => {
      editor.add({
        id: "switchboard",
        name: "Switchboard",
        description:
          "Delegate bounded coding, investigation, or review work to external CLI harnesses while keeping OpenCode as the parent control plane.",
        path: SKILL_LOCATION,
        content: withoutFrontmatter(skillMarkdown),
        autoinvoke: true,
      })
    })

    if (options.awareAgents.length > 0) {
      await ctx.agent.transform((editor) => {
        for (const agentID of options.awareAgents) {
          if (!editor.get(agentID)) continue
          editor.update(agentID, (agent) => {
            if (agent.system !== undefined && typeof agent.system !== "string") return
            const current = agent.system ?? ""
            if (!current.includes(AWARENESS)) {
              agent.system = current ? `${current}\n\n${AWARENESS}` : AWARENESS
            }
          })
        }
      })
    }

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "switchboard",
        description:
          "Run bounded external coding harness workers in the foreground and return normalized results to the OpenCode parent.",
      })

      editor.add({
        name: "harnesses",
        description:
          "List Switchboard harnesses and check executable availability on the host or in the configured Dungeon guest. Guest discovery requires an already Ready approved environment. Use this before delegation when availability is uncertain.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        options: { namespace: "switchboard", codemode: true },
        execute: async (_input, context) => {
          await context.progress({ status: "Checking external coding harnesses" })
          const rows = []
          for (const definition of harnessDefinitions(options)) {
            const row = { ...definition, available: false }
            let release
            try {
              const harness = getHarness(definition.id, options)
              if (harness.profile?.type !== "dungeon") row.available = Boolean(await findExecutable(harness.command))
              else {
                const session = await ctx.session.get({ sessionID: context.sessionID })
                const workspace = await resolveWorkspace(session)
                release = acquireWorkspaceLock(workspace.lockDirectory, harness.id)
                const binding = await inspectDungeon(harness, workspace, context.signal)
                const result = await runDungeonGuarded({ harness, binding,
                  args: ["/usr/bin/node", "-e", GUEST_DISCOVERY, "--", harness.command],
                  timeoutMs: 10000, maxOutputBytes: 1024, signal: context.signal })
                row.availabilityScope = "guest"
                row.available = result.status === "completed" && !result.outputTruncated && JSON.parse(result.stdout).available === true
                row.error = result.error
              }
            } catch (error) { row.error = error.message }
            finally { release?.() }
            rows.push(row)
          }
          return jsonContent({ platform: process.platform, harnesses: rows })
        },
      })

      editor.add({
        name: "delegate",
        description:
          "Synchronously delegate a self-contained bounded task to an external coding harness. Waits for completion, supports cancellation and timeout, and returns a normalized terminal result with an external sessionID when the harness exposes one.",
        input: {
          type: "object",
          properties: {
            harness: {
              type: "string",
              enum: ["antigravity", "claude", "gemini", "codex"],
              description: "External coding harness to run.",
            },
            prompt: {
              type: "string",
              minLength: 1,
              description:
                "Self-contained delegated task including scope, constraints, acceptance criteria, validation, and lifecycle authority.",
            },
            mode: {
              type: "string",
              enum: ["plan", "edit", "full"],
              description:
                "plan is read-only/conservative, edit allows file edits with conservative harness permissions, full enables non-interactive execution for an authorized bounded task. Defaults to edit.",
            },
            sessionID: {
              type: "string",
              minLength: 1,
              description:
                "External harness session/conversation ID returned by a previous completed delegation. Resume only for the same bounded outcome.",
            },
            model: {
              type: "string",
              minLength: 1,
              description: "Optional configured role name from harnesses.<id>.models or raw harness-native model ID. A role expands to its configured model and effort. Omitted uses the harness's configured `default` role when present, otherwise the vendor default.",
            },
            effort: {
              type: "string",
              minLength: 1,
              description: "Optional Antigravity or Claude native reasoning effort: low, medium, high, xhigh, max. Overrides a role's configured effort. Unsupported harnesses reject it.",
            },
            timeoutSeconds: {
              type: "integer",
              minimum: 1,
              description: "Foreground timeout. Capped by the plugin maxTimeoutSeconds option.",
            },
            workingDirectory: {
              type: "string",
              minLength: 1,
              description:
                "Optional session-workspace-relative or absolute subdirectory. It must resolve inside the calling session's workspace.",
            },
          },
          required: ["harness", "prompt"],
          additionalProperties: false,
        },
        options: { namespace: "switchboard", codemode: true },
        execute: async (input, context) => {
          let selection = selectionReport({ model: input.model, effort: input.effort })
          let harness
          try {
            harness = getHarness(input.harness, options)
          } catch (error) {
            return failure(input.harness, error.message, selection)
          }
          const resolved = resolveModelSelection(harness.models, { model: input.model, effort: input.effort })
          selection = selectionReport(resolved)
          const profile = { executionProfile: harness.executionProfile }

          const isDungeon = harness.profile?.type === "dungeon"
          const executable = isDungeon ? harness.command : await findExecutable(harness.command)
          if (!executable) {
            return failure(harness.id, `CLI executable not found: ${harness.command}`, {
              installHint: harness.installHint,
              ...selection,
            })
          }

          if (options.validateModels && resolved.model !== undefined && harness.modelListArgs) {
            const listing = await catalog.live(harness, context)
            const invalid = modelValidationError(harness.id, resolved, listing.live, harness.models)
            if (invalid) return failure(harness.id, invalid, { ...profile, ...selection })
            if (listing.liveError) selection.warnings = [`model availability not validated: ${listing.liveError}`]
          }

          let workspace
          let invocation
          let prompt
          let launchCommand = executable
          let launchArgs
          let binding
          try {
            const session = await ctx.session.get({ sessionID: context.sessionID })
            workspace = await resolveWorkspace(session, input.workingDirectory)
            const requestedMode = input.mode ?? "edit"
            prompt = buildWorkerPrompt(input.prompt, requestedMode)
            invocation = buildInvocation(harness, {
              prompt,
              mode: requestedMode,
              sessionID: input.sessionID,
              model: resolved.model,
              effort: resolved.effort,
              timeoutSeconds: resolveTimeoutSeconds(input.timeoutSeconds, options),
            })
            launchArgs = invocation.args
            if (harness.profile && !isDungeon) {
              launchCommand = await findExecutable(harness.profile.command)
              if (!launchCommand) throw new Error(`execution profile launcher not found: ${harness.executionProfile}`)
              launchArgs = [...harness.profile.args.map((arg) => arg.replaceAll("{cwd}", workspace.cwd)),
                "--", executable, ...invocation.args]
            }
          } catch (error) {
            return failure(harness.id, error.message, { ...profile, ...selection })
          }

          let release
          try {
            if (isDungeon || invocation.mode !== "plan") release = acquireWorkspaceLock(workspace.lockDirectory, harness.id)
          } catch (error) {
            return failure(harness.id, error.message, { activeHarness: error.activeHarness, ...profile, ...selection })
          }
          const timeoutSeconds = resolveTimeoutSeconds(input.timeoutSeconds, options)

          try {
            if (isDungeon) {
              binding = await inspectDungeon(harness, workspace, context.signal)
              if (input.sessionID) {
                const stored = await ctx.storage.get(dungeonKey("session", [harness.id, input.sessionID]))
                if (!sameResumeBinding(stored, resumeBinding(harness, binding))) {
                  throw new Error("Dungeon resume session is unknown or bound to another environment/project/cwd")
                }
              }
            }
            await context.progress({
              status: `Delegating to ${harness.label} (${invocation.mode})`,
            })

            const execution = isDungeon ? await runDungeonGuarded({
              harness, binding, args: [harness.command, ...invocation.args],
              timeoutMs: timeoutSeconds * 1000, maxOutputBytes: options.maxOutputBytes, signal: context.signal,
            }) : await runProcess({
              command: launchCommand,
              args: launchArgs,
              cwd: workspace.cwd,
              env: subprocessEnvironment(harness.envAllowlist),
              timeoutMs: timeoutSeconds * 1000,
              maxOutputBytes: options.maxOutputBytes,
              signal: context.signal,
            })

            const parsed = parseHarnessOutput(harness, execution.stdout, {
              truncated: execution.stdoutTruncated,
            })
            if (isDungeon && parsed.sessionID) {
              if (execution.dungeon.cleanup !== "confirmed" || execution.dungeon.transportError ||
                  execution.dungeon.protocolError || parsed.protocolError) {
                delete parsed.sessionID
              } else {
                try {
                  await persistDungeonSession(ctx.storage, harness, binding, parsed.sessionID)
                } catch (error) {
                  delete parsed.sessionID
                  execution.status = "failed"
                  execution.error = `Dungeon session binding could not be persisted: ${error.message}`
                }
              }
            }
            const providerFailed = parsed.providerFailed === true || Boolean(parsed.protocolError)
            const status =
              execution.status === "completed" && providerFailed ? "failed" : execution.status
            const error =
              execution.error ??
              (execution.status === "timeout" ? "harness process timed out" : undefined) ??
              (execution.status === "aborted" ? "harness process was aborted" : undefined) ??
              parsed.error ??
              parsed.protocolError ??
              (status === "failed"
                ? execution.stderr.trim() ||
                  (providerFailed
                    ? `harness returned non-success status: ${parsed.providerStatus ?? "unknown"}`
                    : `process exited with code ${execution.exitCode}`)
                : undefined)

            return jsonContent({
              status,
              harness: harness.id,
              mode: invocation.mode,
              ...profile,
              ...selection,
              ...(isDungeon ? { dungeon: { ...execution.dungeon, config: binding.config,
                fingerprint: binding.fingerprint, project: binding.project, guestCwd: binding.guestCwd,
                projectTransfer: "copy", hostChangesApplied: false } } : {}),
              sessionID: parsed.sessionID,
              response: parsed.response,
              providerStatus: parsed.providerStatus,
              deniedActions: parsed.deniedActions,
              protocolError: parsed.protocolError,
              rawOutput: parsed.rawOutput,
              usage: parsed.usage,
              modelUsage: parsed.modelUsage,
              exitCode: execution.exitCode,
              signal: execution.signal,
              durationMs: execution.durationMs,
              stderr: execution.stderr.trim() || undefined,
              stdoutTruncated: execution.stdoutTruncated,
              stderrTruncated: execution.stderrTruncated,
              outputTruncated: execution.outputTruncated,
              error,
            })
          } catch (error) {
            return failure(harness.id, error.message, { ...profile, ...selection })
          } finally {
            release?.()
          }
        },
      })
    })
  },
})
