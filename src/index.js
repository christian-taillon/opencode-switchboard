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
          "List Switchboard harnesses and report which CLI executables are currently available on PATH. Use this before delegation when availability is uncertain.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        options: { namespace: "switchboard", codemode: true },
        execute: async (_input, context) => {
          await context.progress({ status: "Checking external coding harnesses" })
          const rows = await Promise.all(
            harnessDefinitions(options).map(async (harness) => ({
              ...harness,
              available: harness.enabled ? Boolean(await findExecutable(harness.command)) : false,
            })),
          )
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
              description: "Optional harness-native model selector.",
            },
            effort: {
              type: "string",
              minLength: 1,
              description: "Optional Antigravity or Claude native reasoning effort: low, medium, high, xhigh, max. Unsupported harnesses reject it.",
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
          const selection = { requestedModel: input.model ?? "unknown", requestedEffort: input.effort }
          let harness
          try {
            harness = getHarness(input.harness, options)
          } catch (error) {
            return failure(input.harness, error.message, selection)
          }
          const profile = { executionProfile: harness.executionProfile }

          const executable = await findExecutable(harness.command)
          if (!executable) {
            return failure(harness.id, `CLI executable not found: ${harness.command}`, {
              installHint: harness.installHint,
              ...selection,
            })
          }

          let workspace
          let invocation
          let prompt
          let launchCommand = executable
          let launchArgs
          try {
            const session = await ctx.session.get({ sessionID: context.sessionID })
            workspace = await resolveWorkspace(session, input.workingDirectory)
            const requestedMode = input.mode ?? "edit"
            prompt = buildWorkerPrompt(input.prompt, requestedMode)
            invocation = buildInvocation(harness, {
              prompt,
              mode: requestedMode,
              sessionID: input.sessionID,
              model: input.model,
              effort: input.effort,
              timeoutSeconds: resolveTimeoutSeconds(input.timeoutSeconds, options),
            })
            launchArgs = invocation.args
            if (harness.profile) {
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
            if (invocation.mode !== "plan") release = acquireWorkspaceLock(workspace.lockDirectory, harness.id)
          } catch (error) {
            return failure(harness.id, error.message, { activeHarness: error.activeHarness, ...profile, ...selection })
          }
          const timeoutSeconds = resolveTimeoutSeconds(input.timeoutSeconds, options)

          try {
            await context.progress({
              status: `Delegating to ${harness.label} (${invocation.mode})`,
            })

            const execution = await runProcess({
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
              sessionID: parsed.sessionID,
              response: parsed.response,
              providerStatus: parsed.providerStatus,
              deniedActions: parsed.deniedActions,
              protocolError: parsed.protocolError,
              rawOutput: parsed.rawOutput,
              usage: parsed.usage,
              exitCode: execution.exitCode,
              signal: execution.signal,
              durationMs: execution.durationMs,
              stderr: execution.stderr.trim() || undefined,
              stdoutTruncated: execution.stdoutTruncated,
              stderrTruncated: execution.stderrTruncated,
              outputTruncated: execution.outputTruncated,
              error,
            })
          } finally {
            release?.()
          }
        },
      })
    })
  },
})
