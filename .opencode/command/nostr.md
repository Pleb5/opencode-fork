---
description: control the local Nostr bridge
---

Use the `nostr_bridge` tool exactly once.

Interpret `$ARGUMENTS` as:

- empty or `status` -> action `status`
- `help` -> action `help`
- `on` -> action `enable`
- `off` -> action `disable`
- `relay <wss://...[,wss://...]>` -> action `set_relay` with `value`
- `recipient <npub1...>` -> action `set_recipient` with `value`
- `refresh` -> action `refresh`
- `session <sessionID>` -> action `set_session` with `value`
- `mode <build|plan>` -> action `set_mode` with `value`
- `mode clear` -> action `set_mode` with `value` = `clear`
- `model <provider/model>` -> action `set_model` with `value`
- `model clear` -> action `set_model` with `value` = `clear`
- `variant <name>` -> action `set_variant` with `value`
- `variant clear` -> action `set_variant` with `value` = `clear`
- `undo [messageID]` -> action `undo` with optional `value`
- `redo` -> action `redo`
- `stop` -> action `stop`

If arguments do not match any form, run action `help`.

Return only the tool result.
