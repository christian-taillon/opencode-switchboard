# Claude-native OpenCode integration

This optional profile makes Claude Code feel like a normal OpenCode subagent while keeping the generic Switchboard tools available and unchanged.

## What it installs

```text
~/.config/opencode/agents/claude-code.md
~/.config/opencode/agents/claude.md
~/.config/opencode/commands/claude.md
```

If the Switchboard plugin is not already installed under `~/.config/opencode/plugins/switchboard`, the installer copies the plugin from this checkout and installs its production dependency. Existing Switchboard installations are left untouched.

The [agent template](agents/claude-code.md) is the maintained example for both names. It uses GPT-6.1 Sol high to forward tasks to Claude Code; change its OpenCode `model` if that provider is unavailable. See the root README for [model defaults](../../README.md#optional-native-subagent-profiles).

## Manual use

```text
@claude implement the parser cleanup and run the focused tests
```

`@claude-code` remains available for existing callers. Both profiles are installed from the same template.

### Keep only `@claude`

For an existing installation that no longer needs the duplicate agent ID:

1. Keep `~/.config/opencode/agents/claude.md` and remove only the duplicate `~/.config/opencode/agents/claude-code.md`.
2. Set `agent: claude` in `~/.config/opencode/commands/claude.md`; keep `subagent: true`.
3. Remove obsolete `subagent` permission entries for `claude-code` from parents that now call only `claude`. Preserve their other permissions.

This changes the OpenCode agent name, not the upstream Claude Code product, CLI, external model policy, or Switchboard harness ID. The current installer still recreates the duplicate and restores the command target to `claude-code`; do not rerun it expecting a single-name installation.

Or use the convenience command:

```text
/claude implement the parser cleanup and run the focused tests
```

`/claude` sets `subagent: true`, so OpenCode runs the command in a background child session and sends the result back to the parent when it finishes. Direct parent-to-`claude-code` delegation can still be foreground or background according to the normal OpenCode subagent call.

## Parent routing

See [use, opt-out, and permission examples](../../README.md#tell-agents-when-to-delegate). Deny-by-default parents need the relevant `subagent` allowances, not direct Switchboard permissions. Cover both `claude` and `claude-code` when disabling native routing.

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

Remove both native wrapper names and the command:

```bash
./integrations/claude-native/uninstall.sh
```

If this profile originally installed the Switchboard backend and you also want to remove that backend:

```bash
./integrations/claude-native/uninstall.sh --remove-plugin
```

The plugin is never removed by default because it may still be used through the generic Switchboard interface.

## Current limits

- The Claude CLI call remains synchronous inside the `claude-code` child. OpenCode provides background behavior by backgrounding the child session, not by making Switchboard asynchronous.
- Resume the same OpenCode child only for the same task; it retains the external Claude session and chosen model/effort pair.
- Mutating Claude work uses the current checkout. Do not run overlapping mutating work against the same files.
- Claude's external permission mode is still selected by Switchboard's existing `plan`, `edit`, and `full` modes. The native wrapper does not weaken those boundaries.
