export type CopilotTransportInit = RequestInit & {
  timeout?: boolean | number
}

export function createCopilotTransportInit(
  init?: CopilotTransportInit,
): CopilotTransportInit {
  const transportInit: CopilotTransportInit = { ...init }

  if (transportInit.signal) {
    transportInit.timeout = false
  } else {
    delete transportInit.timeout
  }

  transportInit.keepalive = false
  return transportInit
}
