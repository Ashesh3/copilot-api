import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"

import { interceptEngine } from "~/lib/intercept/engine"
import {
  attachInterceptChannel,
  INTERCEPT_SOCKET_PATH,
  type InterceptSocket,
  type InterceptSocketData,
  type InterceptSocketMessage,
  tryUpgradeInterceptWebSocket,
} from "~/routes/dashboard/intercept-socket"
import { server } from "~/server"

import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
  TEST_ADMIN_ORIGIN,
  type TestAdminSession,
} from "./helpers/admin-session"

let session: TestAdminSession
const detachers: Array<() => void> = []

beforeAll(async () => {
  session = await createTestAdminSession()
})

afterEach(() => {
  for (const detach of detachers.splice(0)) detach()
})

afterAll(async () => {
  interceptEngine.resetForTest()
  await resetTestAdminSession()
})

/** Records frames; `until` resolves when a send or close satisfies a condition. */
class FakeSocket implements InterceptSocket {
  readonly frames: Array<InterceptSocketMessage> = []
  closed: { code?: number; reason?: string } | undefined
  sendResult: number | undefined
  bufferedAmount = 0
  private readonly waiters = new Set<() => void>()

  send(data: string): number {
    if (this.closed) return 0
    this.frames.push(JSON.parse(data) as InterceptSocketMessage)
    this.notify()
    return this.sendResult ?? data.length
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
    this.notify()
  }

  getBufferedAmount(): number {
    return this.bufferedAmount
  }

  until(condition: () => boolean): Promise<null> {
    if (condition()) return Promise.resolve(null)
    const { promise, resolve } = Promise.withResolvers<null>()
    const check = () => {
      if (!condition()) return
      this.waiters.delete(check)
      resolve(null)
    }
    this.waiters.add(check)
    return promise
  }

  private notify(): void {
    for (const check of this.waiters) check()
  }
}

const socketUrl = `http://localhost${INTERCEPT_SOCKET_PATH}`

function sessionRequest(): Request {
  return new Request(socketUrl, { headers: adminHeaders(session, false) })
}

function attach(socket: FakeSocket, options?: { pingMs?: number }): void {
  detachers.push(attachInterceptChannel(socket, sessionRequest(), options))
}

function fakeServer() {
  const upgrades: Array<{ data: InterceptSocketData }> = []
  return {
    upgrades,
    upgrade(_req: Request, opts?: object) {
      upgrades.push(opts as { data: InterceptSocketData })
      return true
    },
  }
}

function upgradeRequest(headers: Record<string, string>, path = "") {
  return new Request(`${socketUrl}${path}`, {
    headers: { upgrade: "websocket", ...headers },
  })
}

test("the upgrade requires an admin origin and session", async () => {
  const target = fakeServer()
  const withOrigin = {
    ...adminHeaders(session, false),
    origin: TEST_ADMIN_ORIGIN,
  }

  expect(
    await tryUpgradeInterceptWebSocket(upgradeRequest(withOrigin, "x"), target),
  ).toBe("no_match")
  expect(
    await tryUpgradeInterceptWebSocket(
      upgradeRequest({ ...withOrigin, origin: "https://evil.example.com" }),
      target,
    ),
  ).toBe("auth_failed")
  expect(
    await tryUpgradeInterceptWebSocket(
      upgradeRequest(adminHeaders(session, false)),
      target,
    ),
  ).toBe("auth_failed")
  expect(
    await tryUpgradeInterceptWebSocket(
      upgradeRequest({ origin: TEST_ADMIN_ORIGIN }),
      target,
    ),
  ).toBe("auth_failed")
  expect(target.upgrades).toHaveLength(0)

  expect(
    await tryUpgradeInterceptWebSocket(upgradeRequest(withOrigin), target),
  ).toBe("upgraded")
  const [upgrade] = target.upgrades
  expect(upgrade.data.type).toBe("intercept")
  expect(upgrade.data.sessionRequest.headers.get("cookie")).toBe(session.cookie)
})

test("the channel sends a snapshot, then engine events in order", async () => {
  const socket = new FakeSocket()
  attach(socket)
  interceptEngine.updateConfig({ direction: "response" })
  interceptEngine.updateConfig({ direction: "request" })
  await socket.until(() => socket.frames.length >= 3)

  expect(socket.frames.map((frame) => frame.event)).toEqual([
    "snapshot",
    "config",
    "config",
  ])
  const [snapshot, first, second] = socket.frames
  expect(snapshot.data).toMatchObject({ type: "snapshot" })
  expect(first.data).toMatchObject({
    type: "config",
    config: { direction: "response" },
  })
  expect(second.data).toMatchObject({
    type: "config",
    config: { direction: "request" },
  })
})

test("a detached channel stops listening", async () => {
  const socket = new FakeSocket()
  const detach = attachInterceptChannel(socket, sessionRequest())
  await socket.until(() => socket.frames.length === 1)
  detach()
  interceptEngine.updateConfig({ direction: "both" })
  expect(socket.frames).toHaveLength(1)
  expect(socket.closed).toBeUndefined()
})

test("the channel pings periodically", async () => {
  const socket = new FakeSocket()
  attach(socket, { pingMs: 10 })
  await socket.until(() =>
    socket.frames.some((frame) => frame.event === "ping"),
  )
  const ping = socket.frames.find((frame) => frame.event === "ping")
  expect(typeof ping?.data).toBe("number")
})

test("a client too far behind is dropped to reconnect from a snapshot", () => {
  const socket = new FakeSocket()
  attach(socket)
  for (let index = 0; index < 600; index += 1) {
    interceptEngine.updateConfig({
      direction: index % 2 === 0 ? "request" : "response",
    })
  }
  expect(socket.closed?.code).toBe(1013)
})

test("a client whose socket buffers too much is dropped", async () => {
  const socket = new FakeSocket()
  socket.sendResult = -1
  socket.bufferedAmount = 64 * 1024 * 1024
  attach(socket)
  await socket.until(() => socket.closed !== undefined)
  expect(socket.closed?.code).toBe(1013)
  interceptEngine.updateConfig({ direction: "both" })
  expect(socket.frames).toHaveLength(1)
})

test("a client whose frame is dropped is closed to reconnect", async () => {
  const socket = new FakeSocket()
  socket.sendResult = 0
  attach(socket)
  await socket.until(() => socket.closed !== undefined)
  expect(socket.closed).toEqual({ code: 1013, reason: "Frame dropped" })
  interceptEngine.updateConfig({ direction: "both" })
  expect(socket.frames).toHaveLength(1)
})

test("the channel closes once its session logs out", async () => {
  const socket = new FakeSocket()
  attach(socket)
  await socket.until(() => socket.frames.length === 1)

  const logout = await server.request("/dashboard/auth/logout", {
    method: "POST",
    headers: adminHeaders(session),
  })
  expect(logout.ok).toBe(true)
  interceptEngine.updateConfig({ direction: "response" })

  await socket.until(() => socket.closed !== undefined)
  expect(socket.closed?.code).toBe(1008)
  expect(socket.frames.map((frame) => frame.event)).toEqual(["snapshot"])
  expect(
    await tryUpgradeInterceptWebSocket(
      upgradeRequest({
        ...adminHeaders(session, false),
        origin: TEST_ADMIN_ORIGIN,
      }),
      fakeServer(),
    ),
  ).toBe("auth_failed")
})
