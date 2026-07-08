import type { ReactNode } from "react"

import { IconButton } from "@astryxdesign/core/IconButton"
import { Section } from "@astryxdesign/core/Section"
import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Heading, Text } from "@astryxdesign/core/Text"

import { RefreshCwIcon } from "../icons"

export interface PageProps {
  kicker: string
  title: string
  actions?: ReactNode
  onRefresh?: () => void
  isRefreshing?: boolean
  children?: ReactNode
}

export function Page({
  kicker,
  title,
  actions,
  onRefresh,
  isRefreshing,
  children,
}: PageProps) {
  return (
    <VStack height="100%" gap={0}>
      <Section dividers={["bottom"]} padding={4}>
        <HStack hAlign="between" vAlign="center">
          <VStack gap={0.5}>
            <Text type="label" color="secondary">
              {kicker}
            </Text>
            <Heading level={1}>{title}</Heading>
          </VStack>
          <HStack gap={2} vAlign="center">
            {actions}
            {onRefresh ?
              <IconButton
                label="Refresh"
                tooltip="Refresh"
                icon={<RefreshCwIcon />}
                variant="ghost"
                isLoading={isRefreshing}
                onClick={onRefresh}
              />
            : null}
          </HStack>
        </HStack>
      </Section>
      <VStack isScrollable padding={4} gap={4} height="100%">
        {children}
      </VStack>
    </VStack>
  )
}
