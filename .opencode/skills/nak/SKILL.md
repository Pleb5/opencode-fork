---
name: nak
description: Run local nak workflows for Nostr
---

Use this skill when the user asks for Nostr relay queries, event debugging, or DM inspection with `nak`.

## Tool

- Use `nak` for all actions in this skill.

## Pattern

1. Build the exact `nak` arguments for the user goal.
2. Run the `nak` tool once.
3. Return the key result lines and next useful command.

## Notes

- If an agent identity `nsec` is available, prefer using it with `nak --sec <nsec>` so relay actions use the same identity.
- Never print or echo secret keys in responses.
- Prefer read-only relay operations unless the user asks to publish.
- Keep output concise and focused on event IDs, authors, kinds, and timestamps.
