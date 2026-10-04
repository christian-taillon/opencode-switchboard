#!/usr/bin/env bash
set -euo pipefail

config_dir="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
plugin_dir="$config_dir/plugins/switchboard"

rm -f "$config_dir/agents/claude-code.md"
rm -f "$config_dir/commands/claude.md"

if [[ "${1:-}" == "--remove-plugin" ]]; then
  if [[ -f "$plugin_dir/.installed-by-claude-native" ]]; then
    rm -rf "$plugin_dir"
    printf '%s\n' "removed Switchboard backend installed by claude-native"
  else
    printf '%s\n' "Switchboard backend was not marked as installed by claude-native; leaving it untouched"
  fi
fi

printf '%s\n' "removed claude-native OpenCode agent and command"
