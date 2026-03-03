#!/bin/bash
set -euo pipefail

SERVER_URL="${1:?Usage: $0 <server-url>}"
PASS=0
FAIL=0
SKIP=0
RESULTS=()

run_test() {
  local name="$1"; shift
  echo ""
  echo "--- $name ---"
  if timeout 120 bash -c "$*" 2>&1; then
    PASS=$((PASS+1))
    RESULTS+=("PASS  $name")
    echo "PASS: $name"
  else
    FAIL=$((FAIL+1))
    RESULTS+=("FAIL  $name")
    echo "FAIL: $name"
  fi
}

skip_test() {
  local name="$1"
  SKIP=$((SKIP+1))
  RESULTS+=("SKIP  $name")
  echo "SKIP: $name"
}

cleanup_smoke_file() {
  rm -f smoke.txt
}

###############################################################################
# Claude Code
###############################################################################
echo ""
echo "==============================="
echo "  Claude Code Tests"
echo "==============================="

if command -v claude &>/dev/null; then
  export ANTHROPIC_BASE_URL="$SERVER_URL"
  export ANTHROPIC_AUTH_TOKEN="dummy"
  export ANTHROPIC_MODEL="claude-sonnet-4"
  export ANTHROPIC_SMALL_FAST_MODEL="gpt-4.1-mini"
  export DISABLE_NON_ESSENTIAL_MODEL_CALLS="1"
  export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"

  run_test "claude-code:text-generation" '
    output=$(claude -p "Reply with exactly: SMOKE_TEST_OK" --output-format json 2>&1)
    echo "$output"
    echo "$output" | grep -q "SMOKE_TEST_OK"
  '

  cleanup_smoke_file
  run_test "claude-code:tool-calling" '
    output=$(claude -p "Create a file called smoke.txt with the content: hello" --dangerously-skip-permissions --output-format json 2>&1)
    echo "$output"
    test -f smoke.txt && grep -q "hello" smoke.txt
  '
  cleanup_smoke_file
else
  skip_test "claude-code:text-generation"
  skip_test "claude-code:tool-calling"
fi

###############################################################################
# Codex CLI
###############################################################################
echo ""
echo "==============================="
echo "  Codex CLI Tests"
echo "==============================="

if command -v codex &>/dev/null; then
  export OPENAI_BASE_URL="$SERVER_URL/v1"
  export OPENAI_API_KEY="dummy"

  run_test "codex:text-generation" '
    output=$(codex exec "Reply with exactly: SMOKE_TEST_OK" 2>&1)
    echo "$output"
    echo "$output" | grep -q "SMOKE_TEST_OK"
  '

  cleanup_smoke_file
  run_test "codex:tool-calling" '
    output=$(codex exec --full-auto "Create a file called smoke.txt with the content: hello" 2>&1)
    echo "$output"
    test -f smoke.txt
  '
  cleanup_smoke_file
else
  skip_test "codex:text-generation"
  skip_test "codex:tool-calling"
fi

###############################################################################
# Gemini CLI
###############################################################################
echo ""
echo "==============================="
echo "  Gemini CLI Tests"
echo "==============================="

if command -v gemini &>/dev/null; then
  export GEMINI_API_KEY="dummy"
  export GOOGLE_GEMINI_BASE_URL="$SERVER_URL"

  # Use --model to bypass Gemini CLI's internal classifier (which 404s on proxy)
  run_test "gemini:text-generation" '
    output=$(gemini --model gemini-2.0-flash -p "Reply with exactly: SMOKE_TEST_OK" 2>&1)
    echo "$output"
    echo "$output" | grep -q "SMOKE_TEST_OK"
  '

  cleanup_smoke_file
  run_test "gemini:tool-calling" '
    output=$(gemini --model gemini-2.0-flash -p "Create a file called smoke.txt with the content: hello" 2>&1)
    echo "$output"
    test -f smoke.txt
  '
  cleanup_smoke_file
else
  skip_test "gemini:text-generation"
  skip_test "gemini:tool-calling"
fi

###############################################################################
# Summary
###############################################################################
echo ""
echo "==============================="
echo "  Results"
echo "==============================="
for r in "${RESULTS[@]}"; do
  echo "  $r"
done
echo ""
echo "=== $PASS passed, $FAIL failed, $SKIP skipped ==="
[ "$FAIL" -eq 0 ]
