// eslint-disable-next-line max-lines-per-function
export function getCodeLauncherPage(environmentId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Claude Code</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0 }
  html { height: 100% }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0F172A; color: #F8FAFC; min-height: 100vh; min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 20px }
  code, .mono { font-family: monospace }
  .card { background: #1B2336; border: 1px solid #272F42; border-radius: 16px; padding: 32px; max-width: 480px; width: 100% }
  .card h1 { font-size: 1.4rem; margin-bottom: 4px }
  .card .subtitle { color: #94A3B8; font-size: 0.85rem; margin-bottom: 24px }
  .env-info { background: #0F172A; border: 1px solid #272F42; border-radius: 10px; padding: 16px; margin-bottom: 24px }
  .env-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #1E293B; font-size: 0.88rem }
  .env-row:last-child { border-bottom: none }
  .env-label { color: #94A3B8 }
  .env-value { color: #F8FAFC; font-weight: 500; text-align: right; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px }
  .status-dot.online { background: #22C55E; box-shadow: 0 0 6px #22C55E80 }
  .status-dot.offline { background: #94A3B8 }
  .start-btn { width: 100%; padding: 14px; border: none; border-radius: 10px; background: #22C55E; color: #fff; font-weight: 600; cursor: pointer; font-size: 1rem; font-family: inherit; transition: background 0.15s }
  .start-btn:hover { background: #16A34A }
  .start-btn:disabled { background: #334155; cursor: not-allowed; color: #94A3B8 }
  .error-msg { color: #EF4444; font-size: 0.85rem; margin-top: 12px; text-align: center; display: none }
  .loading { display: none; text-align: center; padding: 12px; color: #94A3B8; font-size: 0.88rem }
  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #334155; border-top-color: #22C55E; border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 8px; vertical-align: middle }
  @keyframes spin { to { transform: rotate(360deg) } }
  .not-found { text-align: center; padding: 24px }
  .not-found h2 { font-size: 1.1rem; margin-bottom: 8px }
  .not-found p { color: #94A3B8; font-size: 0.88rem }
  .back-link { display: inline-block; margin-top: 16px; color: #3B82F6; text-decoration: none; font-size: 0.85rem }
  .back-link:hover { text-decoration: underline }
  .login-card { display: none; background: #1B2336; border: 1px solid #272F42; border-radius: 12px; padding: 32px; max-width: 360px; width: 100% }
  .login-card.visible { display: block }
  .login-card h2 { font-size: 1.2rem; margin-bottom: 8px }
  .login-card p { color: #94A3B8; font-size: 0.85rem; margin-bottom: 20px }
  .login-card input { width: 100%; background: #0F172A; border: 1px solid #272F42; color: #F8FAFC; padding: 10px 14px; border-radius: 8px; font-size: 0.9rem; outline: none; margin-bottom: 14px }
  .login-card input:focus { border-color: #3B82F6 }
  .login-card button { width: 100%; padding: 10px; border: none; border-radius: 8px; background: #3B82F6; color: #fff; font-weight: 600; cursor: pointer; font-size: 0.9rem }
  .login-card button:hover { background: #2563EB }
</style>
</head>
<body>

<div class="login-card" id="login-screen">
  <h2>Authentication</h2>
  <p>Enter your API key to start a session.</p>
  <input type="password" id="login-key" placeholder="API Key" autocomplete="off">
  <button onclick="doLogin()">Login</button>
  <div class="error-msg" id="login-error"></div>
</div>

<div class="card" id="main-card" style="display:none">
  <h1>Claude Code</h1>
  <p class="subtitle">Start a remote session in this environment</p>

  <div class="env-info" id="env-info">
    <div class="env-row"><span class="env-label">Status</span><span class="env-value" id="env-status"><span class="status-dot"></span>Loading...</span></div>
    <div class="env-row"><span class="env-label">Environment</span><span class="env-value mono" id="env-id">${environmentId}</span></div>
    <div class="env-row"><span class="env-label">Machine</span><span class="env-value" id="env-machine">...</span></div>
    <div class="env-row"><span class="env-label">Directory</span><span class="env-value mono" id="env-dir">...</span></div>
    <div class="env-row"><span class="env-label">Branch</span><span class="env-value" id="env-branch">...</span></div>
  </div>

  <button class="start-btn" id="start-btn" onclick="startSession()" disabled>Start Session</button>
  <div class="loading" id="loading"><span class="spinner"></span>Starting session...</div>
  <div class="error-msg" id="error-msg"></div>
</div>

<div class="card" id="not-found" style="display:none">
  <div class="not-found">
    <h2>Environment Not Found</h2>
    <p>The environment <code>${environmentId}</code> is not registered. Make sure <code>claude remote-control</code> is running.</p>
    <a href="/dashboard#environments" class="back-link">Go to Dashboard</a>
  </div>
</div>

<script>
var apiKey = sessionStorage.getItem('dashboard_api_key') || localStorage.getItem('dashboard_api_key') || ''
var envId = '${environmentId}'

function apiFetch(method, path, body) {
  var opts = { method: method, headers: { 'Content-Type': 'application/json' } }
  if (apiKey) opts.headers['x-api-key'] = apiKey
  if (body) opts.body = JSON.stringify(body)
  return fetch(path, opts)
}

function esc(s) { return s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }

function showLogin() {
  document.getElementById('login-screen').classList.add('visible')
  document.getElementById('main-card').style.display = 'none'
  document.getElementById('not-found').style.display = 'none'
}

function doLogin() {
  var key = document.getElementById('login-key').value.trim()
  if (!key) return
  apiKey = key
  sessionStorage.setItem('dashboard_api_key', key)
  localStorage.setItem('dashboard_api_key', key)
  document.getElementById('login-error').style.display = 'none'
  loadEnvironment()
}

function loadEnvironment() {
  apiFetch('GET', '/dashboard/api/environments').then(function(r) {
    if (r.status === 401) { showLogin(); return }
    if (!r.ok) throw new Error('Failed')
    return r.json()
  }).then(function(envs) {
    if (!envs) return
    document.getElementById('login-screen').classList.remove('visible')
    var env = envs.find(function(e) { return e.id === envId })
    if (!env) {
      document.getElementById('not-found').style.display = ''
      document.getElementById('main-card').style.display = 'none'
      return
    }
    document.getElementById('main-card').style.display = ''
    document.getElementById('not-found').style.display = 'none'
    document.getElementById('env-machine').textContent = env.machineName
    document.getElementById('env-dir').textContent = env.directory
    document.getElementById('env-branch').textContent = env.branch || '-'
    document.getElementById('env-status').innerHTML = '<span class="status-dot online"></span>Online'
    document.getElementById('start-btn').disabled = false
  }).catch(function() {
    document.getElementById('login-error').textContent = 'Connection failed'
    document.getElementById('login-error').style.display = 'block'
  })
}

function startSession() {
  var btn = document.getElementById('start-btn')
  var loading = document.getElementById('loading')
  var errorEl = document.getElementById('error-msg')
  btn.disabled = true
  btn.textContent = 'Starting...'
  loading.style.display = 'block'
  errorEl.style.display = 'none'

  apiFetch('POST', '/dashboard/api/environments/' + encodeURIComponent(envId) + '/start').then(function(r) {
    if (!r.ok) throw new Error('Failed to start session')
    return r.json()
  }).then(function(d) {
    loading.innerHTML = '<span class="spinner"></span>Redirecting to session...'
    window.location.href = '/remote?session=' + encodeURIComponent(d.sessionId)
  }).catch(function(err) {
    btn.disabled = false
    btn.textContent = 'Start Session'
    loading.style.display = 'none'
    errorEl.textContent = err.message || 'Failed to start session'
    errorEl.style.display = 'block'
  })
}

document.getElementById('login-key').addEventListener('keydown', function(e) { if (e.key === 'Enter') doLogin() })
loadEnvironment()
</script>
</body>
</html>`
}
