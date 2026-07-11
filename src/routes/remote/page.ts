// eslint-disable-next-line max-lines-per-function
export function getRemoteControlPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>Remote Control</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0 }
  html { height: 100% }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0F172A; color: #F8FAFC; min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column }
  code, .mono { font-family: monospace }

  /* Toast notifications */
  .toast-container { position: fixed; top: 20px; right: 20px; z-index: 1000; display: flex; flex-direction: column; gap: 8px }
  .toast { padding: 12px 20px; border-radius: 8px; font-size: 0.85rem; color: #fff; animation: slideIn 0.2s ease-out; max-width: 360px }
  .toast.success { background: #22C55E } .toast.error { background: #EF4444 }
  @keyframes slideIn { from { transform: translateX(100%); opacity: 0 } to { transform: translateX(0); opacity: 1 } }

  /* Session picker */
  #session-picker { flex: 1; padding: 20px; max-width: 600px; margin: 0 auto; width: 100% }
  .session-heading { display: flex; align-items: center; gap: 12px; margin-bottom: 6px }
  .session-heading h1 { flex: 1 }
  #session-picker h1 { font-size: 1.3rem; margin-bottom: 6px }
  #session-picker .subtitle { color: #94A3B8; font-size: 0.85rem; margin-bottom: 20px }
  .session-card { background: #1B2336; border: 1px solid #272F42; border-radius: 10px; padding: 14px 18px; margin-bottom: 10px; cursor: pointer; transition: border-color 0.15s, background 0.15s }
  .session-card:hover { border-color: #3B82F6; background: #1E2740 }
  .session-card:active { background: #222B45 }
  .session-card .sc-row { display: flex; align-items: center; gap: 10px }
  .session-card .sc-title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.95rem }
  .session-card .sc-meta { display: flex; gap: 12px; margin-top: 6px; color: #94A3B8; font-size: 0.8rem; flex-wrap: wrap }
  .session-card .sc-id { font-family: monospace; font-size: 11px; color: #64748B }
  .status-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0 }
  .status-dot.running { background: #22C55E; box-shadow: 0 0 6px #22C55E80 }
  .status-dot.idle { background: #94A3B8 }
  .status-dot.requires_action { background: #F97316; animation: pulse 1.5s infinite }
  .status-dot.connected { background: #A78BFA; box-shadow: 0 0 6px #A78BFA80 }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.72rem; font-weight: 600 }
  .badge-green { background: #22C55E22; color: #22C55E }
  .badge-orange { background: #F9731622; color: #F97316 }
  .badge-gray { background: #94A3B822; color: #94A3B8 }
  .empty-state { text-align: center; padding: 48px 20px; color: #94A3B8 }
  .empty-state p { margin-top: 8px; font-size: 0.9rem }
  .empty-state .empty-hint { font-size: 0.8rem; margin-top: 12px; color: #64748B }
  .empty-state code { color: #3B82F6 }
  .refresh-btn { background: none; border: 1px solid #272F42; color: #94A3B8; padding: 6px 14px; border-radius: 8px; cursor: pointer; font-size: 0.82rem; font-family: inherit }
  .refresh-btn:hover { background: #272F42; color: #F8FAFC }

  /* Connected chat view */
  #chat-view { display: none; flex-direction: column; height: 100vh; height: 100dvh }
  #chat-view.active { display: flex }
  #session-picker.hidden { display: none }

  /* Chat header */
  .chat-header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; padding-top: max(12px, env(safe-area-inset-top)); background: #1B2336; border-bottom: 1px solid #272F42; flex-shrink: 0 }
  .chat-header .ch-info { flex: 1; min-width: 0 }
  .chat-header .ch-title { font-weight: 600; font-size: 0.95rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  .chat-header .ch-id { font-family: monospace; font-size: 11px; color: #64748B }
  .disconnect-btn { background: none; border: 1px solid #EF4444; color: #EF4444; padding: 6px 14px; border-radius: 8px; cursor: pointer; font-size: 0.82rem; font-family: inherit; flex-shrink: 0 }
  .disconnect-btn:hover { background: #EF444420 }

  /* Message stream */
  .chat-messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; scroll-behavior: smooth }

  /* Message bubbles */
  .msg { max-width: 85%; padding: 10px 14px; border-radius: 16px; font-size: 0.9rem; line-height: 1.45; word-wrap: break-word; overflow-wrap: break-word }
  .msg-user { align-self: flex-end; background: #3B82F6; color: #fff; border-bottom-right-radius: 4px }
  .msg-assistant { align-self: flex-start; background: #1B2336; border: 1px solid #272F42; border-bottom-left-radius: 4px }
  .msg-assistant pre { background: #0F172A; padding: 8px 10px; border-radius: 6px; overflow-x: auto; font-size: 0.82rem; margin: 6px 0; white-space: pre-wrap; word-break: break-all }
  .msg-assistant code { font-family: monospace; font-size: 0.85em }
  .msg-assistant p { margin-bottom: 6px }
  .msg-assistant p:last-child { margin-bottom: 0 }

  /* Tool use block */
  .msg-tool { align-self: flex-start; max-width: 90%; background: #0F172A; border: 1px solid #272F42; border-radius: 10px; padding: 10px 14px; font-size: 0.82rem }
  .msg-tool .tool-label { color: #A78BFA; font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px }
  .msg-tool .tool-name { color: #F8FAFC; font-family: monospace; font-size: 0.85rem }
  .msg-tool .tool-input { color: #94A3B8; font-family: monospace; font-size: 0.78rem; margin-top: 6px; white-space: pre-wrap; word-break: break-all; max-height: 120px; overflow-y: auto }

  /* Control request card */
  .msg-control { align-self: stretch; background: #1B2336; border: 2px solid #F97316; border-radius: 10px; padding: 14px 18px }
  .msg-control .ctrl-label { color: #F97316; font-weight: 600; font-size: 0.82rem; margin-bottom: 6px }
  .msg-control .ctrl-desc { font-size: 0.88rem; color: #F8FAFC; margin-bottom: 10px }
  .msg-control .ctrl-actions { display: flex; gap: 8px }
  .msg-control .ctrl-btn { padding: 8px 18px; border: none; border-radius: 8px; cursor: pointer; font-size: 0.85rem; font-weight: 600; font-family: inherit }
  .ctrl-btn-allow { background: #22C55E; color: #fff }
  .ctrl-btn-allow:hover { background: #16A34A }
  .ctrl-btn-deny { background: #EF4444; color: #fff }
  .ctrl-btn-deny:hover { background: #DC2626 }
  .ctrl-btn-disabled { opacity: 0.5 }
  .msg-control.allowed { border-color: #22C55E }
  .msg-control.denied { border-color: #EF4444 }
  .msg-control.allowed .ctrl-label { color: #22C55E }
  .msg-control.denied .ctrl-label { color: #EF4444 }

  /* Turn separator */
  .turn-sep { display: flex; align-items: center; gap: 12px; padding: 4px 0; color: #64748B; font-size: 0.75rem }
  .turn-sep::before, .turn-sep::after { content: ''; flex: 1; height: 1px; background: #272F42 }

  /* Event badge (other event types) */
  .msg-badge { align-self: center; background: #272F42; color: #94A3B8; padding: 3px 10px; border-radius: 12px; font-size: 0.72rem; font-family: monospace }

  /* Chat input */
  .chat-input { display: flex; gap: 8px; padding: 12px 16px; padding-bottom: max(12px, env(safe-area-inset-bottom)); background: #1B2336; border-top: 1px solid #272F42; flex-shrink: 0 }
  .chat-input input { flex: 1; background: #0F172A; border: 1px solid #272F42; color: #F8FAFC; padding: 10px 14px; border-radius: 20px; font-size: 0.9rem; outline: none; font-family: inherit }
  .chat-input input:focus { border-color: #3B82F6 }
  .chat-input button { background: #3B82F6; border: none; color: #fff; width: 40px; height: 40px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0 }
  .chat-input button:hover { background: #2563EB }
  .chat-input button:disabled { background: #334155; cursor: not-allowed }
  .chat-input button svg { width: 18px; height: 18px }

  /* Loading spinner */
  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #334155; border-top-color: #3B82F6; border-radius: 50%; animation: spin 0.8s linear infinite }
  @keyframes spin { to { transform: rotate(360deg) } }
  .loading-row { display: flex; align-items: center; gap: 8px; color: #94A3B8; font-size: 0.82rem; padding: 8px 0 }

  @media (max-width: 767px) {
    #session-picker { padding: 16px }
    .msg { max-width: 92% }
    .chat-input { padding: 8px 12px; padding-bottom: max(8px, env(safe-area-inset-bottom)) }
    .chat-input input { font-size: 16px }
    .chat-header { padding-left: 12px; padding-right: 12px }
  }
</style>
</head>
<body>

<div class="toast-container" id="toasts"></div>

<div id="session-picker">
  <div class="session-heading">
    <h1>Remote Control</h1>
    <button class="refresh-btn" id="refresh-btn">Refresh</button>
  </div>
  <p class="subtitle">Select a session to connect</p>
  <div id="sessions-list"></div>
</div>

<div id="chat-view">
  <div class="chat-header">
    <span class="status-dot" id="chat-status-dot"></span>
    <div class="ch-info">
      <div class="ch-title" id="chat-title"></div>
      <div class="ch-id" id="chat-session-id"></div>
    </div>
    <button class="disconnect-btn" id="disconnect-btn">Disconnect</button>
  </div>
  <div class="chat-messages" id="chat-messages"></div>
  <div class="chat-input">
    <input type="text" id="chat-input" placeholder="Type a message..." autocomplete="off">
    <button id="send-btn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
    </button>
  </div>
</div>

<script>
var currentSessionId = null
var ws = null
var autoScrollEnabled = true
var sentMessageIds = new Set()
var isConnected = false
var seenSeqNums = new Set()
var currentAssistantEl = null
var currentToolEls = {}

function esc(s) {
  if (s == null) return ''
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function timeAgo(ts) {
  if (!ts) return ''
  var diff = Date.now() - new Date(ts).getTime()
  if (diff < 0) return 'just now'
  var s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  var m = Math.floor(s / 60); if (m < 60) return m + 'm ago'
  var h = Math.floor(m / 60); if (h < 24) return h + 'h ago'
  return Math.floor(h / 24) + 'd ago'
}

function showToast(message, type) {
  var container = document.getElementById('toasts')
  var el = document.createElement('div')
  el.className = 'toast ' + type
  el.textContent = message
  container.appendChild(el)
  setTimeout(function() { el.remove() }, type === 'error' ? 5000 : 3000)
}

function readCookie(name) {
  var prefix = name + '='
  var parts = document.cookie.split(';')
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim()
    if (part.indexOf(prefix) === 0) return decodeURIComponent(part.slice(prefix.length))
  }
  return ''
}

function apiFetch(method, path, body) {
  var opts = { method: method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }
  if (method !== 'GET' && method !== 'HEAD') {
    opts.headers['x-copilot-csrf'] = readCookie('__Host-copilot_admin_csrf')
  }
  if (body) opts.body = JSON.stringify(body)
  return fetch(path, opts)
}

/* Auth */
function authenticate() {
  apiFetch('GET', '/dashboard/api/sessions').then(function(res) {
    if (res.status === 401) { window.location.assign('/dashboard'); return }
    if (res.ok) { loadSessions(); checkAutoConnect(); return }
    showToast('Failed to authenticate', 'error')
  }).catch(function() { showToast('Connection failed', 'error') })
}

/* Session picker */
function loadSessions() {
  apiFetch('GET', '/dashboard/api/sessions').then(function(r) {
    if (r.ok) return r.json()
    throw new Error('Failed')
  }).then(function(sessions) {
    var codeSessions = sessions.filter(function(s) { return s.type === 'code-session' })
    renderSessionList(codeSessions)
  }).catch(function() {
    showToast('Failed to load sessions', 'error')
  })
}

function renderSessionList(sessions) {
  var container = document.getElementById('sessions-list')
  if (sessions.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No active code sessions found.</p><p class="empty-hint">Run <code>claude --remote-control</code> to start a session.</p></div>'
    return
  }
  var html = ''
  sessions.forEach(function(s) {
    var dotClass = s.state === 'running' ? 'running' : s.state === 'requires_action' ? 'requires_action' : s.state === 'connected' ? 'connected' : 'idle'
    var stateBadge = (s.state === 'running' || s.state === 'connected') ? 'badge-green' : s.state === 'requires_action' ? 'badge-orange' : 'badge-gray'
    html += '<div class="session-card" data-session-id="' + esc(s.id) + '">'
    html += '<div class="sc-row"><span class="status-dot ' + dotClass + '"></span>'
    html += '<span class="sc-title">' + esc(s.title || 'Untitled Session') + '</span>'
    html += '<span class="badge ' + stateBadge + '">' + esc(s.state || 'unknown') + '</span></div>'
    html += '<div class="sc-meta"><span class="sc-id">' + esc(s.id) + '</span>'
    if (s.createdAt) html += '<span>' + timeAgo(s.createdAt) + '</span>'
    html += '</div></div>'
  })
  container.innerHTML = html
}

function checkAutoConnect() {
  var params = new URLSearchParams(window.location.search)
  var sessionId = params.get('session')
  if (sessionId) {
    connectToSession(sessionId)
  }
}

/* Chat view */
function connectToSession(sessionId) {
  currentSessionId = sessionId
  document.getElementById('session-picker').classList.add('hidden')
  var chatView = document.getElementById('chat-view')
  chatView.classList.add('active')
  document.getElementById('chat-title').textContent = 'Session'
  document.getElementById('chat-session-id').textContent = sessionId
  document.getElementById('chat-messages').innerHTML = '<div class="loading-row"><span class="spinner"></span> Connecting to session...</div>'
  updateStatusDot('connected')

  // Update URL
  var url = new URL(window.location)
  url.searchParams.set('session', sessionId)
  history.replaceState(null, '', url)

  // Fetch session info for title
  apiFetch('GET', '/dashboard/api/sessions').then(function(r) { if (r.ok) return r.json() }).then(function(sessions) {
    if (!sessions) return
    var s = sessions.find(function(x) { return x.id === sessionId })
    if (s) {
      document.getElementById('chat-title').textContent = s.title || 'Untitled Session'
      updateStatusDot(s.state)
    }
  }).catch(function() {})

  // Connect SSE
  startEventStream(sessionId)
}

function disconnect() {
  if (ws) {
    ws.close()
    ws = null
  }
  currentSessionId = null
  sentMessageIds.clear()
  seenSeqNums.clear()
  currentAssistantEl = null
  currentToolEls = {}
  isConnected = false
  document.getElementById('chat-view').classList.remove('active')
  document.getElementById('session-picker').classList.remove('hidden')
  document.getElementById('chat-messages').innerHTML = ''

  var url = new URL(window.location)
  url.searchParams.delete('session')
  history.replaceState(null, '', url)

  loadSessions()
}

function updateStatusDot(state) {
  var dot = document.getElementById('chat-status-dot')
  dot.className = 'status-dot'
  if (state === 'running') dot.classList.add('running')
  else if (state === 'requires_action') dot.classList.add('requires_action')
  else if (state === 'connected') dot.classList.add('connected')
  else dot.classList.add('idle')
}

/* WebSocket event stream */
function startEventStream(sessionId) {
  if (ws) { ws.close(); ws = null }

  apiFetch('POST', '/dashboard/api/sessions/' + encodeURIComponent(sessionId) + '/websocket-ticket').then(function(res) {
    if (res.status === 401) { window.location.assign('/dashboard'); return null }
    if (!res.ok) throw new Error('Unable to create WebSocket ticket')
    return res.json()
  }).then(function(result) {
    if (!result || currentSessionId !== sessionId) return
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    var wsUrl = protocol + '//' + window.location.host + '/ws/remote/' + encodeURIComponent(sessionId)
    ws = new WebSocket(wsUrl, ['copilot-remote', 'copilot-ticket.' + result.ticket])

    ws.onopen = function() {
      var msgs = document.getElementById('chat-messages')
      var loadingRow = msgs.querySelector('.loading-row')
      if (loadingRow) loadingRow.remove()
    }

    ws.onmessage = function(e) {
      try {
        var data = JSON.parse(e.data)
        handleClientEvent(data)
      } catch(err) {
        console.error('[remote] Failed to parse:', err)
      }
    }

    ws.onclose = function() {
      showToast('Connection closed', 'error')
      updateStatusDot('idle')
    }

    ws.onerror = function() { showToast('Connection error', 'error') }
  }).catch(function(error) {
    showToast(error.message || 'Connection failed', 'error')
    updateStatusDot('idle')
  })
}

function handleClientEvent(data) {
  // Skip keepalive pings
  if (data.type === 'ping') return

  // Deduplicate by sequence number (catchup + live subscription overlap)
  var seqNum = data.sequence_num
  if (seqNum != null) {
    if (seenSeqNums.has(seqNum)) return
    seenSeqNums.add(seqNum)
  }

  var payload = data.payload || data
  var type = payload.type

  // Skip echo of messages we sent
  var eventId = data.event_id || payload.uuid
  if (eventId && sentMessageIds.has(eventId)) {
    sentMessageIds.delete(eventId)
    return
  }

  // Skip the synthetic "Remote Control connecting" message
  if (type === 'assistant' && payload.message && payload.message.model === '<synthetic>') {
    // Mark as connected and remove loading state
    if (!isConnected) {
      isConnected = true
      var msgs = document.getElementById('chat-messages')
      var loadingRow = msgs.querySelector('.loading-row')
      if (loadingRow) loadingRow.remove()
      updateStatusDot('running')
    }
    return
  }

  // First real message means we're connected
  if (!isConnected) {
    isConnected = true
    var msgs2 = document.getElementById('chat-messages')
    var loadingRow2 = msgs2.querySelector('.loading-row')
    if (loadingRow2) loadingRow2.remove()
    updateStatusDot('running')
  }

  switch (type) {
    case 'user':
      // We already render user messages locally on send — skip all echoes
      break
    case 'assistant':
      addAssistantMessage(payload)
      break
    case 'stream_event':
    case 'system':
    case 'rate_limit_event':
      break
    case 'result':
      addTurnSeparator()
      break
    case 'control_request':
      addControlRequest(payload)
      break
    default:
      break
  }
}

function addUserMessage(payload) {
  var msgs = document.getElementById('chat-messages')
  var div = document.createElement('div')
  div.className = 'msg msg-user'
  var content = ''
  if (payload.message && payload.message.content) {
    if (typeof payload.message.content === 'string') {
      content = payload.message.content
    } else if (Array.isArray(payload.message.content)) {
      payload.message.content.forEach(function(block) {
        if (block.type === 'text') content += block.text
      })
    }
  }
  div.textContent = content || '(empty message)'
  msgs.appendChild(div)
  scrollToBottom()
}

function addAssistantMessage(payload) {
  var msgs = document.getElementById('chat-messages')
  var content = payload.message ? payload.message.content : null
  if (!content) return

  // Extract text content from the message
  var textContent = ''
  var toolBlocks = []
  if (typeof content === 'string') {
    textContent = content
  } else if (Array.isArray(content)) {
    content.forEach(function(block) {
      if (block.type === 'text') {
        textContent += block.text || ''
      } else if (block.type === 'tool_use') {
        toolBlocks.push(block)
      }
    })
  }

  // Update existing assistant bubble or create new one
  if (textContent) {
    if (currentAssistantEl) {
      currentAssistantEl.innerHTML = renderMarkdownBasic(textContent)
    } else {
      var div = document.createElement('div')
      div.className = 'msg msg-assistant'
      div.innerHTML = renderMarkdownBasic(textContent)
      msgs.appendChild(div)
      currentAssistantEl = div
    }
  }

  // Render tool_use blocks (update existing or create new)
  toolBlocks.forEach(function(block) {
    var toolId = block.id || block.name
    if (currentToolEls[toolId]) return // already rendered
    var toolDiv = document.createElement('div')
    toolDiv.className = 'msg-tool'
    var inputStr = ''
    try { inputStr = JSON.stringify(block.input, null, 2) } catch(e) { inputStr = String(block.input || '') }
    toolDiv.innerHTML = '<div class="tool-label">Tool Use</div>'
      + '<div class="tool-name">' + esc(block.name || 'unknown') + '</div>'
      + (inputStr ? '<div class="tool-input">' + esc(inputStr) + '</div>' : '')
    msgs.appendChild(toolDiv)
    currentToolEls[toolId] = toolDiv
  })

  scrollToBottom()
}

function addTurnSeparator() {
  currentAssistantEl = null
  currentToolEls = {}
  var msgs = document.getElementById('chat-messages')
  var div = document.createElement('div')
  div.className = 'turn-sep'
  div.textContent = 'turn complete'
  msgs.appendChild(div)
  scrollToBottom()
}

function addControlRequest(payload) {
  var msgs = document.getElementById('chat-messages')
  var div = document.createElement('div')
  div.className = 'msg-control'
  var toolName = (payload.tool_name || payload.toolName || 'Unknown tool')
  var desc = (payload.description || payload.action || 'Permission requested')
  div.innerHTML = '<div class="ctrl-label">Permission Request</div>'
    + '<div class="ctrl-desc">' + esc(toolName) + ': ' + esc(desc) + '</div>'
    + '<div class="ctrl-actions">'
    + '<button class="ctrl-btn ctrl-btn-allow">Allow</button>'
    + '<button class="ctrl-btn ctrl-btn-deny">Deny</button>'
    + '</div>'
  msgs.appendChild(div)
  scrollToBottom()
}

function respondControl(btnEl, allow) {
  var card = btnEl.closest('.msg-control')
  var buttons = card.querySelectorAll('.ctrl-btn')
  buttons.forEach(function(b) { b.disabled = true; b.classList.add('ctrl-btn-disabled') })
  var responseText = allow ? 'yes' : 'no'
  sendMessageText(responseText)
  card.classList.add(allow ? 'allowed' : 'denied')
  var label = card.querySelector('.ctrl-label')
  label.textContent = allow ? 'Allowed' : 'Denied'
}

function addEventBadge(type) {
  var msgs = document.getElementById('chat-messages')
  var div = document.createElement('div')
  div.className = 'msg-badge'
  div.textContent = type
  msgs.appendChild(div)
  scrollToBottom()
}

function renderMarkdownBasic(text) {
  // Very basic markdown: code blocks, inline code, bold, newlines
  var escaped = esc(text)
  // Code blocks
  escaped = escaped.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
  // Inline code
  escaped = escaped.replace(/\`([^\`]+)\`/g, '<code>$1</code>')
  // Bold
  escaped = escaped.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
  // Newlines to paragraphs (double newline)
  escaped = escaped.replace(/\\n\\n/g, '</p><p>')
  // Single newlines to <br>
  escaped = escaped.replace(/\\n/g, '<br>')
  return '<p>' + escaped + '</p>'
}

function scrollToBottom() {
  if (!autoScrollEnabled) return
  var msgs = document.getElementById('chat-messages')
  requestAnimationFrame(function() {
    msgs.scrollTop = msgs.scrollHeight
  })
}

// Detect if user has scrolled up to disable auto-scroll
;(function() {
  var msgs = document.getElementById('chat-messages')
  msgs.addEventListener('scroll', function() {
    var atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60
    autoScrollEnabled = atBottom
  })
})()

/* Send message */
function sendMessage() {
  var input = document.getElementById('chat-input')
  var text = input.value.trim()
  if (!text || !currentSessionId) return
  input.value = ''
  sendMessageText(text)
}

function sendMessageText(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Not connected', 'error')
    return
  }
  // Reset assistant bubble for next response
  currentAssistantEl = null
  currentToolEls = {}
  // Show the message locally immediately
  var msgs = document.getElementById('chat-messages')
  var div = document.createElement('div')
  div.className = 'msg msg-user'
  div.textContent = text
  msgs.appendChild(div)
  scrollToBottom()
  // Send via WebSocket
  ws.send(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    session_id: currentSessionId
  }))
}

/* Input handling */
document.getElementById('chat-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
})

document.getElementById('refresh-btn').addEventListener('click', loadSessions)
document.getElementById('disconnect-btn').addEventListener('click', disconnect)
document.getElementById('send-btn').addEventListener('click', sendMessage)
document.getElementById('sessions-list').addEventListener('click', function(e) {
  var card = e.target.closest('.session-card')
  if (card && card.dataset.sessionId) connectToSession(card.dataset.sessionId)
})
document.getElementById('chat-messages').addEventListener('click', function(e) {
  var button = e.target.closest('.ctrl-btn')
  if (button) respondControl(button, button.classList.contains('ctrl-btn-allow'))
})

/* Init */
authenticate()
</script>
</body>
</html>`
}
