#!/usr/bin/env bash
set -euo pipefail

integration_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd "$integration_dir/../.." && pwd)
config_dir="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
plugin_dir="$config_dir/plugins/switchboard"
agent_dir="$config_dir/agents"
stamp=$(date +%Y%m%d-%H%M%S)
backup_dir="$config_dir/backups/antigravity-native-$stamp"

mkdir -p "$agent_dir" "$config_dir/plugins"

# A plugin entry naming Switchboard (for example an absolute checkout path) is
# already a backend; installing another copy under plugins/ would load it twice.
configured_backend() {
  local file
  command -v jq >/dev/null 2>&1 || return 1
  for file in "$config_dir/opencode.json" "$config_dir/opencode.jsonc"; do
    [[ -f "$file" ]] || continue
    sed -E 's#^[[:space:]]*//.*$##' "$file" | jq -er '[(.plugins // .plugin // [])[]
      | if type == "string" then . else (.package // empty) end
      | select(test("switchboard"))][0] // empty' 2>/dev/null && return 0
  done
  return 1
}

if [[ -f "$plugin_dir/package.json" ]]; then
  printf '%s\n' "using existing Switchboard backend: $plugin_dir"
elif configured=$(configured_backend); then
  printf '%s\n' "using configured Switchboard backend: $configured"
else
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
  printf '%s\n' "installed Switchboard backend: $plugin_dir"
fi

if [[ -e "$agent_dir/antigravity.md" || -L "$agent_dir/antigravity.md" ]]; then
  mkdir -p "$backup_dir/agents"
  cp -a "$agent_dir/antigravity.md" "$backup_dir/agents/antigravity.md"
  printf 'backup: %s\n' "$backup_dir"
fi

install -m 0644 "$integration_dir/agents/antigravity.md" "$agent_dir/antigravity.md"

if ! command -v agy >/dev/null 2>&1; then
  printf '%s\n' "warning: Antigravity executable 'agy' is not on PATH"
fi

printf 'installed antigravity agent: %s\n' "$agent_dir/antigravity.md"
printf '%s\n' "reload OpenCode, confirm 'opencode plugin list', then invoke @antigravity"
