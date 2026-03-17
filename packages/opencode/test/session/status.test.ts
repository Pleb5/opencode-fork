import { describe, expect, test } from "bun:test"
import path from "path"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionStatus } from "../../src/session/status"

const root = path.join(__dirname, "../..")

describe("SessionStatus.set", () => {
  test("dedupes repeated busy events", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const seen: string[] = []
        const unsub = Bus.subscribe(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID !== session.id) return
          seen.push(evt.properties.status.type)
        })

        SessionStatus.set(session.id, { type: "busy" })
        SessionStatus.set(session.id, { type: "busy" })

        await new Promise((resolve) => setTimeout(resolve, 20))

        unsub()
        expect(seen).toEqual(["busy"])
        await Session.remove(session.id)
      },
    })
  })

  test("dedupes repeated idle events", async () => {
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const seen: string[] = []
        const unsub = Bus.subscribe(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID !== session.id) return
          seen.push(evt.properties.status.type)
        })

        SessionStatus.set(session.id, { type: "busy" })
        SessionStatus.set(session.id, { type: "idle" })
        SessionStatus.set(session.id, { type: "idle" })

        await new Promise((resolve) => setTimeout(resolve, 20))

        unsub()
        expect(seen).toEqual(["busy", "idle"])
        await Session.remove(session.id)
      },
    })
  })
})
