# Claude-native OpenCode integration

This optional profile makes Claude Code feel like a normal OpenCode subagent while keeping the generic Switchboard tools available and unchanged.

## What it installs

```text
~/.config/opencode/agents/claude-code.md
~/.config/opencode/agents/claude.md
~/.config/opencode/commands/claude.md
```

If the Switchboard plugin is not already installed under `~/.config/opencode/plugins/switchboard`, the installer copies the plugin from this checkout and installs its production dependency. Existing Switchboard installations are left untouched.

The profile does not depend on `opencode-agents`, `rcfiles`, or any particular OpenCode primary-agent setup.

## Mental model

```text
OpenCode parent
  |
  | native subagent semantics
  v
claude-code (OpenCode child session)
  |
  | switchboard_delegate
  v
Claude Code CLI
```

The OpenCode child session is the identity the parent manages. The wrapper retains the external Claude session ID in its own conversation context and reuses it only when the same OpenCode child is resumed for the same bounded outcome.

## Manual use

```text
@claude implement the parser cleanup and run the focused tests
```

`@claude-code` remains available for existing callers. Both profiles are installed from the same template.

Or use the convenience command:

```text
/claude implement the parser cleanup and run the focused tests
```

`/claude` sets `subagent: true`, so OpenCode runs the command in a background child session and sends the result back to the parent when it finishes. Direct parent-to-`claude-code` delegation can still be foreground or background according to the normal OpenCode subagent call.

## Automatic routing

A deny-by-default parent agent must explicitly allow this child ID:

```yaml
- action: subagent
  resource: claude
  effect: allow
- action: subagent
  resource: claude-code
  effect: allow
```

Do not add broad Switchboard tool permissions to the parent solely for this profile. The wrapper owns those backend capabilities.

A useful routing policy is:

- keep architecture, ambiguous diagnosis, sequencing, and acceptance in the parent;
- use native OpenCode workers for trivial or mechanical work;
- use `claude-code` for cohesive implementations, refactors, subtle debugging, or work where an independent Claude coding context is expected to improve the accepted result;
- inspect the returned diff and validation evidence before acceptance.

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
- Mutating Claude work still uses the current checkout. Do not run overlapping mutating work against the same files. Worktree isolation is the next logical feature if concurrent background editing becomes useful.
- Claude's external permission mode is still selected by Switchboard's existing `plan`, `edit`, and `full` modes. The native wrapper does not weaken those boundaries.
