import { Button } from "@astryxdesign/core/Button"
import { useTreeFocus } from "@astryxdesign/core/hooks"
import { HStack } from "@astryxdesign/core/Stack"
import { useCallback, useMemo, useState } from "react"

import type { JsonValue } from "../lib/json-tree"

import { ChevronRightIcon, CopyIcon } from "../icons"
import {
  JSON_CHILD_PAGE_SIZE,
  collectJsonContainerPaths,
  hasJsonEntries,
  initialJsonContainerPaths,
  isJsonContainer,
  jsonEntryPage,
  jsonPointerPath,
  measureJsonDocument,
} from "../lib/json-tree"

interface JsonTreeViewerProps {
  formatted: string
  label: string
  value: JsonValue
  wrap: boolean
  onCopy: () => void
  onCopyError?: (message: string) => void
}

interface JsonTreeNodeProps {
  depth: number
  expandedPaths: Set<string>
  isLast: boolean
  path: string
  propertyName?: string
  value: JsonValue
  onToggle: (path: string) => void
}

interface NodeStyle extends React.CSSProperties {
  "--json-depth": number
}

function containerTokens(value: JsonValue) {
  const isArray = Array.isArray(value)
  return {
    close: isArray ? "]" : "}",
    open: isArray ? "[" : "{",
    unit: isArray ? "items" : "keys",
  }
}

function primitiveClass(value: JsonValue): string {
  if (value === null || typeof value === "boolean") return "json-tree-constant"
  if (typeof value === "number") return "json-tree-number"
  return "json-tree-string"
}

function JsonProperty({ propertyName }: { propertyName?: string }) {
  if (propertyName === undefined) return null
  return (
    <>
      <span className="json-tree-property">{JSON.stringify(propertyName)}</span>
      <span className="json-tree-punctuation">: </span>
    </>
  )
}

function JsonTreeNode({
  depth,
  expandedPaths,
  isLast,
  path,
  propertyName,
  value,
  onToggle,
}: JsonTreeNodeProps) {
  const [visibleCount, setVisibleCount] = useState(JSON_CHILD_PAGE_SIZE)
  const page = jsonEntryPage(value, visibleCount)
  const isContainer = isJsonContainer(value)
  const isExpandable = isContainer && page.total > 0
  const isExpanded = isExpandable && expandedPaths.has(path)
  const style: NodeStyle = { "--json-depth": depth }

  if (!isContainer) {
    return (
      <div
        role="treeitem"
        aria-level={depth + 1}
        data-tree-id={path}
        tabIndex={-1}
        className="json-tree-row"
        style={style}
      >
        {propertyName === undefined ? null : (
          <span className="json-tree-typeahead-prefix" aria-hidden="true">
            {propertyName}
          </span>
        )}
        <span className="json-tree-chevron-slot" aria-hidden="true" />
        <code>
          <JsonProperty propertyName={propertyName} />
          <span className={primitiveClass(value)}>{JSON.stringify(value)}</span>
          {isLast ? null : <span className="json-tree-punctuation">,</span>}
        </code>
      </div>
    )
  }

  const { close, open, unit } = containerTokens(value)
  const count = page.total

  return (
    <div
      role="treeitem"
      aria-expanded={isExpandable ? isExpanded : undefined}
      aria-level={depth + 1}
      data-tree-id={path}
      tabIndex={-1}
      className="json-tree-node"
    >
      {propertyName === undefined ? null : (
        <span className="json-tree-typeahead-prefix" aria-hidden="true">
          {propertyName}
        </span>
      )}
      <div
        className={`json-tree-row${isExpandable ? " json-tree-row-toggle" : ""}`}
        style={style}
        onClick={isExpandable ? () => onToggle(path) : undefined}
      >
        <span
          className={`json-tree-chevron-slot${isExpanded ? " is-expanded" : ""}`}
          aria-hidden="true"
        >
          {isExpandable ?
            <ChevronRightIcon />
          : null}
        </span>
        <code>
          <JsonProperty propertyName={propertyName} />
          <span className="json-tree-punctuation">
            {isExpanded ? open : `${open}${count === 0 ? "" : "…"}${close}`}
          </span>
          {!isExpanded && count > 0 ?
            <span className="json-tree-count">
              {count} {count === 1 ? unit.slice(0, -1) : unit}
            </span>
          : null}
          {!isExpanded && !isLast ?
            <span className="json-tree-punctuation">,</span>
          : null}
        </code>
      </div>

      {isExpanded ?
        <div role="group">
          {page.entries.map(([key, child], index) => (
            <JsonTreeNode
              key={jsonPointerPath(path, key)}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              isLast={page.remaining === 0 && index === page.entries.length - 1}
              path={jsonPointerPath(path, key)}
              propertyName={Array.isArray(value) ? undefined : key}
              value={child}
              onToggle={onToggle}
            />
          ))}
          {page.remaining > 0 ?
            <div
              role="treeitem"
              aria-level={depth + 2}
              tabIndex={-1}
              className="json-tree-more"
              style={style}
            >
              <Button
                label={`Show ${Math.min(JSON_CHILD_PAGE_SIZE, page.remaining)} more (${page.remaining} remaining)`}
                variant="ghost"
                size="sm"
                onClick={() =>
                  setVisibleCount((current) => current + JSON_CHILD_PAGE_SIZE)
                }
              />
            </div>
          : null}
          <div
            className="json-tree-closing-row"
            style={style}
            aria-hidden="true"
          >
            <span className="json-tree-chevron-slot" />
            <code className="json-tree-punctuation">
              {close}
              {isLast ? "" : ","}
            </code>
          </div>
        </div>
      : null}
    </div>
  )
}

export function JsonTreeViewer({
  formatted,
  label,
  value,
  wrap,
  onCopy,
  onCopyError,
}: JsonTreeViewerProps) {
  const documentScale = useMemo(
    () =>
      measureJsonDocument(
        value,
        new TextEncoder().encode(formatted).byteLength,
      ),
    [formatted, value],
  )
  const initiallyExpanded = useMemo(
    () => initialJsonContainerPaths(value, documentScale.isLarge),
    [documentScale.isLarge, value],
  )
  const [expandedPaths, setExpandedPaths] = useState(initiallyExpanded)

  const toggle = useCallback((path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const { treeRef, handleFocus, handleKeyDown } = useTreeFocus<HTMLDivElement>({
    hasRovingTabIndex: true,
    onActivate: (item) => {
      const button = item.querySelector("button")
      if (!button) return false
      button.click()
      return true
    },
    onToggleExpand: toggle,
  })

  async function copyFormatted() {
    try {
      await navigator.clipboard.writeText(formatted)
      onCopy()
    } catch (error) {
      onCopyError?.(
        error instanceof Error && error.message ? error.message : "Copy failed",
      )
    }
  }

  const rootIsContainer = isJsonContainer(value) && hasJsonEntries(value)

  function expandAll() {
    if (documentScale.isLarge) return
    setExpandedPaths(collectJsonContainerPaths(value))
  }

  return (
    <div className="json-tree-viewer">
      <HStack gap={1} wrap="wrap" hAlign="end">
        <Button
          label="Expand all"
          variant="ghost"
          size="sm"
          isDisabled={!rootIsContainer || documentScale.isLarge}
          tooltip={
            documentScale.isLarge ?
              "Expand all is disabled for large JSON documents. Expand individual paths instead."
            : undefined
          }
          onClick={expandAll}
        />
        <Button
          label="Collapse all"
          variant="ghost"
          size="sm"
          isDisabled={!rootIsContainer}
          onClick={() =>
            setExpandedPaths(rootIsContainer ? new Set(["#"]) : new Set())
          }
        />
        <Button
          label="Copy"
          variant="ghost"
          size="sm"
          icon={<CopyIcon />}
          onClick={copyFormatted}
        />
      </HStack>
      <div
        ref={treeRef}
        role="tree"
        aria-label={`${label} JSON`}
        className={`json-tree${wrap ? " is-wrapped" : ""}`}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
      >
        <div className="json-tree-content">
          <JsonTreeNode
            depth={0}
            expandedPaths={expandedPaths}
            isLast
            path="#"
            value={value}
            onToggle={toggle}
          />
        </div>
      </div>
    </div>
  )
}
