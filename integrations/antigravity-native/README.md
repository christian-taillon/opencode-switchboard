# Antigravity-native OpenCode integration

This optional profile exposes Google Antigravity as a normal OpenCode subagent while keeping the generic Switchboard tools unchanged.

## What it installs

```text
~/.config/opencode/agents/antigravity.md
```

The profile does not add commands or routing policy. Your existing OpenCode agent configuration decides when or whether to call `antigravity`.

The [agent template](agents/antigravity.md) is the maintained example. It uses GPT-6.1 Sol high to forward tasks; change its OpenCode `model` if that provider is unavailable. See [model defaults](../../README.md#optional-native-subagent-profiles) and [use, opt-out, and permission examples](../../README.md#tell-agents-when-to-delegate).

For opinionated parent routing and customized harness profiles, see the companion [opencode-agents](https://github.com/christian-taillon/opencode-agents) repository. Those definitions are maintained separately; this installer backs up and replaces an existing wrapper rather than merging its customizations.

If the Switchboard plugin is neither installed under `~/.config/opencode/plugins/switchboard` nor listed in `opencode.json` `plugins` (for example by absolute checkout path), the installer copies the backend from this checkout and installs its production dependency.

## Mental model

```text
OpenCode parent
  |
  | native subagent call
  v
antigravity (OpenCode child session)
  |
  | switchboard_delegate
  v
Antigravity CLI (agy)
```

The OpenCode child session is the identity the parent manages. The adapter keeps the external Antigravity conversation ID inside that child and reuses it only when the same child is resumed for the same bounded outcome.

## Install

From the repository root:

```bash
./integrations/antigravity-native/install.sh
```

Reload OpenCode. The agent is then available as:

```text
@antigravity <bounded task>
```

Parents using deny-by-default subagent permissions must allow the `antigravity` child ID in their own configuration.

## Uninstall

```bash
./integrations/antigravity-native/uninstall.sh
```

This removes only the Antigravity agent profile. It deliberately leaves the generic Switchboard backend installed because other profiles or direct Switchboard users may depend on it.
