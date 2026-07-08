import { Badge } from "@astryxdesign/core/Badge"
import { Banner } from "@astryxdesign/core/Banner"
import { Button } from "@astryxdesign/core/Button"
import { CodeBlock } from "@astryxdesign/core/CodeBlock"
import { List, ListItem } from "@astryxdesign/core/List"
import { Section } from "@astryxdesign/core/Section"
import { Skeleton } from "@astryxdesign/core/Skeleton"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Text } from "@astryxdesign/core/Text"
import { TextArea } from "@astryxdesign/core/TextArea"
import { useEffect, useState } from "react"

import type { LlmDebugDetail, ReplayResult } from "../lib/types"

import { EmptyState, MonoText } from "../components/common"
import { Page } from "../components/Page"
import { PlayIcon } from "../icons"
import { ApiError, get, post } from "../lib/api"
import { navigate, useHashRoute } from "../lib/router"
import { useToast } from "../lib/toast"
import { useAsyncData } from "../lib/usePolling"

function loadDetail(id: string): Promise<LlmDebugDetail> {
  return get<LlmDebugDetail>(`/dashboard/api/llm-debug/${id}`)
}

function statusBadgeVariant(status: number): "success" | "error" {
  return status >= 200 && status < 300 ? "success" : "error"
}

export default function LlmReplayScreen() {
  const { param } = useHashRoute()

  if (!param) {
    return (
      <Page kicker="Monitor" title="LLM Replay">
        <EmptyState
          icon={<PlayIcon />}
          title="No entry selected"
          description="Open a POST /chat/completions or /responses entry from LLM Debug and click Replay there."
          actions={
            <Button
              label="Go to LLM Debug"
              variant="primary"
              onClick={() => navigate("llm-debug")}
            />
          }
        />
      </Page>
    )
  }

  return <LlmReplayView id={param} />
}

function LlmReplayView({ id }: { id: string }) {
  const { data, error, loading, reload } = useAsyncData(
    () => loadDetail(id),
    [id],
  )
  const toast = useToast()

  const [body, setBody] = useState("")
  const [isRunning, setIsRunning] = useState(false)
  const [result, setResult] = useState<ReplayResult>()
  const [replayError, setReplayError] = useState<string>()

  useEffect(() => {
    if (data) setBody(data.request.body ?? "")
  }, [data])

  async function runReplay() {
    setIsRunning(true)
    setReplayError(undefined)
    try {
      const replayResult = await post<ReplayResult>(
        `/dashboard/api/llm-debug/${id}/replay`,
        { body },
      )
      setResult(replayResult)
    } catch (caught) {
      setReplayError(
        caught instanceof ApiError ? caught.message : "Replay request failed",
      )
    } finally {
      setIsRunning(false)
    }
  }

  function copy(text: string) {
    void navigator.clipboard.writeText(text)
    toast.success("Copied")
  }

  return (
    <Page
      kicker="Monitor"
      title="LLM Replay"
      onRefresh={reload}
      isRefreshing={loading}
      actions={
        <Button
          label="Back to Debug Log"
          variant="secondary"
          onClick={() => navigate("llm-debug", id)}
        />
      }
    >
      {error ?
        <Banner
          status="error"
          title="Failed to load source entry"
          description={error.message}
          endContent={
            <Button label="Retry" variant="secondary" onClick={reload} />
          }
        />
      : null}

      {!data && loading ?
        <VStack gap={4}>
          <Skeleton height={200} />
        </VStack>
      : null}

      {data ?
        <VStack gap={4}>
          <Section dividers={["bottom"]}>
            <VStack gap={3}>
              <HStack gap={3} vAlign="center">
                <Badge variant="neutral" label={data.request.method} />
                <MonoText>{data.request.path}</MonoText>
              </HStack>

              <TextArea
                label="Request body"
                value={body}
                onChange={setBody}
                rows={14}
              />

              <HStack hAlign="end">
                <Button
                  label="Run Replay"
                  variant="primary"
                  icon={<PlayIcon />}
                  isLoading={isRunning}
                  onClick={() => void runReplay()}
                />
              </HStack>
            </VStack>
          </Section>

          {replayError ?
            <Banner
              status="error"
              title="Replay failed"
              description={replayError}
            />
          : null}

          {result ?
            <Section>
              <VStack gap={4}>
                <HStack gap={3} vAlign="center">
                  <Badge
                    variant={statusBadgeVariant(result.status)}
                    label={`${result.status} ${result.statusText}`}
                  />
                  <Text type="supporting" color="secondary">
                    {result.durationMs} ms
                  </Text>
                  {result.finishReason === null ? null : (
                    <Text type="supporting" color="secondary">
                      finish: {result.finishReason}
                    </Text>
                  )}
                  {result.responseId === null ? null : (
                    <MonoText>{result.responseId}</MonoText>
                  )}
                </HStack>

                <VStack gap={1}>
                  <Text type="label" color="secondary">
                    Response Body
                  </Text>
                  <CodeBlock
                    code={
                      result.parsed === null || result.parsed === undefined ?
                        result.body
                      : JSON.stringify(result.parsed, null, 2)
                    }
                    language="json"
                    maxHeight={400}
                    onCopy={() => copy(result.body)}
                  />
                </VStack>

                {result.streamEvents.length > 0 ?
                  <VStack gap={1}>
                    <Text type="label" color="secondary">
                      Stream Events ({result.streamEvents.length})
                    </Text>
                    <List hasDividers density="compact">
                      {result.streamEvents.map((streamEvent, index) => (
                        <ListItem
                          key={streamEvent.id ?? index}
                          label={streamEvent.event ?? "message"}
                          description={
                            <MonoText>
                              {(
                                streamEvent.data === null
                                || streamEvent.data === undefined
                              ) ?
                                streamEvent.rawData
                              : JSON.stringify(streamEvent.data)}
                            </MonoText>
                          }
                        />
                      ))}
                    </List>
                  </VStack>
                : null}
              </VStack>
            </Section>
          : null}
        </VStack>
      : null}
    </Page>
  )
}
