import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { Card } from "@astryxdesign/core/Card"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Heading, Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useEffect, useRef, useState } from "react"

import { DownloadIcon } from "../icons"
import { useToast } from "../lib/toast"

async function exportError(response: Response): Promise<string> {
  if (response.status === 401)
    return "Check your current administrator password and sign in again if needed."
  const fallback = "The database could not be exported. Please try again."
  try {
    const data: unknown = await response.json()
    if (!data || typeof data !== "object" || !("error" in data)) return fallback
    if (typeof data.error === "string") return data.error
    if (
      data.error
      && typeof data.error === "object"
      && "message" in data.error
      && typeof data.error.message === "string"
    )
      return data.error.message
  } catch {
    return fallback
  }
  return fallback
}

async function downloadResponse(response: Response): Promise<void> {
  const href = URL.createObjectURL(await response.blob())
  const link = document.createElement("a")
  try {
    link.href = href
    link.download =
      response.headers
        .get("content-disposition")
        ?.match(/filename="([^"]+)"/)?.[1] ?? "copilot-api.sqlite"
    document.body.append(link)
    link.click()
  } finally {
    link.remove()
    // Let the browser start the download before releasing its object URL.
    globalThis.setTimeout(() => URL.revokeObjectURL(href), 0)
  }
}

export function DatabaseExport() {
  const toast = useToast()
  const [currentPassword, setCurrentPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const activeRequest = useRef<AbortController | null>(null)

  useEffect(() => () => activeRequest.current?.abort(), [])

  async function download() {
    if (activeRequest.current || !currentPassword) return
    const controller = new AbortController()
    activeRequest.current = controller
    setBusy(true)
    setError(undefined)
    try {
      const csrf = document.cookie
        .split(";")
        .map((entry) => entry.trim())
        .find((entry) => entry.startsWith("__Host-copilot_admin_csrf="))
        ?.slice("__Host-copilot_admin_csrf=".length)
      const response = await fetch("/dashboard/api/database/export", {
        method: "POST",
        credentials: "same-origin",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(csrf ? { "x-copilot-csrf": csrf } : {}),
        },
        body: JSON.stringify({ currentPassword }),
      })
      if (!response.ok) throw new Error(await exportError(response))
      await downloadResponse(response)
      setCurrentPassword("")
      toast.success("Database download started")
    } catch (caught) {
      if (!controller.signal.aborted)
        setError(
          caught instanceof Error ? caught.message : "Database export failed",
        )
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return (
    <Card className="settings-card">
      <VStack gap={3}>
        <Heading level={3}>Export database</Heading>
        <Text type="supporting" color="secondary">
          Download the complete SQLite database, including accounts,
          credentials, settings and history. This file is not encrypted; keep it
          private.
        </Text>
        <TextInput
          type="password"
          label="Current administrator password"
          htmlName="currentPassword"
          value={currentPassword}
          onChange={setCurrentPassword}
          onEnter={() => void download()}
          isDisabled={busy}
          width="100%"
        />
        {error ?
          <Banner
            status="error"
            title="Database export failed"
            description={error}
          />
        : null}
        <HStack gap={2} wrap="wrap">
          <Button
            label="Download database"
            variant="secondary"
            icon={<DownloadIcon />}
            isLoading={busy}
            isDisabled={busy || !currentPassword}
            onClick={() => void download()}
          />
        </HStack>
      </VStack>
    </Card>
  )
}
