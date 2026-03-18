#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-Pleb5/opencode-fork}"
REF="${REF:-nostr-bridge-summary}"
CFG_DIR="${CFG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
BIN_DIR="${BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}"
SYSTEMD_DIR="${SYSTEMD_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
BASE_URL="https://raw.githubusercontent.com/${REPO}/${REF}"

echo "Installing Nostr bridge pack"
echo "  repo: ${REPO}"
echo "  ref:  ${REF}"
echo "  dir:  ${CFG_DIR}"
echo "  bin:  ${BIN_DIR}"

mkdir -p "${CFG_DIR}/plugins" "${CFG_DIR}/command" "${CFG_DIR}/skills/nak" "${BIN_DIR}" "${SYSTEMD_DIR}"

curl -fsSL "${BASE_URL}/.opencode/plugins/nostr-bridge.ts" -o "${CFG_DIR}/plugins/nostr-bridge.ts"
curl -fsSL "${BASE_URL}/.opencode/command/nostr.md" -o "${CFG_DIR}/command/nostr.md"
curl -fsSL "${BASE_URL}/.opencode/skills/nak/SKILL.md" -o "${CFG_DIR}/skills/nak/SKILL.md"
curl -fsSL "${BASE_URL}/extras/nostr-bridge-pack/bin/opencode-tmux" -o "${BIN_DIR}/opencode-tmux"
curl -fsSL "${BASE_URL}/extras/nostr-bridge-pack/bin/ocmux" -o "${BIN_DIR}/ocmux"
curl -fsSL "${BASE_URL}/extras/nostr-bridge-pack/systemd/opencode-tmux.service" -o "${SYSTEMD_DIR}/opencode-tmux.service"
curl -fsSL "${BASE_URL}/extras/nostr-bridge-pack/termux/aliases.example.sh" -o "${CFG_DIR}/termux-opencode-aliases.sh"
chmod +x "${BIN_DIR}/opencode-tmux"
chmod +x "${BIN_DIR}/ocmux"

node - "${CFG_DIR}" <<'JS'
const fs = require("fs")
const path = require("path")

const dir = process.argv[2]
const file = path.join(dir, "package.json")

const deps = {
  "@opencode-ai/plugin": "1.1.51",
  "@opencode-ai/sdk": "1.2.24",
  "nostr-tools": "2.23.3",
  "xdg-basedir": "5.1.0",
}

let pkg = {}
if (fs.existsSync(file)) {
  pkg = JSON.parse(fs.readFileSync(file, "utf8"))
}

pkg.dependencies = { ...(pkg.dependencies || {}), ...deps }
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n")
JS

if command -v bun >/dev/null 2>&1; then
  bun install --cwd "${CFG_DIR}"
else
  echo "bun not found in PATH; please install dependencies manually in ${CFG_DIR}"
fi

cat <<EOF

Install complete.

Next steps:
1. Ensure your OpenCode config includes provider allowlist entry: nostr-bridge
2. Restart OpenCode
3. Run: opencode auth login
4. Run: ocmux start
5. Optional auto-start (disabled by default):
   systemctl --user daemon-reload
   systemctl --user enable --now opencode-tmux.service
6. Termux aliases template: ${CFG_DIR}/termux-opencode-aliases.sh

EOF
