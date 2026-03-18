# Nostr Bridge Pack

This pack installs the OpenCode Nostr bridge plugin, `/nostr` command, `nak` skill, and a tmux launcher for laptop + phone handoff.

It installs these files into your OpenCode config directory:

- `plugins/nostr-bridge.ts`
- `command/nostr.md`
- `skills/nak/SKILL.md`
- `~/.local/bin/opencode-tmux`
- `~/.local/bin/ocmux`
- `~/.config/systemd/user/opencode-tmux.service` (installed, not enabled)
- `termux-opencode-aliases.sh` template in your OpenCode config dir
- dependency merge into `package.json`

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/Pleb5/opencode-fork/nostr-bridge-summary/extras/nostr-bridge-pack/install.sh | bash
```

## Install from specific ref

```bash
REPO=Pleb5/opencode-fork REF=<tag-or-branch> \
  curl -fsSL https://raw.githubusercontent.com/Pleb5/opencode-fork/<tag-or-branch>/extras/nostr-bridge-pack/install.sh | bash
```

## Install to custom config dir

```bash
CFG_DIR=/path/to/opencode-config \
  curl -fsSL https://raw.githubusercontent.com/Pleb5/opencode-fork/nostr-bridge-summary/extras/nostr-bridge-pack/install.sh | bash
```

## Required config

If you use `enabled_providers`, include `nostr-bridge`:

```json
{
  "enabled_providers": ["opencode", "openai", "nostr-bridge"]
}
```

## First Run

1. Restart OpenCode
2. `opencode auth login`
3. Launch OpenCode in tmux: `ocmux start`
4. Verify bridge status in the TUI with `/nostr status`

The launcher sends `/nostr on` when it creates a fresh tmux session. You can disable this by setting:

```bash
export OPENCODE_BRIDGE_ON_START=0
```

## Daily Workflow

- Laptop: run `ocmux start`
- Termux: `ssh -t <user>@<host> "~/.local/bin/ocmux attach"`
- Handoff is instant because `tmux attach -d` detaches the other client and takes over the same session.

`opencode-tmux` restarts the target session by default before starting. Use `--keep` when you only want to attach without recreating the session.

`ocmux start` and `ocmux stop` also clean up any active reverse tunnel managed by `ocmux`.

## Reverse tunnel workflow

Use localhost bind on the jump server (recommended):

```bash
ocmux tunnel setup
```

Then:

```bash
ocmux start --tunnel
```

One-off host argument (ad-hoc profile):

```bash
ocmux start --tunnel-host user@jump.example.com --remote-port 22022
```

Status includes tunnel state by default:

```bash
ocmux status
```

## Optional systemd user startup

The service file is installed but disabled by default.

```bash
systemctl --user daemon-reload
systemctl --user enable --now opencode-tmux.service
```

To stop/disable:

```bash
systemctl --user disable --now opencode-tmux.service
```

## Termux aliases

Copy and edit the template:

```bash
cp ~/.config/opencode/termux-opencode-aliases.sh ~/.bash_aliases
```

## Publish checklist

1. Push branch with plugin + command + skill + this pack.
2. Tag release (for stable installer URL).
3. Update installer `REF` in docs to tag.
4. Share quick-install command in ecosystem post.
