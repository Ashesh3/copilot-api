import consola from "consola"

import type { ClientEvent } from "./types"

export type Subscriber = {
  sessionId: string
  controller: ReadableStreamDefaultController
  fromSeqNum: number
}

export type CallbackSubscriber = {
  sessionId: string
  callback: (event: ClientEvent) => void
}

const subscribers = new Map<string, Set<Subscriber>>()
const callbackSubscribers = new Map<string, Set<CallbackSubscriber>>()
const keepaliveTimers = new Map<string, ReturnType<typeof setInterval>>()

const KEEPALIVE_INTERVAL = 15_000

function ensureKeepalive(sessionId: string): void {
  if (keepaliveTimers.has(sessionId)) return
  const timer = setInterval(() => {
    const subs = subscribers.get(sessionId)
    if (!subs || subs.size === 0) return
    const encoder = new TextEncoder()
    for (const sub of subs) {
      try {
        sub.controller.enqueue(encoder.encode(":keepalive\n\n"))
      } catch {
        consola.debug(`Keepalive failed for subscriber on session ${sessionId}`)
      }
    }
  }, KEEPALIVE_INTERVAL)
  keepaliveTimers.set(sessionId, timer)
}

function cleanupKeepalive(sessionId: string): void {
  const subs = subscribers.get(sessionId)
  if (subs && subs.size > 0) return
  const timer = keepaliveTimers.get(sessionId)
  if (timer) {
    clearInterval(timer)
    keepaliveTimers.delete(sessionId)
  }
}

export function subscribe(
  sessionId: string,
  controller: ReadableStreamDefaultController,
  fromSeqNum: number,
): Subscriber {
  const sub: Subscriber = { sessionId, controller, fromSeqNum }
  let subs = subscribers.get(sessionId)
  if (!subs) {
    subs = new Set()
    subscribers.set(sessionId, subs)
  }
  subs.add(sub)
  ensureKeepalive(sessionId)
  return sub
}

export function unsubscribe(sub: Subscriber): void {
  const subs = subscribers.get(sub.sessionId)
  if (subs) {
    subs.delete(sub)
    cleanupKeepalive(sub.sessionId)
  }
}

export function subscribeWithCallback(
  sessionId: string,
  callback: (event: ClientEvent) => void,
): CallbackSubscriber {
  const sub: CallbackSubscriber = { sessionId, callback }
  let subs = callbackSubscribers.get(sessionId)
  if (!subs) {
    subs = new Set()
    callbackSubscribers.set(sessionId, subs)
  }
  subs.add(sub)
  return sub
}

export function unsubscribeCallback(sub: CallbackSubscriber): void {
  const subs = callbackSubscribers.get(sub.sessionId)
  if (subs) {
    subs.delete(sub)
  }
}

export function broadcastEvents(
  sessionId: string,
  events: Array<ClientEvent>,
): void {
  const subs = subscribers.get(sessionId)
  const cbSubs = callbackSubscribers.get(sessionId)
  const sseCount = subs?.size ?? 0
  const cbCount = cbSubs?.size ?? 0
  consola.info(
    `[event-bus] Broadcasting ${events.length} event(s) to session ${sessionId} — ${sseCount} SSE + ${cbCount} WS subscribers`,
  )
  if (subs && subs.size > 0) {
    const encoder = new TextEncoder()
    for (const event of events) {
      const frame = `event: client_event\nid: ${event.sequence_num}\ndata: ${JSON.stringify(event)}\n\n`
      const encoded = encoder.encode(frame)
      for (const sub of subs) {
        try {
          sub.controller.enqueue(encoded)
        } catch {
          consola.debug(
            `Failed to send event to subscriber on session ${sessionId}`,
          )
        }
      }
    }
  }

  const cbSubs = callbackSubscribers.get(sessionId)
  if (cbSubs && cbSubs.size > 0) {
    for (const event of events) {
      for (const sub of cbSubs) {
        try {
          sub.callback(event)
        } catch {
          consola.debug(
            `Failed to send event to callback subscriber on session ${sessionId}`,
          )
        }
      }
    }
  }
}
