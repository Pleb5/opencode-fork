# Nostr Bridge Pack

This pack installs the OpenCode Nostr bridge plugin, `/nostr` command, and `nak` skill.

It installs these files into your OpenCode config directory:

- `plugins/nostr-bridge.ts`
- `command/nostr.md`
- `skills/nak/SKILL.md`
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
2. `opencode providers login --provider nostr-bridge`
3. In TUI run `/nostr on`

## Publish checklist

1. Push branch with plugin + command + skill + this pack.
2. Tag release (for stable installer URL).
3. Update installer `REF` in docs to tag.
4. Share quick-install command in ecosystem post.
