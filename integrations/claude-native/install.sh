#!/usr/bin/env bash
set -euo pipefail

integration_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd "$integration_dir/../.." && pwd)
config_dir="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
plugin_dir="$config_dir/plugins/switchboard"
agent_dir="$config_dir/agents"
command_dir="$config_dir/commands"
stamp=$(date +%Y%m%d-%H%M%S)
backup_dir="$config_dir/backups/claude-native-$stamp"

mkdir -p "$agent_dir" "$command_dir" "$config_dir/plugins"

backup_if_present() {
  local path="$1"
  local rel="$2"
  if [[ -e "$path" || -L "$path" ]]; then
    mkdir -p "$backup_dir/$(dirname "$rel")"
    cp -a "$path" "$backup_dir/$rel"
  fi
}

backend_installed=false
if [[ ! -f "$plugin_dir/package.json" ]]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    printf '%s\n' "error: pnpm is required to install the Switchboard backend" >&2
    exit 1
  fi

  mkdir -p "$plugin_dir"
  cp -a "$repo_dir/index.js" "$repo_dir/package.json" "$repo_dir/README.md" "$repo_dir/LICENSE" "$plugin_dir/"
  cp -a "$repo_dir/src" "$repo_dir/skills" "$plugin_dir/"
  (
    cd "$plugin_dir"
    pnpm install --prod --ignore-scripts
  )
  printf '%s\n' "claude-native" > "$plugin_dir/.installed-by-claude-native"
  backend_installed=true
fi

backup_if_present "$agent_dir/claude-code.md" "agents/claude-code.md"
backup_if_present "$agent_dir/claude.md" "agents/claude.md"
backup_if_present "$command_dir/claude.md" "commands/claude.md"

install -m 0644 "$integration_dir/agents/claude.md" "$agent_dir/claude.md"
install -m 0644 "$integration_dir/commands/claude.md" "$command_dir/claude.md"
rm -f "$agent_dir/claude-code.md"

if ! command -v claude >/dev/null 2>&1; then
  printf '%s\n' "warning: Claude Code executable 'claude' is not on PATH"
fi

if [[ -d "$backup_dir" ]]; then
  printf 'backup: %s\n' "$backup_dir"
fi
if [[ "$backend_installed" == "true" ]]; then
  printf 'installed Switchboard backend: %s\n' "$plugin_dir"
else
  printf 'using existing Switchboard backend: %s\n' "$plugin_dir"
fi
printf 'installed @claude agent: %s\n' "$agent_dir/claude.md"
printf 'installed /claude command: %s\n' "$command_dir/claude.md"
printf '%s\n' "reload OpenCode, confirm 'opencode plugin list', then try '/claude inspect this repository'"
