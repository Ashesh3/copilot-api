import type { ReactNode } from "react"

import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { Center } from "@astryxdesign/core/Center"
import { VStack } from "@astryxdesign/core/Stack"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useEffect, useState } from "react"

import { authProbe, post, setApiKey } from "./lib/api"

async function discoverPublicIps(): Promise<void> {
  const endpoints = ["https://api4.ipify.org", "https://api6.ipify.org"]

  await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        const response = await fetch(endpoint)
        if (!response.ok) return
        const ip = (await response.text()).trim()
        if (!ip) return
        await post("/dashboard/api/ip-allowlist", { ip, enabled: true })
      } catch {
        // best-effort only
      }
    }),
  )
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"checking" | "authed" | "form">(
    "checking",
  )
  const [key, setKey] = useState("")
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    // Probe even without a stored key: the server may not require auth.
    let cancelled = false
    authProbe()
      .then(() => {
        if (!cancelled) setStatus("authed")
      })
      .catch(() => {
        if (!cancelled) setStatus("form")
      })

    return () => {
      cancelled = true
    }
  }, [])

  const handleConnect = async () => {
    setError(undefined)
    setIsConnecting(true)
    try {
      setApiKey(key)
      await authProbe()
      setStatus("authed")
      void discoverPublicIps()
    } catch {
      setError("Invalid API key. Please check the key and try again.")
    } finally {
      setIsConnecting(false)
    }
  }

  if (status === "authed") return <>{children}</>

  if (status === "checking") {
    return (
      <Center height="100dvh">
        <Text color="secondary">Checking session...</Text>
      </Center>
    )
  }

  return (
    <Center height="100dvh">
      <Card width={400}>
        <VStack gap={4}>
          <VStack gap={1}>
            <Heading level={2}>Copilot API</Heading>
            <Text color="secondary">Sign in to the admin dashboard</Text>
          </VStack>

          {error ?
            <Banner status="error" title={error} />
          : null}

          <TextInput
            type="password"
            label="Dashboard API key"
            value={key}
            onChange={setKey}
            placeholder="Enter your API key"
            hasAutoFocus
          />

          <Button
            label="Connect"
            variant="primary"
            isLoading={isConnecting}
            isDisabled={key.trim().length === 0}
            clickAction={handleConnect}
          />
        </VStack>
      </Card>
    </Center>
  )
}
