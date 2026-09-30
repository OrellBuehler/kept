#!/usr/bin/env bash
# PostToolUse hook: format the file Claude just edited or wrote.
set -euo pipefail
file=$(bun -e 'const i = await Bun.stdin.json(); console.log(i.tool_input?.file_path ?? "")')
case "$file" in
  *.ts | *.js | *.svelte | *.css | *.json | *.md | *.yml | *.yaml | *.html) ;;
  *) exit 0 ;;
esac
[ -f "$file" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"
bunx prettier --write --ignore-unknown --log-level warn "$file"
