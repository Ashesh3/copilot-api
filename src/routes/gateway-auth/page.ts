export interface GatewayVerificationPage {
  actionUrl: string
  csrfToken: string
  userCode: string
  message?: string
  complete?: boolean
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

export function gatewayVerificationPage(
  input: GatewayVerificationPage,
): string {
  const form =
    input.complete ? "" : (
      `
  <form method="POST" action="${escapeHtml(input.actionUrl)}">
    <input type="hidden" name="csrf_token" value="${escapeHtml(input.csrfToken)}">
    <label for="user-code">Code shown in Claude</label>
    <input id="user-code" name="user_code" value="${escapeHtml(input.userCode)}" maxlength="64" autocomplete="off" required>
    <label for="api-key">Gateway API key</label>
    <input id="api-key" type="password" name="api_key" autocomplete="off" required>
    <button type="submit" name="action" value="approve">Approve sign-in</button>
    <button class="secondary" type="submit" name="action" value="deny">Deny</button>
  </form>`
    )

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin">
<title>Connect Claude Desktop — Copilot API</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 1.5rem; font-family: system-ui, -apple-system, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
  main { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 2rem; width: 100%; max-width: 420px; }
  h1 { margin: 0 0 .75rem; font-size: 1.3rem; color: #e6edf3; }
  p { color: #8b949e; line-height: 1.5; }
  label { display: block; margin: 1rem 0 .4rem; }
  input { width: 100%; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: .65rem .75rem; border-radius: 6px; font: inherit; }
  input:focus-visible, button:focus-visible { outline: 2px solid #58a6ff; outline-offset: 3px; }
  button { width: 100%; margin-top: 1rem; padding: .65rem; border-radius: 6px; border: 1px solid transparent; background: #238636; color: #fff; font: inherit; cursor: pointer; }
  button:hover { background: #2ea043; }
  .secondary { background: transparent; border-color: #30363d; color: #c9d1d9; }
  .secondary:hover { background: #21262d; }
  .message { color: #e6edf3; overflow-wrap: anywhere; }
</style>
</head>
<body><main>
  <h1>Connect Claude Desktop</h1>
  ${input.complete ? "" : "<p>Check that this code matches the sign-in you started in Claude. Enter your gateway key to connect inference and dictation.</p>"}
  ${input.message ? `<p class="message" role="status">${escapeHtml(input.message)}</p>` : ""}
  ${form}
</main></body>
</html>`
}
