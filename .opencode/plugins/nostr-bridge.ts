import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import * as nip19 from "nostr-tools/nip19"
import * as nip44 from "nostr-tools/nip44"
import { SimplePool } from "nostr-tools/pool"
import { mkdir } from "fs/promises"
import os from "os"
import path from "path"
import { xdgData, xdgState } from "xdg-basedir"

const ID = "nostr-bridge"
const KIND = 4444
const KIND_RELAYS = 10050
const KIND_OUTBOX = 10002
const KEEP = 2000
const DIR_RELAYS = ["wss://nos.lol", "wss://relay.damus.io", "wss://purplepag.es"]

type Cfg = {
  enabled: boolean
  self_relays: string[]
  peer_relays: string[]
  peer_npub: string
  self_npub: string
  session_id?: string
  mode?: string
  model?: {
    providerID: string
    modelID: string
  }
  variant?: string
  since: number
  seen: string[]
  last_fetch: number
  last_error?: string
}

type Dm = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
}

type Key = {
  sec: Uint8Array
  pub: string
  peer?: string
}

type Run = {
  start: number
  user: Set<string>
  bot: Set<string>
  seen: Set<string>
  tools: Record<string, number>
  text: string
  reason: string
  err: string
  title: string
  diff: {
    files: number
    add: number
    del: number
  }
}

const base = (): Cfg => ({
  enabled: false,
  self_relays: [],
  peer_relays: [],
  peer_npub: "",
  self_npub: "",
  mode: undefined,
  model: undefined,
  variant: undefined,
  since: 0,
  seen: [],
  last_fetch: 0,
  last_error: undefined,
})

const obj = (val: unknown) => {
  if (typeof val !== "object" || val === null) return undefined
  return val as Record<string, unknown>
}

const text = (val: unknown) => {
  if (typeof val !== "string") return undefined
  return val
}

const num = (val: unknown) => {
  if (typeof val !== "number" || !Number.isFinite(val)) return 0
  return val
}

const time = (input: number) => {
  return new Date(input).toLocaleTimeString(undefined, { timeStyle: "short" })
}

const day = (input: number) => {
  const date = new Date(input)
  const now = new Date()
  const today =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  if (today) return "Today"
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })
}

const normRelay = (val: string) => {
  const next = val.trim()
  if (next.startsWith("ws://") || next.startsWith("wss://")) return next
  return ""
}

const normRelays = (val: string[]) => {
  return [...new Set(val.map(normRelay).filter(Boolean))]
}

const parseRelays = (val: string) => {
  return normRelays(
    val
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean),
  )
}

const decodeNpub = (val: string) => {
  if (!nip19.NostrTypeGuard.isNPub(val)) return undefined
  const dec = nip19.decode(val)
  if (dec.type !== "npub") return undefined
  return dec.data
}

const decodeNsec = (val: string) => {
  if (!nip19.NostrTypeGuard.isNSec(val)) return undefined
  const dec = nip19.decode(val)
  if (dec.type !== "nsec") return undefined
  return dec.data
}

const parseModel = (val: string) => {
  const item = val.trim()
  if (!item) return undefined
  const idx = item.indexOf("/")
  if (idx <= 0 || idx === item.length - 1) return undefined
  const providerID = item.slice(0, idx).trim()
  const modelID = item.slice(idx + 1).trim()
  if (!providerID || !modelID) return undefined
  return {
    providerID,
    modelID,
  }
}

const formatModel = (val?: { providerID: string; modelID: string }) => {
  if (!val) return "(default)"
  return `${val.providerID}/${val.modelID}`
}

const pickOpt = (val: unknown, keys: string[]) => {
  const cfg = obj(val)
  if (!cfg) return undefined
  for (const key of keys) {
    const hit = cfg[key]
    if (typeof hit === "string") return hit
    if (typeof hit === "number") return String(hit)
    if (typeof hit === "boolean") return String(hit)
  }
  return undefined
}

const pickReasoning = (val: unknown) => {
  const direct = pickOpt(val, ["reasoningEffort", "reasoning_effort", "reasoning_effort_mode", "effort"])
  if (direct) return direct
  const cfg = obj(val)
  const nested = obj(cfg?.reasoning)
  return pickOpt(nested, ["effort", "level"])
}

const watch = new Set([
  "session.status",
  "session.error",
  "session.diff",
  "session.created",
  "session.updated",
  "message.updated",
  "message.part.updated",
  "tui.session.select",
])

const make = () => ({
  start: Date.now(),
  user: new Set<string>(),
  bot: new Set<string>(),
  seen: new Set<string>(),
  tools: {},
  text: "",
  reason: "",
  err: "",
  title: "",
  diff: {
    files: 0,
    add: 0,
    del: 0,
  },
})

export const NostrBridge: Plugin = async (input) => {
  const home_data = xdgData ?? path.join(os.homedir(), ".local/share")
  const home_state = xdgState ?? path.join(os.homedir(), ".local/state")
  const data_dir = path.join(home_data, "opencode")
  const state_dir = path.join(home_state, "opencode")
  const auth_file = path.join(data_dir, "auth.json")
  const cfg_file = path.join(state_dir, "nostr-bridge.json")
  const model_file = path.join(state_dir, "model.json")

  await mkdir(state_dir, { recursive: true })

  const api = () => input.client

  const pool = new SimplePool({
    enablePing: true,
    enableReconnect: true,
  })

  let cfg = await Bun.file(cfg_file)
    .json<Partial<Cfg> & { relay?: string }>()
    .then((x) => ({
      ...base(),
      ...x,
      self_relays: normRelays(
        Array.isArray(x.self_relays) ? x.self_relays : typeof x.relay === "string" ? [x.relay] : [],
      ),
      peer_relays: normRelays(Array.isArray(x.peer_relays) ? x.peer_relays : []),
      seen: Array.isArray(x.seen) ? x.seen : [],
      last_fetch: typeof x.last_fetch === "number" ? x.last_fetch : 0,
      last_error: typeof x.last_error === "string" ? x.last_error : undefined,
    }))
    .catch(base)

  const run = new Map<string, Run>()
  let route_err = ""
  let sub: { close: (reason?: string) => void } | undefined
  let wait: ReturnType<typeof setTimeout> | undefined

  const apiErr = (label: string, val: any) => {
    if (val && typeof val === "object") {
      if ("response" in val && !val.response && "request" in val) {
        return `${label}: no response from opencode runtime`
      }
      const err = val.error
      if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
        return `${label}: ${err.message}`
      }
      if (typeof err === "string") {
        return `${label}: ${err}`
      }
    }
    return `${label}: request failed`
  }

  const save = () => {
    if (wait) return
    wait = setTimeout(() => {
      wait = undefined
      void Bun.write(cfg_file, JSON.stringify(cfg, null, 2))
    }, 200)
  }

  const saveNow = async () => {
    if (wait) {
      clearTimeout(wait)
      wait = undefined
    }
    await Bun.write(cfg_file, JSON.stringify(cfg, null, 2))
  }

  const defaultModel = (val: unknown) => {
    return text(obj(val)?.model)
  }

  const defaultVariant = (val: unknown) => {
    const cfg = obj(val)
    if (!cfg) return undefined
    const id = text(cfg.default_agent) ?? "build"
    const agent = obj(cfg.agent)
    const mode = obj(cfg.mode)
    const hit = text(obj(agent?.[id])?.variant) ?? text(obj(mode?.[id])?.variant)
    if (hit) return hit
    return text(obj(agent?.build)?.variant) ?? text(obj(mode?.build)?.variant)
  }

  const defaultMode = (val: unknown) => {
    const cfg = obj(val)
    if (!cfg) return "build"
    return text(cfg.default_agent) ?? "build"
  }

  const signer = async () => {
    const row = await Bun.file(auth_file)
      .json<Record<string, { type?: string; key?: string }>>()
      .then((x) => x[ID])
      .catch(() => undefined)

    if (!row || row.type !== "api" || !row.key) return undefined
    const sec = decodeNsec(row.key)
    if (!sec) return undefined

    const pub = getPublicKey(sec)
    const self_npub = nip19.npubEncode(pub)
    if (cfg.self_npub !== self_npub) {
      cfg.self_npub = self_npub
      save()
    }

    return {
      sec,
      pub,
      peer: decodeNpub(cfg.peer_npub),
    } satisfies Key
  }

  const toast = async (message: string) => {
    await api()
      .tui.showToast({
        body: {
          title: "Nostr bridge",
          message,
          variant: "error",
          duration: 9000,
        },
      })
      .catch(() => undefined)
  }

  const relayTags = (tags: string[][]) => {
    return normRelays(tags.filter((x) => x[0] === "relay" || x[0] === "r").map((x) => x[1] ?? ""))
  }

  const query = async (relays: string[], pubkey: string, kind: number) => {
    if (relays.length === 0) return []
    return pool
      .querySync(
        relays,
        {
          kinds: [kind],
          authors: [pubkey],
          limit: 20,
        },
        { maxWait: 3000 },
      )
      .then((x) => x)
      .catch(() => [])
  }

  const resolvePeerRelays = async (pubkey: string) => {
    const hints = normRelays([...DIR_RELAYS, ...cfg.self_relays, ...cfg.peer_relays])
    const direct = await query(hints, pubkey, KIND_RELAYS)
    const outboxEvents = await query(hints, pubkey, KIND_OUTBOX)
    const outbox = normRelays(outboxEvents.flatMap((x) => relayTags(x.tags)))
    const viaOutbox = await query(outbox, pubkey, KIND_RELAYS)
    const merged = [...direct, ...viaOutbox].sort((a, b) => b.created_at - a.created_at)
    for (const item of merged) {
      const relays = relayTags(item.tags)
      if (relays.length > 0) return relays
    }
    throw new Error("recipient kind 10050 inbox relays not found")
  }

  const publishSelfRelays = async (key: Key, relays: string[]) => {
    const tags = relays.map((x) => ["relay", x])
    const evt = finalizeEvent(
      {
        kind: KIND_RELAYS,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: "",
      },
      key.sec,
    )
    const target = normRelays([...DIR_RELAYS, ...relays])
    if (target.length === 0) throw new Error("no directory relays available for kind 10050 publish")
    const ok = await Promise.any(pool.publish(target, evt))
      .then(() => true)
      .catch(() => false)
    if (!ok) throw new Error("failed to publish kind 10050 relay list")
  }

  const refreshPeer = async (reason: string, showUI = true) => {
    const peer = decodeNpub(cfg.peer_npub)
    if (!peer) throw new Error("recipient npub is not configured")
    try {
      const relays = await resolvePeerRelays(peer)
      cfg.peer_relays = relays
      cfg.last_fetch = Date.now()
      cfg.last_error = undefined
      await saveNow()
      return relays
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      cfg.last_fetch = Date.now()
      cfg.last_error = message
      await saveNow()
      if (showUI) {
        await toast(
          `Recipient inbox relay fetch failed (${reason}). Run /nostr refresh or /nostr recipient <npub1...>.`,
        )
      }
      throw new Error(message)
    }
  }

  let prepared = ""
  const prepare = async (sid: string) => {
    if (!cfg.enabled) return
    if (prepared === sid && cfg.peer_relays.length > 0) return
    prepared = sid
    await refreshPeer(`session ${sid}`, true)
  }

  const send = async (body: string) => {
    if (!cfg.enabled) return false

    const key = await signer()
    if (!key || !key.peer) return false

    const relays = cfg.peer_relays.length > 0 ? cfg.peer_relays : await refreshPeer("send", false).catch(() => [])
    if (relays.length === 0) return false

    const conv = nip44.getConversationKey(key.sec, key.peer)
    const content = nip44.encrypt(body, conv)
    const evt = finalizeEvent(
      {
        kind: KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", key.peer]],
        content,
      },
      key.sec,
    )

    return Promise.any(pool.publish(relays, evt))
      .then(() => true)
      .catch(() => false)
  }

  const title = async (sid: string, state: Run) => {
    if (state.title) return
    const hit = await api()
      .session.get({ path: { id: sid } })
      .then((x) => x.data?.title)
      .catch(() => undefined)
    if (!hit) return
    state.title = hit
  }

  const start = (sid: string) => {
    const hit = run.get(sid)
    if (hit) return hit

    const next = make()
    run.set(sid, next)
    cfg.session_id = sid
    save()
    void prepare(sid).catch(() => undefined)
    void title(sid, next)
    return next
  }

  const pick = async () => {
    if (cfg.session_id) {
      const res = await api()
        .session.get({ path: { id: cfg.session_id } })
        .catch((error) => ({ error }))
      const ok = Boolean(res?.data?.id)
      if (ok) return cfg.session_id
      route_err = apiErr("session.get", res)
    }

    const list = await api()
      .session.list()
      .catch((error) => ({ error }))
    const hit = list?.data?.[0]?.id
    if (hit) {
      cfg.session_id = hit
      save()
      route_err = ""
      return hit
    }
    route_err = apiErr("session.list", list)

    const create = await api()
      .session.create({ body: {} })
      .catch((error) => ({ error }))
    const made = create?.data?.id
    if (!made) {
      route_err = apiErr("session.create", create)
      return undefined
    }

    cfg.session_id = made
    save()
    route_err = ""
    return made
  }

  const active = async () => {
    const sid = cfg.session_id
    if (sid) {
      const map = await api()
        .session.status()
        .then((x) => x.data ?? {})
        .catch(() => ({}))
      if (map[sid]?.type === "busy") return sid
    }
    const map = await api()
      .session.status()
      .then((x) => x.data ?? {})
      .catch(() => ({}))
    for (const [id, val] of Object.entries(map)) {
      if (val.type === "busy") return id
    }
    return undefined
  }

  const last = async (sid: string) => {
    const rows = await api()
      .session.messages({ path: { id: sid }, query: { limit: 100 } })
      .then((x) => x.data ?? [])
      .catch(() => [])
    for (let i = rows.length - 1; i >= 0; i--) {
      const info = rows[i]?.info
      if (info?.role !== "assistant") continue
      if (!info.id) continue
      return info.id
    }
    return undefined
  }

  const recent = async (sid: string) => {
    const rows = await api()
      .session.messages({ path: { id: sid }, query: { limit: 30 } })
      .then((x) => x.data ?? [])
      .catch(() => [])
    for (let i = rows.length - 1; i >= 0; i--) {
      const info = rows[i]?.info
      if (!info) continue
      if (info.role === "user") {
        const model = obj(info.model)
        const providerID = text(model?.providerID)
        const modelID = text(model?.modelID)
        return {
          model: providerID && modelID ? `${providerID}/${modelID}` : undefined,
          variant: text(info.variant),
          mode: text(info.agent),
        }
      }
      if (info.role === "assistant") {
        const providerID = text(info.providerID)
        const modelID = text(info.modelID)
        return {
          model: providerID && modelID ? `${providerID}/${modelID}` : undefined,
          variant: text(info.variant),
          mode: text(info.mode),
        }
      }
    }
    return {
      model: undefined,
      variant: undefined,
      mode: undefined,
    }
  }

  const recentAny = async () => {
    const rows = await api()
      .session.list()
      .then((x) => x.data ?? [])
      .catch(() => [])
    for (const row of rows.slice(0, 8)) {
      const sid = text(row?.id)
      if (!sid) continue
      const hit = await recent(sid)
      if (hit.model || hit.variant || hit.mode) return hit
    }
    return {
      model: undefined,
      variant: undefined,
      mode: undefined,
    }
  }

  const info = async (val: string | undefined) => {
    const model = val ? parseModel(val) : undefined
    if (!model) {
      return {
        provider: "(unset)",
        api: "(unset)",
        npm: "(unset)",
        reasoning: "(unset)",
        variants: "(unset)",
      }
    }

    const rows =
      (await api()
        .provider.list()
        .then((x) => x.data?.all ?? [])
        .catch(() => [])) || []
    const all =
      rows.length > 0
        ? rows
        : await Promise.resolve()
            .then(() => api().provider.list())
            .then((x) => x?.data?.all ?? [])
            .catch(() => [])
    const provider = all.find((row: any) => row.id === model.providerID)
    if (!provider) {
      return {
        provider: model.providerID,
        api: "(unset)",
        npm: "(unset)",
        reasoning: "(unset)",
        variants: "(unset)",
      }
    }

    const item = provider.models?.[model.modelID]
    if (!item) {
      return {
        provider: provider.name ? `${provider.id} (${provider.name})` : provider.id,
        api: text(provider.api) ?? "(unset)",
        npm: text(provider.npm) ?? "(unset)",
        reasoning: "(unset)",
        variants: "(unset)",
      }
    }

    return {
      provider: provider.name ? `${provider.id} (${provider.name})` : provider.id,
      api: text(obj(item.provider)?.api) ?? text(provider.api) ?? "(unset)",
      npm: text(obj(item.provider)?.npm) ?? text(provider.npm) ?? "(unset)",
      reasoning: pickReasoning(item.options) ?? "(unset)",
      variants: (() => {
        const keys = Object.keys(item.variants ?? {})
        if (keys.length === 0) return "(none)"
        return keys.join(",")
      })(),
    }
  }

  const localVariant = async (model: string | undefined) => {
    if (!model) return undefined
    const map = await Bun.file(model_file)
      .json<{ variant?: Record<string, unknown> }>()
      .then((x) => obj(x.variant))
      .catch(() => undefined)
    return text(map?.[model])
  }

  const report = (sid: string, state: Run) => {
    const sec = Math.max(1, Math.round((Date.now() - state.start) / 1000))
    const why = state.err || state.reason || "completed"
    const tools = Object.entries(state.tools)
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `${key}:${count}`)
      .join(", ")

    return [
      "opencode run stopped",
      `session: ${sid}${state.title ? ` (${state.title})` : ""}`,
      `reason: ${why}`,
      `duration: ${sec}s`,
      `messages: user=${state.user.size} assistant=${state.bot.size}`,
      `tools: ${tools || "none"}`,
      `diff: files=${state.diff.files} +${state.diff.add} -${state.diff.del}`,
      state.text ? `assistant: ${state.text}` : "assistant: (no text)",
    ].join("\n")
  }

  const stop = async (sid: string) => {
    const state = run.get(sid)
    if (!state) return
    run.delete(sid)
    await title(sid, state)
    await send(report(sid, state))
  }

  const show = async () => {
    const key = await signer()
    const raw =
      (await api()
        .config.get()
        .then((x) => x.data)
        .catch(() => undefined)) ??
      (await input.client.config
        .get()
        .then((x) => x.data)
        .catch(() => undefined))
    const sid = cfg.session_id ?? "(none)"
    const hit = cfg.session_id
      ? await recent(cfg.session_id)
      : { model: undefined, variant: undefined, mode: undefined }
    const any = hit.model || hit.variant || hit.mode ? hit : await recentAny()
    const on = cfg.enabled ? "on" : "off"
    const self_relays = cfg.self_relays.length > 0 ? cfg.self_relays.join(",") : "(unset)"
    const peer_relays = cfg.peer_relays.length > 0 ? cfg.peer_relays.join(",") : "(unset)"
    const peer = cfg.peer_npub || "(unset)"
    const me = cfg.self_npub || (key ? nip19.npubEncode(key.pub) : "(connect first)")
    const model_override = cfg.model ? formatModel(cfg.model) : "(none)"
    const model_effective = cfg.model
      ? formatModel(cfg.model)
      : (defaultModel(raw) ?? hit.model ?? any.model ?? "(unset)")
    const details = await info(model_effective === "(unset)" ? undefined : model_effective)
    const local = await localVariant(model_effective === "(unset)" ? undefined : model_effective)
    const variant_override = cfg.variant ?? "(none)"
    const variant_effective =
      cfg.variant ??
      defaultVariant(raw) ??
      hit.variant ??
      any.variant ??
      local ??
      (details.reasoning !== "(unset)" ? details.reasoning : "(unset)")
    const mode_override = cfg.mode ?? "(none)"
    const mode_effective = cfg.mode ?? hit.mode ?? any.mode ?? defaultMode(raw)
    return [
      `bridge: ${on}`,
      `self: ${me}`,
      `recipient: ${peer}`,
      `self_relays: ${self_relays}`,
      `recipient_relays: ${peer_relays}`,
      `recipient_fetch: ${cfg.last_fetch ? new Date(cfg.last_fetch).toISOString() : "(never)"}`,
      `recipient_error: ${cfg.last_error ?? "(none)"}`,
      `session: ${sid}`,
      `model_override: ${model_override}`,
      `model_effective: ${model_effective}`,
      `provider_effective: ${details.provider}`,
      `provider_api: ${details.api}`,
      `provider_npm: ${details.npm}`,
      `reasoning_effort_effective: ${details.reasoning}`,
      `mode_override: ${mode_override}`,
      `mode_effective: ${mode_effective}`,
      `variant_override: ${variant_override}`,
      `variant_effective: ${variant_effective}`,
      `variant_available: ${details.variants}`,
      `active_runs: ${run.size}`,
    ].join("\n")
  }

  const help = () => {
    return [
      "oc help",
      "oc status",
      "oc refresh",
      "oc sessions [limit]",
      "oc use <sessionID>",
      "oc new [title]",
      "oc mode <build|plan>|clear",
      "oc model <provider/model>|clear",
      "oc variant <name>|clear",
      "oc undo [messageID]",
      "oc redo",
      "oc stop",
      "oc compact",
    ].join("\n")
  }

  const guide = () => {
    return [
      "status",
      "enable",
      "disable",
      "set_relay <wss://...[,wss://...]>",
      "set_recipient <npub1...>",
      "refresh",
      "set_session <sessionID>",
      "set_mode <build|plan>|clear",
      "set_model <provider/model>|clear",
      "set_variant <name>|clear",
      "undo [messageID]",
      "redo",
      "stop",
      "",
      "phone commands:",
      help(),
    ].join("\n")
  }

  const ctl = async (raw: string) => {
    const line = raw.trim()
    if (!line.toLowerCase().startsWith("oc ")) return undefined

    const args = line.slice(3).trim()
    if (!args) return help()

    const part = args.split(/\s+/)
    const cmd = part[0]
    const val = part.slice(1).join(" ").trim()

    if (cmd === "help") return help()

    if (cmd === "status") {
      return show()
    }

    if (cmd === "refresh") {
      await refreshPeer("remote command", true)
      return `recipient relays refreshed (${cfg.peer_relays.length})`
    }

    if (cmd === "sessions") {
      const max = (() => {
        const n = Number(part[1] ?? "8")
        if (!Number.isFinite(n) || n < 1) return 8
        return Math.floor(n)
      })()

      const res = await api()
        .session.list()
        .catch((error) => ({ error }))
      const rows = (res?.data ?? [])
        .filter((x) => x.parentID === undefined)
        .toSorted((a, b) => b.time.updated - a.time.updated)
        .slice(0, max)
      if (rows.length === 0) {
        const info = apiErr("session.list", res)
        return info.includes("no response") ? `no sessions\n${info}` : "no sessions"
      }

      const out: string[] = []
      let current = ""
      for (const row of rows) {
        const label = day(row.time.updated)
        if (label !== current) {
          if (out.length > 0) out.push("")
          out.push(label)
          current = label
        }
        out.push("name:")
        out.push(row.title || "(untitled)")
        out.push("session_id:")
        out.push(`${row.id === cfg.session_id ? "* " : ""}${row.id}`)
        out.push(time(row.time.updated))
      }
      return out.join("\n")
    }

    if (cmd === "use") {
      if (!val) return "usage: oc use <sessionID>"
      const res = await api()
        .session.get({ path: { id: val } })
        .catch((error) => ({ error }))
      const ok = Boolean(res?.data?.id)
      if (!ok) {
        const info = apiErr("session.get", res)
        if (info.includes("no response")) return `session lookup failed\n${info}`
        return `session not found: ${val}`
      }

      cfg.session_id = val
      save()
      await prepare(val).catch(() => undefined)
      return `session selected: ${val}`
    }

    if (cmd === "new") {
      const res = await api()
        .session.create({
          body: {
            title: val || undefined,
          },
        })
        .catch((error) => ({ error }))
      const made = res?.data?.id
      if (!made) return `failed to create session\n${apiErr("session.create", res)}`

      cfg.session_id = made
      save()
      await prepare(made).catch(() => undefined)
      return `session created: ${made}`
    }

    if (cmd === "mode") {
      if (!val) {
        return `mode: ${cfg.mode ?? "(default)"}`
      }
      if (val === "clear" || val === "default" || val === "off") {
        cfg.mode = undefined
        save()
        return "mode reset to default"
      }
      const next = val.toLowerCase()
      if (next !== "build" && next !== "plan") return "usage: oc mode <build|plan>|clear"
      cfg.mode = next
      save()
      return `mode set: ${next}`
    }

    if (cmd === "model") {
      if (!val) {
        return `model: ${formatModel(cfg.model)}`
      }
      if (val === "clear" || val === "default" || val === "off") {
        cfg.model = undefined
        save()
        return "model reset to default"
      }
      const next = parseModel(val)
      if (!next) return "usage: oc model <provider/model>|clear"
      cfg.model = next
      save()
      return `model set: ${formatModel(next)}`
    }

    if (cmd === "variant") {
      if (!val) {
        return `variant: ${cfg.variant ?? "(default)"}`
      }
      if (val === "clear" || val === "default" || val === "off") {
        cfg.variant = undefined
        save()
        return "variant reset to default"
      }
      cfg.variant = val
      save()
      return `variant set: ${val}`
    }

    if (cmd === "undo") {
      const sid = cfg.session_id ?? (await pick())
      if (!sid) return "no session available"
      const id = val || (await last(sid))
      if (!id) return "no assistant message to undo"
      const ok = await api()
        .session.revert({ path: { id: sid }, body: { messageID: id } })
        .then(() => true)
        .catch(() => false)
      if (!ok) return `undo failed: ${id}`
      return `undone: ${id}`
    }

    if (cmd === "redo") {
      const sid = cfg.session_id ?? (await pick())
      if (!sid) return "no session available"
      const ok = await api()
        .session.unrevert({ path: { id: sid } })
        .then(() => true)
        .catch(() => false)
      if (!ok) return "redo failed"
      return "redo complete"
    }

    if (cmd === "stop") {
      const sid = (await active()) ?? cfg.session_id
      if (!sid) return "no active session"
      const ok = await api()
        .session.abort({ path: { id: sid } })
        .then(() => true)
        .catch(() => false)
      if (!ok) return `stop failed: ${sid}`
      return `stop requested: ${sid}`
    }

    if (cmd === "compact") {
      const sid = cfg.session_id ?? (await pick())
      if (!sid) return "no session available"
      const ok = await api()
        .session.command({
          path: { id: sid },
          body: {
            command: "session_compact",
            arguments: "",
          },
        })
        .then(() => true)
        .catch(() => false)
      if (!ok) return `compact failed: ${sid}`
      return `compact requested: ${sid}`
    }

    return `unknown command: ${cmd}`
  }

  const onmsg = async (evt: Dm) => {
    if (!cfg.enabled) return
    if (evt.kind !== KIND) return
    if (cfg.seen.includes(evt.id)) return

    cfg.seen.push(evt.id)
    if (cfg.seen.length > KEEP) {
      cfg.seen = cfg.seen.slice(-KEEP)
    }

    if (evt.created_at > cfg.since) {
      cfg.since = evt.created_at
    }

    const key = await signer()
    if (!key) {
      save()
      return
    }

    const mine = evt.tags.find((tag) => tag[0] === "p")?.[1] === key.pub
    if (!mine) {
      save()
      return
    }

    if (evt.pubkey === key.pub) {
      save()
      return
    }

    if (key.peer && evt.pubkey !== key.peer) {
      save()
      return
    }

    const msg = await Promise.resolve()
      .then(() => {
        const conv = nip44.getConversationKey(key.sec, evt.pubkey)
        return nip44.decrypt(evt.content, conv)
      })
      .catch(() => "")

    if (!msg) {
      save()
      return
    }

    const out = await ctl(msg.trim())
    if (out !== undefined) {
      await send(out)
      save()
      return
    }

    const sid = await pick()
    if (!sid) {
      await send(`failed to route prompt${route_err ? `\n${route_err}` : ""}`)
      save()
      return
    }

    cfg.session_id = sid
    save()

    const ready = await prepare(sid)
      .then(() => true)
      .catch(() => false)
    if (!ready) {
      await send("recipient relay discovery failed\nrun /nostr refresh or /nostr recipient <npub1...>")
      return
    }

    await api()
      .session.prompt({
        path: { id: sid },
        body: {
          agent: cfg.mode,
          model: cfg.model,
          variant: cfg.variant,
          parts: [
            {
              type: "text",
              text: msg,
            },
          ],
        },
      })
      .catch(() => undefined)

    save()
  }

  const subon = async () => {
    sub?.close("reset")
    sub = undefined

    if (!cfg.enabled) return

    const key = await signer()
    if (!key || !key.peer) return

    const relays = cfg.self_relays
    if (relays.length === 0) return

    const since = cfg.since || Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 14
    const filter = {
      kinds: [KIND],
      authors: [key.peer],
      ["#p"]: [key.pub],
      since,
    }

    sub = pool.subscribeMany(relays, filter, {
      onevent: (evt) => {
        void onmsg(evt as Dm)
      },
      onclose: () => {
        sub = undefined
      },
    })
  }

  void subon()

  return {
    auth: {
      provider: ID,
      methods: [
        {
          type: "api",
          label: "Nostr nsec",
          prompts: [
            {
              type: "text",
              key: "nsec",
              message: "Enter your nsec",
              placeholder: "nsec1...",
              validate: (val) => {
                if (decodeNsec(val)) return undefined
                return "Expected a valid nsec1... key"
              },
            },
            {
              type: "text",
              key: "relays",
              message: "Enter DM inbox relays",
              placeholder: "wss://relay.one,wss://relay.two",
              validate: (val) => {
                if (parseRelays(val).length > 0) return undefined
                return "Expected one or more ws:// or wss:// relay URLs"
              },
            },
            {
              type: "text",
              key: "recipient",
              message: "Enter recipient npub",
              placeholder: "npub1...",
              validate: (val) => {
                if (decodeNpub(val)) return undefined
                return "Expected a valid npub1... key"
              },
            },
          ],
          async authorize(val) {
            const key = val?.nsec?.trim()
            const relays = parseRelays(val?.relays ?? "")
            const recipient = val?.recipient?.trim() ?? ""
            if (!key || !decodeNsec(key)) {
              return { type: "failed" }
            }
            if (relays.length === 0 || !decodeNpub(recipient)) {
              return { type: "failed" }
            }

            const sec = decodeNsec(key)
            if (!sec) {
              return { type: "failed" }
            }

            cfg.self_npub = nip19.npubEncode(getPublicKey(sec))
            cfg.self_relays = relays
            cfg.peer_npub = recipient
            cfg.peer_relays = []
            cfg.last_error = undefined
            cfg.last_fetch = 0
            await saveNow()

            const signer: Key = {
              sec,
              pub: getPublicKey(sec),
              peer: decodeNpub(recipient),
            }
            const published = await publishSelfRelays(signer, relays)
              .then(() => true)
              .catch((err) => {
                cfg.last_error = err instanceof Error ? err.message : String(err)
                return false
              })
            if (!published) {
              await saveNow()
              return { type: "failed" }
            }
            await refreshPeer("connect", false).catch(() => undefined)
            if (cfg.enabled) await subon()

            return {
              type: "success",
              key,
            }
          },
        },
      ],
    },

    event: async ({ event }) => {
      const evt = event as {
        type: string
        properties?: unknown
      }

      if (!watch.has(evt.type)) return

      if (evt.type === "tui.session.select") {
        const sid = text(obj(evt.properties)?.sessionID)
        if (!sid) return
        cfg.session_id = sid
        save()
        void prepare(sid).catch(() => undefined)
        return
      }

      if (!cfg.enabled) return

      if (evt.type === "session.status") {
        const sid = text(obj(evt.properties)?.sessionID)
        const state = text(obj(obj(evt.properties)?.status)?.type)
        if (!sid || !state) return

        if (state === "busy") {
          start(sid)
          return
        }

        if (state === "idle") {
          await stop(sid)
        }
        return
      }

      if (evt.type === "session.error") {
        const sid = text(obj(evt.properties)?.sessionID) ?? cfg.session_id
        if (!sid) return
        const state = start(sid)
        const err = obj(obj(evt.properties)?.error)
        const name = text(err?.name) ?? "error"
        const msg = text(obj(err?.data)?.message) ?? ""
        state.err = msg ? `${name}: ${msg}` : name
        return
      }

      if (evt.type === "session.diff") {
        const sid = text(obj(evt.properties)?.sessionID)
        if (!sid) return
        const state = start(sid)
        const rows = obj(evt.properties)?.diff
        if (!Array.isArray(rows)) return
        state.diff.files = rows.length
        state.diff.add = rows.reduce((sum, row) => sum + num(obj(row)?.additions), 0)
        state.diff.del = rows.reduce((sum, row) => sum + num(obj(row)?.deletions), 0)
        return
      }

      if (evt.type === "session.created" || evt.type === "session.updated") {
        const info = obj(obj(evt.properties)?.info)
        const sid = text(info?.id)
        const name = text(info?.title)
        if (!sid) return
        void prepare(sid).catch(() => undefined)
        if (!name) return
        const state = run.get(sid)
        if (!state) return
        state.title = name
        return
      }

      if (evt.type === "message.updated") {
        const info = obj(obj(evt.properties)?.info)
        const sid = text(info?.sessionID)
        const id = text(info?.id)
        const role = text(info?.role)
        if (!sid || !id || !role) return
        const state = run.get(sid)
        if (!state) return

        if (role === "user") {
          state.user.add(id)
          return
        }

        if (role !== "assistant") return
        state.bot.add(id)

        const why = text(info?.finish)
        if (why) state.reason = why

        const err = obj(info?.error)
        if (!err) return
        const name = text(err.name) ?? "error"
        const msg = text(obj(err.data)?.message) ?? ""
        state.err = msg ? `${name}: ${msg}` : name
        return
      }

      if (evt.type !== "message.part.updated") return
      const part = obj(obj(evt.properties)?.part)
      const sid = text(part?.sessionID)
      const typ = text(part?.type)
      if (!sid || !typ) return
      const state = run.get(sid)
      if (!state) return

      if (typ === "step-finish") {
        const why = text(part.reason)
        if (why) state.reason = why
        return
      }

      if (typ === "tool") {
        const pid = text(part.id)
        if (!pid || state.seen.has(pid)) return

        const status = text(obj(part.state)?.status)
        if (status !== "completed") return

        state.seen.add(pid)
        const name = text(part.tool) ?? "tool"
        state.tools[name] = (state.tools[name] ?? 0) + 1
        return
      }

      if (typ !== "text") return
      const mid = text(part.messageID)
      const val = text(part.text)
      if (!mid || !val || !state.bot.has(mid)) return
      state.text = val
    },

    tool: {
      nostr_bridge: tool({
        description: "Manage the local Nostr DM bridge state",
        args: {
          action: tool.schema
            .enum([
              "status",
              "help",
              "enable",
              "disable",
              "set_relay",
              "set_recipient",
              "refresh",
              "set_session",
              "set_mode",
              "set_model",
              "set_variant",
              "undo",
              "redo",
              "stop",
            ])
            .describe("Action to run"),
          value: tool.schema.string().optional().describe("Optional value for set_* actions"),
        },
        async execute(args) {
          if (args.action === "status") return show()
          if (args.action === "help") return guide()

          if (args.action === "enable") {
            if (cfg.self_relays.length === 0) {
              return "set inbox relays first: /nostr relay wss://relay.one,wss://relay.two"
            }
            if (!decodeNpub(cfg.peer_npub)) {
              return "set recipient first: /nostr recipient npub1..."
            }
            cfg.enabled = true
            await refreshPeer("enable", true).catch(() => {
              cfg.enabled = false
            })
            await saveNow()
            await subon()
            if (!cfg.enabled) {
              return "bridge enable failed: recipient relays unavailable, run /nostr refresh"
            }
            return "bridge enabled"
          }

          if (args.action === "disable") {
            cfg.enabled = false
            await saveNow()
            await subon()
            return "bridge disabled"
          }

          if (args.action === "set_relay") {
            const relays = parseRelays(args.value ?? "")
            if (relays.length === 0) return "usage: set_relay + wss://relay.one,wss://relay.two"
            cfg.self_relays = relays
            const key = await signer()
            if (key) {
              const ok = await publishSelfRelays(key, relays)
                .then(() => true)
                .catch(() => false)
              if (!ok) return "failed to publish kind 10050 relay list"
            }
            await saveNow()
            await subon()
            return `self relays set (${relays.length})`
          }

          if (args.action === "set_recipient") {
            const npub = args.value ?? ""
            if (!decodeNpub(npub)) return "usage: set_recipient + npub1..."
            cfg.peer_npub = npub
            cfg.peer_relays = []
            await saveNow()
            await refreshPeer("set_recipient", true).catch(() => undefined)
            await subon()
            return `recipient set to ${npub}`
          }

          if (args.action === "refresh") {
            const relays = await refreshPeer("manual refresh", true)
            await subon()
            return `recipient relays refreshed (${relays.length})`
          }

          if (args.action === "set_session") {
            const sid = args.value ?? ""
            if (!sid) return "usage: set_session + sessionID"
            const ok = await api()
              .session.get({ path: { id: sid } })
              .then((x) => Boolean(x.data?.id))
              .catch(() => false)
            if (!ok) return `session not found: ${sid}`
            cfg.session_id = sid
            save()
            await prepare(sid).catch(() => undefined)
            return `session selected: ${sid}`
          }

          if (args.action === "set_mode") {
            const val = (args.value ?? "").trim().toLowerCase()
            if (!val || val === "clear" || val === "default" || val === "off") {
              cfg.mode = undefined
              save()
              return "mode reset to default"
            }
            if (val !== "build" && val !== "plan") return "usage: set_mode + build|plan|clear"
            cfg.mode = val
            save()
            return `mode set: ${val}`
          }

          if (args.action === "set_model") {
            const val = args.value ?? ""
            if (!val || val === "clear" || val === "default" || val === "off") {
              cfg.model = undefined
              save()
              return "model reset to default"
            }
            const next = parseModel(val)
            if (!next) return "usage: set_model + provider/model"
            cfg.model = next
            save()
            return `model set: ${formatModel(next)}`
          }

          if (args.action === "set_variant") {
            const val = args.value ?? ""
            if (!val || val === "clear" || val === "default" || val === "off") {
              cfg.variant = undefined
              save()
              return "variant reset to default"
            }
            cfg.variant = val
            save()
            return `variant set: ${val}`
          }

          if (args.action === "undo") {
            const sid = cfg.session_id ?? (await pick())
            if (!sid) return "no session available"
            const id = (args.value ?? "").trim() || (await last(sid))
            if (!id) return "no assistant message to undo"
            const ok = await api()
              .session.revert({ path: { id: sid }, body: { messageID: id } })
              .then(() => true)
              .catch(() => false)
            if (!ok) return `undo failed: ${id}`
            return `undone: ${id}`
          }

          if (args.action === "redo") {
            const sid = cfg.session_id ?? (await pick())
            if (!sid) return "no session available"
            const ok = await api()
              .session.unrevert({ path: { id: sid } })
              .then(() => true)
              .catch(() => false)
            if (!ok) return "redo failed"
            return "redo complete"
          }

          if (args.action === "stop") {
            const sid = (await active()) ?? cfg.session_id
            if (!sid) return "no active session"
            const ok = await api()
              .session.abort({ path: { id: sid } })
              .then(() => true)
              .catch(() => false)
            if (!ok) return `stop failed: ${sid}`
            return `stop requested: ${sid}`
          }

          return "unsupported action"
        },
      }),

      nak: tool({
        description: "Run local nak CLI commands for Nostr workflows",
        args: {
          command: tool.schema
            .string()
            .describe("Raw args passed to nak, for example: req -k 1 -l 5 wss://relay.example"),
        },
        async execute(args) {
          const out = await input.$`nak ${{ raw: args.command }}`.quiet().nothrow()
          const stdout = out.stdout.toString().trim()
          const stderr = out.stderr.toString().trim()
          return [`exit_code: ${out.exitCode}`, stdout ? `stdout:\n${stdout}` : "", stderr ? `stderr:\n${stderr}` : ""]
            .filter(Boolean)
            .join("\n\n")
        },
      }),
    },
  }
}

export default NostrBridge
