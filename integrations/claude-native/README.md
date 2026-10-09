# Claude-native OpenCode integration

This optional profile makes Claude Code feel like a normal OpenCode subagent while keeping the generic Switchboard tools available and unchanged.

## What it installs

```text
~/.config/opencode/agents/claude.md
~/.config/opencode/commands/claude.md
```

If the Switchboard plugin is neither installed under `~/.config/opencode/plugins/switchboard` nor listed in `opencode.json` `plugins` (for example by absolute checkout path), the installer copies the plugin from this checkout and installs its production dependency. Existing Switchboard installations are left untouched.

The [agent template](agents/claude.md) is the maintained example for the canonical `claude` agent. It uses GPT-6.1 Sol high to forward tasks to Claude Code; change its OpenCode `model` if that provider is unavailable. See the root README for [model defaults](../../README.md#optional-native-subagent-profiles).

For opinionated parent routing and customized harness profiles, see the companion [opencode-agents](https://github.com/christian-taillon/opencode-agents) repository. Those definitions are maintained separately; this installer backs up and replaces an existing wrapper rather than merging its customizations.

## Manual use

```text
@claude implement the parser cleanup and run the focused tests
```

### Keep only `@claude`

The installer now installs only `@claude` and targets it from `/claude`. On upgrade, it backs up existing wrapper and command files under `backups/claude-native-<timestamp>` in the config directory, then removes the legacy `agents/claude-code.md` duplicate. Existing customizations are backed up, not merged.

Update parent prompts and callers to use `claude`. Remove obsolete `subagent` permission entries for `claude-code` and ensure deny-by-default parents allow `claude`; preserve their other permissions. The installer does not edit parent agents or project-local overrides, which take precedence over global definitions.

This changes the OpenCode agent name, not the upstream Claude Code product, CLI, external model policy, or Switchboard harness ID.

Or use the convenience command:

```text
/claude implement the parser cleanup and run the focused tests
```

`/claude` sets `subagent: true`, so OpenCode runs the command in a background child session and sends the result back to the parent when it finishes. Direct parent-to-`claude` delegation can still be foreground or background according to the normal OpenCode subagent call.

## Parent routing

See [use, opt-out, and permission examples](../../README.md#tell-agents-when-to-delegate). Deny-by-default parents need the `claude` `subagent` allowance, not direct Switchboard permissions.

## Install

From the repository root:

```bash
./integrations/claude-native/install.sh
```

The installer requires `pnpm` only when it needs to install the Switchboard backend itself. It warns when the `claude` executable is not on `PATH`.

Reload OpenCode and verify:

```text
opencode plugin list
/claude inspect this repository and report the smallest safe cleanup
```

## Uninstall

Remove the canonical wrapper, any legacy duplicate, and the command:

```bash
./integrations/claude-native/uninstall.sh
```

If this profile originally installed the Switchboard backend and you also want to remove that backend:

```bash
./integrations/claude-native/uninstall.sh --remove-plugin
```

The plugin is never removed by default because it may still be used through the generic Switchboard interface.

## Current limits

- The Claude CLI call remains synchronous inside the `claude` child. OpenCode provides background behavior by backgrounding the child session, not by making Switchboard asynchronous.
- Resume the same OpenCode child only for the same task; it retains the external Claude session and chosen model/effort pair.
- Mutating Claude work uses the current checkout. Do not run overlapping mutating work against the same files.
- Claude's external permission mode is still selected by Switchboard's existing `plan`, `edit`, and `full` modes. The native wrapper does not weaken those boundaries.
