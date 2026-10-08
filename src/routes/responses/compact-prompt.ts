/**
 * Summary requirements shared by every gateway compaction request.
 * Derived from copilot-agent-runtime's compaction strategy, enhanced to
 * preserve active task state so the assistant can resume without asking
 * the user what it was doing.
 */
const COMPACTION_SUMMARY_TASK = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.

This summary will be used to replace the conversation history, so it is CRITICAL to retain all relevant details. After compaction the assistant will ONLY have this summary — if something is omitted, it is permanently lost. The assistant must be able to resume work seamlessly without asking the user what it was doing.

Rules:
- Start with a "## Current Task" section: what the user asked for, what specific step the assistant was working on when this summary was requested, and what the immediate next action should be
- Include a "## Progress" section: list ALL actions already completed (files created, edited, deleted, commands run) with specific file paths and brief descriptions of changes
- Include a "## Pending" section: remaining tasks or next steps, in order
- Include a "## Key Context" section: technical details required to continue — file paths, function names, variable names, error messages, code snippets, branch names, URLs, configuration values
- Preserve the user's original intent, specific requirements, and any preferences or constraints they stated
- Preserve the working directory and project context (repo name, language, framework)
- If the conversation established decisions or rejected approaches, note them so the assistant does not re-propose rejected ideas
- Be thorough — this summary replaces the ENTIRE conversation. Err on the side of including too much rather than too little
- Do NOT include any preamble like "Here is a summary" — just provide the summary directly
- Write in a neutral, factual tone
- Use bullet points and sections for clarity`

/** System prompt for the `/responses/compact` summary request. */
export const getCompactionPrompt = (): string =>
  `You are a helpful assistant that summarizes conversations.\n\n${COMPACTION_SUMMARY_TASK}`

/**
 * Final user turn that replaces a Codex `compaction_trigger` on translated
 * routes. The request keeps the task's own instructions and tools, so it
 * must stop the task explicitly before asking for the replacement summary.
 */
export const getCompactionTriggerPrompt = (): string =>
  `Context compaction checkpoint: pause the current task. Do not call tools or continue the work. Reply only with the summary described below.\n\n${COMPACTION_SUMMARY_TASK}`
