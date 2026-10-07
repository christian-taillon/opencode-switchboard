# OpenCode Switchboard

Switchboard lets OpenCode delegate bounded work to external coding harness CLIs while OpenCode remains the parent control plane.

Version `0.0.1` targets Linux and supports:

- Google Antigravity (`agy`)
- Claude Code (`claude`)
- Gemini CLI (`gemini`)
- Codex CLI (`codex`)

The plugin exposes two OpenCode tools:

- `switchboard_harnesses`: discover configured harnesses and whether their executables are on `PATH`.
- `switchboard_delegate`: run one bounded harness task synchronously and return a normalized terminal result.

It also registers the `switchboard` skill. Agent prompt awareness is opt-in through `awareAgents`; Switchboard does not assume any agent names or external OpenCode configuration.

## Why

OpenCode can already delegate to native OpenCode subagents. Some coding products, subscriptions, and provider-specific capabilities are only available through their own CLI harness. Switchboard makes those harnesses usable as bounded external workers without forcing the parent agent to know CLI syntax or scrape an interactive terminal.

The intended mental model is:

```text
OpenCode parent
  |
  +-- native OpenCode subagent
  |
  `-- Switchboard external worker
      +-- Antigravity
      +-- Claude Code
      +-- Gemini CLI
      `-- Codex CLI
```

Switchboard does not copy the OpenCode conversation into the external harness. The parent sends a self-contained task envelope and receives a compact result.

## Install

Prerequisites:

1. OpenCode v2.
2. Linux.
3. At least one supported external CLI installed and authenticated independently.

Clone the repository into an OpenCode plugin directory and install its package dependency:

```bash
git clone git@github.com:christian-taillon/opencode-switchboard.git \
  ~/.config/opencode/plugins/switchboard
cd ~/.config/opencode/plugins/switchboard
```

Then install with your preferred Node package manager. For example:

```bash
pnpm install --prod --ignore-scripts
```

or:

```bash
npm install --omit=dev --ignore-scripts
```

OpenCode v2 discovers immediate plugin package directories under `~/.config/opencode/plugins/`. Alternatively, clone Switchboard anywhere and add that directory to the `plugins` array in `~/.config/opencode/opencode.jsonc` using the documented local-path form.

Confirm it is loaded:

```bash
opencode plugin list
```

Then start or reload OpenCode. The selected agent can load the `switchboard` skill and call the Switchboard tools.

### Optional native subagent profiles

The generic plugin remains the default and requires no agent definitions. Optional profiles expose selected external harnesses as normal OpenCode subagents while keeping the backend tools unchanged.

For Claude Code:

```bash
./integrations/claude-native/install.sh
```

This adds a `claude-code` OpenCode subagent plus a `/claude` background command while keeping the existing `switchboard_delegate` interface unchanged. The profile is independently deployable and does not depend on `opencode-agents` or `rcfiles`; if the Switchboard backend is missing, its installer installs the backend from this checkout.

For Google Antigravity as a subagent only:

```bash
./integrations/antigravity-native/install.sh
```

This installs only the `antigravity` OpenCode subagent. It adds no command and no routing policy. See the profile READMEs for install and uninstall details.

## Agent integration

Switchboard does not require specific agent definitions. By default, `awareAgents` is `[]`, so installation registers the skill and tools without modifying any agent system prompt.

Agents using deny-by-default OpenCode 2 permission rules must explicitly allow the registered Switchboard tool actions:

```yaml
- action: switchboard_harnesses
  resource: "*"
  effect: allow
- action: switchboard_delegate
  resource: "*"
  effect: allow
```

If an agent already contains Switchboard routing guidance, no `awareAgents` configuration is needed. For a custom agent that lacks that awareness, add its ID to `awareAgents`; Switchboard will append a short instruction telling it to load the `switchboard` skill when external harness delegation would materially help.

The `switchboard` skill tells agents to:

- keep architecture, ambiguous diagnosis, sequencing, acceptance, and user decisions in the OpenCode parent when those matter;
- send a self-contained bounded task with scope, constraints, validation, dirty-tree boundary, and lifecycle authority;
- run gating delegations in the foreground and wait for a terminal result;
- retain a returned external `sessionID` and resume it only after the previous call has completed, and only for the same bounded outcome;
- start a fresh external session for materially different or intentionally independent work;
- avoid overlapping mutating delegates in the same working directory;
- inspect important diffs and validation evidence before accepting a worker's claims.

This keeps Switchboard standalone while allowing any OpenCode agent set to opt into the capability.

## Delegation modes

`switchboard_delegate` accepts three normalized modes:

| Mode | Intended use | Harness behavior |
| --- | --- | --- |
| `plan` | Read-only investigation, review, design | Conservative/read-only harness mode where available |
| `edit` | Normal file edits | Allows edits while keeping conservative harness permissions |
| `full` | Bounded implementation that must run commands non-interactively | Uses the harness's non-interactive/full-approval mode |

`edit` is the default. Use `full` only when the delegated task requires command execution and the parent already has authority for that work.

Mode mapping in v0.0.1:

| Harness | `plan` | `edit` | `full` |
| --- | --- | --- | --- |
| Antigravity | `--mode=plan` | `--mode=accept-edits` | accept edits + `--dangerously-skip-permissions` |
| Claude Code | `--permission-mode plan` | `--permission-mode acceptEdits` | `--permission-mode auto` |
| Gemini CLI | `--approval-mode plan` | `--approval-mode auto_edit` | `--approval-mode yolo` |
| Codex CLI | normal restricted `codex exec` | `codex exec --full-auto` | `codex exec --full-auto` |

Claude Code `full` uses auto mode rather than `bypassPermissions`, so Claude's own safety classifier, permission rules, and sandbox stay active. Every Claude invocation also passes `--settings` with empty commit and PR attribution, so delegated commits never carry a Claude `Co-Authored-By` trailer regardless of the user's Claude settings.

Codex invocations include `--skip-git-repo-check` so delegation also works in non-Git projects. This does not change Codex's sandbox or approval settings.

## Sessions

Antigravity, Claude Code, and Gemini CLI expose resumable external sessions. Switchboard normalizes the returned identifier as `sessionID`.

Conceptually:

```text
1. switchboard_delegate({ harness: "claude", prompt: "..." })
2. receive sessionID
3. inspect the result
4. for a correction to the same bounded outcome only:
   switchboard_delegate({
     harness: "claude",
     sessionID: "...",
     prompt: "Fix the remaining failing case ..."
   })
```

Do not resume a session that is still running. Switchboard v0.0.1 itself is foreground-only, so a tool call returns only after the child process reaches a terminal state, times out, or is cancelled.

Codex session resume is intentionally not enabled in v0.0.1. Codex execution is supported, but Switchboard will reject `sessionID` for that harness rather than guess at a CLI contract. Model override is likewise enabled for Antigravity, Claude Code, and Gemini CLI, but intentionally rejected for Codex in v0.0.1.

## Result contract

A successful or failed delegation returns JSON to the OpenCode parent with fields such as:

```json
{
  "status": "completed",
  "harness": "antigravity",
  "mode": "full",
  "sessionID": "external-session-id",
  "response": "Implemented the bounded change...",
  "exitCode": 0,
  "durationMs": 42183,
  "outputTruncated": false
}
```

Possible Switchboard statuses are:

- `completed`
- `failed`
- `timeout`
- `aborted`

Provider-native status and usage are preserved when the harness exposes them. `stderr` is included when present.

## Task envelope

Switchboard prepends a small worker contract to every delegated prompt. It tells the external harness that it is a bounded worker, to inspect repository guidance, not widen scope, not commit or push unless the task explicitly authorizes it, finish required checks synchronously, and return outcome/files/validation/risks.

The OpenCode parent should still provide the substantive task. A useful task includes:

```text
Objective
Fix the generated-office collision regression.

Scope
src/world/layout.js
src/world/collision.js
tests/sprite.test.js

Constraints
Preserve procedural generation.
Do not change the renderer API.
Do not commit or push.

Acceptance
Agents cannot walk through generated desks.
Existing layout behavior remains intact.

Validation
Run the focused tests and pnpm check.
```

## Process behavior

Switchboard deliberately uses direct process spawning rather than a shell:

- arguments are passed as an array, avoiding shell interpolation;
- stdout and stderr are drained continuously;
- retained output is capped while the process continues to drain;
- OpenCode cancellation is forwarded to the external process;
- timeout or cancellation terminates the Linux process group so descendants do not remain running;
- required work is always foreground in v0.0.1;
- overlapping mutating delegates to the same working directory are rejected.

External harnesses are a separate execution and security boundary. Switchboard spawns the vendor CLI directly, so OpenCode shell hooks, shell-command permission wrappers, Git identity guards, and other behavior attached specifically to OpenCode's own shell tool do not automatically apply to commands an external harness executes. Configure each vendor harness, its permissions, and its Git identity independently.

A custom `workingDirectory` must resolve inside the OpenCode project root. This prevents a delegated tool call from silently switching Switchboard to an unrelated checkout.

## Configuration

Defaults:

```jsonc
{
  "plugins": [
    {
      "package": "/home/you/.config/opencode/plugins/switchboard",
      "options": {
        "awareAgents": [],
        "defaultTimeoutSeconds": 900,
        "maxTimeoutSeconds": 3600,
        "maxOutputBytes": 8388608,
        "harnesses": {
          "antigravity": { "enabled": true, "command": "agy" },
          "claude": { "enabled": true, "command": "claude" },
          "gemini": { "enabled": true, "command": "gemini" },
          "codex": { "enabled": true, "command": "codex" }
        }
      }
    }
  ]
}
```

The `package` path above is only needed when you configure Switchboard explicitly. If it lives directly under `~/.config/opencode/plugins/switchboard`, OpenCode discovers it automatically.

`command` is an executable name or path, not a shell command string. Use it when a CLI is installed outside normal `PATH` discovery.

Set `awareAgents` to one or more agent IDs only when you want Switchboard to append its short awareness instruction to those agents. The default is `[]`.

## Harness prerequisites

Switchboard does not manage vendor authentication. Install and authenticate each CLI normally, then run `switchboard_harnesses` from OpenCode to verify discovery.

For Antigravity, the vendor installer is:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

The other supported commands expected by v0.0.1 are `claude`, `gemini`, and `codex`.

## Development

The execution core is dependency-free so it can be tested with Node's built-in test runner. The only runtime package dependency is the OpenCode plugin API.

```bash
pnpm test
pnpm run check
```

The equivalent npm commands are `npm test` and `npm run check`.

Source layout:

```text
src/
  index.js       OpenCode v2 plugin registration
  config.js      plugin option normalization
  harnesses.js   CLI adapters and output normalization
  prompt.js      bounded worker task envelope
  runner.js      foreground/cancellation/process-group execution
  workspace.js   project-bound working-directory validation
skills/
  switchboard/
    SKILL.md      agent delegation discipline
integrations/
  claude-native/       optional Claude subagent and /claude command
  antigravity-native/  optional Antigravity subagent only
```

## v0.0.1 limitations

- Linux is the supported target. The runner contains a basic Windows fallback for process termination, but Windows is not tested or claimed supported.
- Delegations use the current working tree. Switchboard does not create worktrees automatically in v0.0.1.
- Only one mutating Switchboard delegation may run in a given working directory at a time.
- Codex resume and per-delegation model override are disabled.
- Harness CLI flags can change upstream. Switchboard keeps those differences inside adapters so they can be updated without changing the OpenCode-facing tool contract.
- The package currently pins `@opencode/plugin` `2.0.4`. Validate plugin loading against the OpenCode 2 build you run with `opencode plugin list` before relying on Switchboard.
