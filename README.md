# OpenCode Switchboard

Switchboard lets OpenCode delegate bounded work to external coding harness CLIs while OpenCode remains the parent control plane.

Version `0.0.1` targets Linux and supports:

- Google Antigravity (`agy`)
- Claude Code (`claude`)
- Gemini CLI (`gemini`)
- Codex CLI (`codex`)

The plugin exposes two OpenCode tools:

- `switchboard_harnesses`: discover configured harnesses and executable availability on the host or selected guest.
- `switchboard_delegate`: run one bounded harness task synchronously and return a normalized terminal result.

It also registers the `switchboard` skill. Agent prompt awareness is opt-in through `awareAgents`; Switchboard does not assume any agent names or external OpenCode configuration.

The parent sends a bounded task, not its conversation history. Switchboard runs the vendor CLI and returns its terminal result.

## Companion agent definitions

[opencode-agents](https://github.com/christian-taillon/opencode-agents) provides opinionated OpenCode parent routing, permissions, and customized `claude` / `antigravity` profiles that use Switchboard. This repository provides the execution backend, delegation/session contract, and standalone [native wrapper templates](#optional-native-subagent-profiles).

The agent collection is optional. Installing Switchboard does not install those definitions or adopt their routing policy. Update the backend and agent definitions separately; the native profile installers back up and replace existing wrappers rather than merging customizations.

## Install

Prerequisites:

1. OpenCode v2.
2. Linux.
3. At least one supported external CLI installed and authenticated independently.

Install in the auto-discovered plugin directory:

```bash
git clone https://github.com/christian-taillon/opencode-switchboard.git \
  ~/.config/opencode/plugins/switchboard
cd ~/.config/opencode/plugins/switchboard
pnpm install --prod --ignore-scripts
opencode plugin list
```

No JSON configuration, native agent profiles, or `awareAgents` entries are required. If OpenCode is already running, use `opencode reload` to activate plugin code changes; this reloads all loaded locations and cancels pending permission prompts, not the shared server.

### Optional native subagent profiles

From the checkout, install either or both:

```bash
./integrations/antigravity-native/install.sh
./integrations/claude-native/install.sh
```

This exposes `@antigravity`, `@claude`, and `/claude` (which targets `claude`). Existing plugin installations are left untouched; update the backend separately when its code changes. Installers do not change parent routing or vendor permissions.

The maintained agent examples are already in the repository:

- [Antigravity template](integrations/antigravity-native/agents/antigravity.md) · [install/uninstall](integrations/antigravity-native/README.md)
- [Claude template](integrations/claude-native/agents/claude.md) · [install/uninstall](integrations/claude-native/README.md)

Wrappers require access to `openai/gpt-6-luna#high`, or changing the installed agent's `model` line to an available OpenCode model. This provider requirement does not apply to generic Switchboard use.

The Claude installer backs up and removes the legacy `claude-code` duplicate. Follow the [migration notes](integrations/claude-native/README.md#keep-only-claude) to update parent routing and permissions.

The native wrappers use `openai/gpt-6-luna#high` to select and forward work; the external harness performs the task. Their prompt-level model policy is:

| Harness | Default | Task-based alternatives |
| --- | --- | --- |
| Antigravity | `gemini-3.8-flash-medium`, `medium` effort | Flash Low/`low` for lightweight work; Flash High/`high` for harder reasoning |
| Claude Code | `claude-opus-5-5`, `high` effort | `claude-opus-5-5`/`xhigh` for exceptional work; `claude-sonnet-5-5`/`xhigh` for routine work; `claude-haiku-4-5` without effort for lightweight work |

Parents can supply `externalModel` and `externalEffort` in the native subagent's task prompt. Explicit selections win; otherwise the wrapper chooses before starting and retains that pair on resume. The native OpenCode subagent tool's `model` argument changes the wrapper model, not the external harness. Unavailable selections are reported, not silently replaced. Future models are not selected until available and verified.

Generic `switchboard_delegate` calls accept harness-native `model` and `effort` directly; omitted selectors use vendor defaults. `effort` is supported for Antigravity and Claude; unsupported harnesses reject it in this checkout. `requestedModel` and `requestedEffort` describe requested settings, not verified resolved metadata. Vendor-side caps or substitutions must still be checked.

## Tell agents when to delegate

For one task:

```text
Use @antigravity for this read-only investigation. Report its findings.
Use @claude for this implementation. externalModel: claude-sonnet-5-5, externalEffort: xhigh.
You may use either harness when useful; choose the model and effort for the job.
Work directly. Do not use Antigravity, Claude Code, or direct Switchboard delegation.
```

For persistent behavior, add a policy to the parent agent's Markdown body or repository `AGENTS.md`:

> Use external harness subagents only when explicitly requested. Otherwise work directly or use native workers.

Prompt instructions guide behavior. [OpenCode permissions](https://opencode.ai/v2/docs/permissions/) control tool routes. For a deny-by-default parent, append only the required child permissions to its existing `permissions` list:

```yaml
  - action: subagent
    resource: antigravity
    effect: allow
  - action: subagent
    resource: claude
    effect: allow
```

No direct Switchboard permissions are needed by a parent that only calls these wrappers. To prohibit native delegation, change the relevant effects to `deny`. Remove obsolete `claude-code` rules after migration. Last matching rule wins; keep specific rules after broader ones.

If the parent can also call Switchboard directly, deny that route separately:

```yaml
  - action: switchboard_delegate
    resource: "*"
    effect: deny
```

This denies direct delegation across all harnesses. These rules are not OS containment; do not assume they block vendor CLI execution through an allowed shell or explicit `/claude` command dispatch.

### Direct tool use without wrappers

Switchboard tools run through Code Mode as `tools.switchboard.harnesses` and `tools.switchboard.delegate`. A deny-by-default agent using them directly needs these entries in its existing `permissions` list:

```yaml
  - action: execute
    resource: "*"
    effect: allow
  - action: switchboard_harnesses
    resource: "*"
    effect: allow
  - action: switchboard_delegate
    resource: "*"
    effect: allow
```

The outer `execute` permission does not bypass nested tool checks. The shipped wrappers already include these rules. Loading the `switchboard` skill provides the worker/session contract; `awareAgents` is only an optional prompt-awareness convenience.

## Delegation modes

`switchboard_delegate` accepts three normalized modes:

| Mode | Intended use | Harness behavior |
| --- | --- | --- |
| `plan` | Read-only investigation, review, design | Conservative/read-only harness mode where available |
| `edit` | Normal file edits | Allows edits while keeping conservative harness permissions |
| `full` | Bounded implementation that must run commands non-interactively | Uses the harness's non-interactive/full-approval mode |

`edit` is the default. Antigravity and Gemini `full` bypass vendor approval, so Switchboard refuses them unless the harness is configured with an approved execution profile; also require explicit authorization for that bypass, not just permission to run tests. Modes are vendor workflow controls, not OS isolation.

Mode mapping in v0.0.1:

| Harness | `plan` | `edit` | `full` |
| --- | --- | --- | --- |
| Antigravity | `--mode=plan` | `--mode=accept-edits` | accept edits + `--dangerously-skip-permissions` |
| Claude Code | `--permission-mode plan` | `--permission-mode acceptEdits` | `--permission-mode auto` |
| Gemini CLI | `--approval-mode plan` | `--approval-mode auto_edit` | `--approval-mode yolo` |
| Codex CLI | normal restricted `codex exec` | `codex exec --full-auto` | `codex exec --full-auto` |

Claude Code `full` uses auto mode rather than `bypassPermissions`; it does not disable vendor permission checks or configured sandboxing. It does not enable a sandbox either. Every Claude invocation passes `--settings` with empty commit and PR attribution to suppress Claude co-author trailers.

Codex invocations include `--skip-git-repo-check` so delegation also works in non-Git projects. This does not change Codex's sandbox or approval settings.

## Sessions

Antigravity, Claude Code, and Gemini CLI expose resumable external sessions. Switchboard normalizes the returned identifier as `sessionID`.

Wait for terminal completion before resuming. Reuse `sessionID` only for the same bounded outcome, and resend the selected `model` and `effort`. Start fresh for a different task. Calls are foreground; an OpenCode parent can background a native child, not the external CLI call itself.

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

Antigravity results with denied tools, invalid JSON, a missing status, or a blank `SUCCESS` response are `failed` even when the process exits `0`. `deniedActions` preserves the vendor's `denied_actions`; `protocolError` and `rawOutput` retain malformed or incomplete result evidence. Truncated stdout cannot establish completion. `stdoutTruncated` and `stderrTruncated` distinguish terminal-output loss from diagnostic-output loss; `outputTruncated` covers either.

Claude results with nonempty `permission_denials` are also `failed`, even with exit `0` and subtype `success`. `deniedActions` preserves those native entries, including `tool_name`, `tool_use_id`, and `tool_input`; the worker response and session ID remain available. Optional `modelUsage` preserves Claude's vendor-reported per-model usage and canonical model metadata. On resume it is session-cumulative; do not sum it across calls. It is evidence separate from `requestedModel`, not verification of resolved effort.

Other harnesses also require a valid terminal result and nonblank response: Claude's `result`/`success`, Gemini's JSON `response`, or Codex's completed agent message followed by `turn.completed`. Malformed or incomplete output fails even with exit `0`.

## Task envelope

Switchboard prepends a small worker contract to every delegated prompt. It tells the external harness that it is a bounded worker, to inspect repository guidance, not widen scope, not commit or push unless the task explicitly authorizes it, finish required checks synchronously, and return outcome/files/validation/risks.

The parent supplies the objective, relevant files, constraints, acceptance checks, validation commands, and commit/push authority. The parent retains architecture and acceptance decisions and checks the worker's claims.

## Process behavior

Switchboard deliberately uses direct process spawning rather than a shell:

- arguments are passed as an array, avoiding shell interpolation;
- stdout and stderr are drained continuously;
- retained output is capped while the process continues to drain;
- OpenCode cancellation is forwarded to the external process;
- timeout or cancellation sends SIGTERM to the Linux process group, then SIGKILL after a 500 ms grace period; completion waits for escalation even if the group leader exits first;
- required work is always foreground in v0.0.1;
- harnesses receive only allowlisted environment variables (default `PATH`, `HOME`, `LANG`, `LC_ALL`, `TERM`, `TMPDIR`), so OpenCode's credentials and tokens are not inherited;
- overlapping mutating delegates to the same checkout or overlapping directories are rejected.

External harnesses are a separate execution and security boundary. Switchboard spawns the vendor CLI directly, so OpenCode shell hooks, shell-command permission wrappers, Git identity guards, and other behavior attached specifically to OpenCode's own shell tool do not automatically apply to commands an external harness executes. Configure each vendor harness, its permissions, and its Git identity independently.

Delegations run in the calling session's workspace. A custom `workingDirectory` must resolve inside that workspace. This prevents a delegated tool call from silently switching Switchboard to an unrelated checkout.

## Configuration

Only installations outside the auto-discovered directory need a plugin path:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/switchboard"]
}
```

For optional overrides, use the plugin object form with `package` and `options` fields. Leave defaults alone unless needed:

| Option | Default |
| --- | --- |
| `awareAgents` | `[]`; no parent prompts modified |
| `defaultTimeoutSeconds` / `maxTimeoutSeconds` | `900` / `3600` |
| `maxOutputBytes` | `8388608` per output stream |
| `harnesses.<id>.enabled` | `true` |
| `harnesses.<id>.command` | `agy`, `claude`, `gemini`, or `codex` |
| `harnesses.<id>.envAllowlist` | `PATH`, `HOME`, `LANG`, `LC_ALL`, `TERM`, `TMPDIR` |
| `harnesses.<id>.executionProfile` | unset (`host`); names an entry in `executionProfiles` |
| `executionProfiles.<id>` | Launcher `{ approved, command, args }` (optional `type: "launcher"`), or Dungeon `{ type: "dungeon", approved, command, config }`; absolute trusted paths |

`command` is an executable name or path, not a shell string. `enabled: false` disables that harness for all callers of this plugin instance, including wrappers.

### Optional Dungeon execution

**Existing integration; disposable Claude and guest-native OpenCode workflows validated.** [Dungeon](https://github.com/Dark-Roast-Cyber/dungeon)
and OpenShell own isolation and policy; Switchboard still owns vendor prompts,
modes and result parsing. Use a source-built Dungeon with Unix-stream-socket,
`copy_baseline_valid`, terminal `cleanup` and `primary_transport_verified` support
from this integration.
Older binaries are refused; matching `0.0.2` version text alone is insufficient.

Provision a dedicated, pinned-image **copy-mode** environment explicitly. Review
project contents and policy before `up --yes`; complete vendor login in the guest.
Then select the private configuration in trusted plugin options:

```jsonc
{
  "plugins": [{
    "package": "/absolute/path/to/switchboard",
    "options": {
      "executionProfiles": {
        "isolated": {
          "type": "dungeon",
          "approved": true,
          "command": "/absolute/path/to/source-built/dungeon",
          "config": "/private/task/dungeon.json"
        }
      },
      "harnesses": { "claude": { "executionProfile": "isolated" } }
    }
  }]
}
```

- The canonical configured project must equal the calling session workspace.
  `workingDirectory: "sub"` maps to `/sandbox/project/sub`. **The whole copied
  project remains accessible**; cwd and vendor plan mode are not read-only storage.
- Only verified Ready/copy environments with a valid upload baseline are admitted.
  Discovery checks executables in the guest, not the host. Guest image/auth/network
  prerequisites remain operator-owned; other vendors are not provisioned for you.
- Every call, including plan and discovery, serializes against overlapping
  Switchboard work. An exclusively created host record in the private config
  directory prevents simultaneous processes from using the same sandbox/config.
  Separately copied configs and independent guest writers require operator
  coordination; this is cooperative admission, not a distributed lease.
  Known pre-spawn failures and pre-cancelled calls do not leave an admission block.
- Vendor session IDs are durably bound to the harness, config, project, fingerprint,
  sandbox ID and guest cwd. Bindings cannot be reassigned; unknown/mismatched
  resumes refuse. IDs are exposed only after verified transport/cleanup and
  persistence. Environment stop/start preserves the binding; replacement does not.
- Timeout/cancellation signals the Dungeon leader and allows up to 20 seconds for
  cleanup. Dungeon output is decoded incrementally with bounded retained bytes.
  `dungeon.cleanup` is `confirmed`, `not_started` or `unconfirmed`; confirmation
  covers cooperative owned-group lifecycle only, not group escapes or same-UID
  interference. Failed primary transport is conservatively treated as unconfirmed;
  cancellation can still confirm cleanup with verified primary exit/control removal.
- A private admission record blocks reuse after unconfirmed cleanup or a parent
  crash; `dungeon.admissionRecord` identifies its path. Recover the old work
  explicitly, then provision a new environment identity.
  There is no automatic unlock or retry with host execution.
- `dungeon.hostChangesApplied: false` means edits stay guest-only. Switchboard
  never creates, starts, uploads, exports or stops the environment automatically.
  Use Dungeon's separate reviewed export after quiescing guest/host writers.
- `approved: true` is operator configuration, not OS attestation or a grant of
  additional vendor tool permissions. Headless approval denials remain failures;
  review scoped guest settings instead of retrying with broader modes.

**Native `@code` is separate.** It uses OpenCode tools, not Codex/Switchboard, and
remains host-native in a host session. For contained native work, run guest OpenCode
through Dungeon's [authenticated remote connection workflow](https://github.com/Dark-Roast-Cyber/dungeon/blob/main/docs/integrations.md).
Select/configure the guest's agents and authentication explicitly. A host child
session or a Switchboard profile does not relocate native OpenCode tools.
Disposable validation used a guest-native `code` child with exact read/edit/command
permissions and an independently matched guest identity; it does not establish
transparent containment of host-native agents.
The buffered-cancellation correction passed fresh disposable high-output cancellation
and clean-relaunch checks on 2026-10-11. Contained Antigravity 1.3.3 guest discovery,
edit and external-session resume also passed, but its test runner failed to open
`/dev/ptmx` under the reviewed policy. An independently launched guest test passed;
this is **not** a complete Antigravity edit/test gate. Vendor `SUCCESS` did not
establish that the requested test ran. See Dungeon's
[revision-qualified validation](https://github.com/Dark-Roast-Cyber/dungeon/blob/main/docs/validation.md).

### Native Antigravity sandbox experiment

**Validated observation; partial acceptance.** A separate host pilot with Antigravity
1.3.3, `--sandbox` and temporarily approved `toolPermission: "proceed-in-sandbox"`
completed a synthetic edit, Node test and same-conversation resume. Shell reads and
writes to an unmounted outside path were sandbox-blocked; native file tools were
denied by permissions, not proven enclosed by the terminal sandbox. A network probe
returned HTTP 403, but its origin was not established, so network enforcement remains
unproven. Requested effort was not emitted in vendor metadata.

Original settings were restored and synthetic fixtures removed. Switchboard does
not add `--sandbox` or enable sandbox auto-approval. The [native terminal sandbox](https://antigravity.google/docs/sandbox/)
is distinct from Dungeon's outer guest boundary; this pilot does not establish
nested compatibility or justify changing defaults.

## Harness prerequisites

Install and authenticate vendor CLIs independently ([Antigravity](https://antigravity.google/docs/cli/install/), [Claude Code](https://code.claude.com/docs/en/setup)). `switchboard_harnesses` checks executable availability, not authentication, quota, or model access.

### Antigravity headless permissions

Antigravity cannot prompt for permission during a delegation. Tools requiring approval are [soft-denied in headless mode](https://antigravity.google/docs/cli/headless/#permissions-in-headless-mode); the CLI can still exit `0` and return `SUCCESS` with an empty response and `denied_actions`. Switchboard reports this as a failure, not task completion.

For an authorized URL lookup, the operator can add a scoped rule to `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`, preserving existing settings. For the [NOAA Phoenix station text report](https://tgftp.nws.noaa.gov/data/observations/metar/decoded/KPHX.TXT), use `read_url(tgftp.nws.noaa.gov)`. Keep the delegation in `plan` mode. Switchboard does not install grants or retry with broader permissions.

These [vendor rules](https://antigravity.google/docs/permissions?tab=cli) cover a hostname and its subdomains, not an exact URL path. Conflicting rules take precedence in the order **deny > ask > allow**. Do not use `read_url(*)` or switch to `full` / `--dangerously-skip-permissions` to work around a denied lookup.

Validated on 2026-10-08: Antigravity's native URL reader truncated the NWS GeoJSON and HTML observation pages before the weather fields. The short NOAA text report worked. This was vendor content conversion, not Switchboard stdout truncation; a completed delegation alone does not mean the requested data was obtained.

### Claude Code sandbox prerequisites

On Linux, Claude's [Bash sandbox](https://code.claude.com/docs/en/sandboxing#set-up-linux-and-wsl2) needs `bubblewrap` and `socat` on the harness's `PATH`. Without them, the CLI can warn that sandboxing is disabled and still complete a task. Check stderr; success is not proof of containment. Operators requiring sandboxing can set the vendor's `sandbox.failIfUnavailable` to `true` instead of accepting that fallback.

Validated on 2026-10-08: native `@antigravity` retrieved Phoenix observations and resumed its external session; native `@claude` ran a Node assertion and retained context across external-session resume. Claude's missing-`socat` warning disappeared after installing the dependency and repeating the assertion. These were functional smoke tests, not a containment audit.

## Development

The execution core is dependency-free so it can be tested with Node's built-in test runner. The only runtime package dependency is the OpenCode plugin API.

```bash
pnpm test
pnpm run check
```

## v0.0.1 limitations

- Linux is the supported target. The runner contains a basic Windows fallback for process termination, but Windows is not tested or claimed supported.
- Delegations use the current working tree. Switchboard does not create worktrees automatically in v0.0.1.
- Only one mutating Switchboard delegation may run in a given working directory at a time.
- Process-group cleanup cannot kill descendants that deliberately leave the group; use OS containment when that boundary matters.
- Codex resume and per-delegation model override are disabled.
- Harness CLI flags can change upstream. Switchboard keeps those differences inside adapters so they can be updated without changing the OpenCode-facing tool contract.
- The package currently pins `@opencode/plugin` `2.0.4`. Validate plugin loading against the OpenCode 2 build you run with `opencode plugin list` before relying on Switchboard.
