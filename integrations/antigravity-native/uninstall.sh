#!/usr/bin/env bash
set -euo pipefail

config_dir="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
rm -f "$config_dir/agents/antigravity.md"
printf '%s\n' "removed antigravity OpenCode subagent profile"
printf '%s\n' "Switchboard backend left installed"
