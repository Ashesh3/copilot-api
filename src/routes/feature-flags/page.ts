// eslint-disable-next-line max-lines-per-function
export function getFeatureFlagsPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Feature Flags</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0d1117; color: #c9d1d9; padding: 2rem; max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin-bottom: 1.5rem; color: #e6edf3; }
  input, button, select { font-family: inherit; font-size: 0.875rem; }
  input[type="text"] { background: #161b22; border: 1px solid #30363d; color: #c9d1d9; padding: 0.5rem 0.75rem; border-radius: 6px; outline: none; }
  input[type="text"]:focus { border-color: #58a6ff; }
  button { cursor: pointer; padding: 0.5rem 1rem; border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; }
  button:hover { background: #30363d; }
  button.primary { background: #238636; border-color: #238636; color: #fff; }
  button.primary:hover { background: #2ea043; }
  button.danger { background: #da3633; border-color: #da3633; color: #fff; }
  button.danger:hover { background: #f85149; }
  .toggle { width: 44px; height: 24px; border-radius: 12px; border: none; position: relative; transition: background 0.2s; padding: 0; }
  .toggle::after { content: ''; position: absolute; width: 18px; height: 18px; border-radius: 50%; background: #fff; top: 3px; left: 3px; transition: transform 0.2s; }
  .toggle.on { background: #238636; }
  .toggle.on::after { transform: translateX(20px); }
  .toggle.off { background: #484f58; }
  .toggle.non-bool { background: #30363d; cursor: default; }
  #auth-section { display: flex; gap: 0.5rem; align-items: center; }
  #auth-section input { flex: 1; }
  #app { display: none; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; }
  th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #30363d; color: #8b949e; font-weight: 500; font-size: 0.8rem; text-transform: uppercase; }
  td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #21262d; vertical-align: middle; }
  td.name { font-family: monospace; font-size: 0.85rem; word-break: break-all; }
  td.value { font-family: monospace; font-size: 0.85rem; color: #8b949e; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.actions { white-space: nowrap; text-align: right; }
  td.actions button { padding: 0.25rem 0.5rem; font-size: 0.8rem; margin-left: 0.25rem; }
  #add-form { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  #add-form input[name="name"] { flex: 2; min-width: 200px; }
  #add-form input[name="value"] { flex: 1; min-width: 100px; }
  .empty { color: #8b949e; text-align: center; padding: 2rem; }
  #error { color: #f85149; margin-bottom: 1rem; display: none; }
  #status { color: #3fb950; margin-bottom: 1rem; display: none; }
</style>
</head>
<body>
<h1>Feature Flags</h1>

<div id="error"></div>
<div id="status"></div>

<div id="auth-section">
  <input type="text" id="api-key" placeholder="API key" autocomplete="off">
  <button class="primary" onclick="authenticate()">Login</button>
</div>

<div id="app">
  <table>
    <thead><tr><th>Flag</th><th>Value</th><th></th></tr></thead>
    <tbody id="flags-body"></tbody>
  </table>
  <div id="add-form">
    <input type="text" name="name" placeholder="tengu_flag_name">
    <input type="text" name="value" placeholder="true">
    <button class="primary" onclick="addFlag()">Add</button>
  </div>
</div>

<script>
let apiKey = sessionStorage.getItem('ff_api_key') || '';
let flags = {};

if (apiKey) tryLoad();

async function authenticate() {
  apiKey = document.getElementById('api-key').value.trim();
  if (!apiKey) return;
  sessionStorage.setItem('ff_api_key', apiKey);
  await tryLoad();
}

async function tryLoad() {
  try {
    const res = await apiFetch('GET');
    if (!res.ok) {
      sessionStorage.removeItem('ff_api_key');
      apiKey = '';
      showError(res.status === 401 ? 'Invalid API key' : 'Error: ' + res.status);
      return;
    }
    flags = await res.json();
    document.getElementById('auth-section').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    render();
  } catch (e) {
    showError('Connection failed');
  }
}

function render() {
  const tbody = document.getElementById('flags-body');
  const entries = Object.entries(flags);
  if (entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">No flags configured</td></tr>';
    return;
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  tbody.innerHTML = entries.map(([name, value]) => {
    const isBool = typeof value === 'boolean';
    const toggleClass = isBool ? (value ? 'toggle on' : 'toggle off') : 'toggle non-bool';
    const toggleClick = isBool ? \`onclick="toggleFlag('\${esc(name)}')"\` : '';
    const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return \`<tr>
      <td class="name">\${esc(name)}</td>
      <td class="value" title="\${esc(displayValue)}">\${esc(displayValue)}</td>
      <td class="actions">
        <button class="\${toggleClass}" \${toggleClick}></button>
        <button class="danger" onclick="deleteFlag('\${esc(name)}')">Del</button>
      </td>
    </tr>\`;
  }).join('');
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

async function toggleFlag(name) {
  flags[name] = !flags[name];
  render();
  await apiFetch('POST', { name, value: flags[name] });
}

async function deleteFlag(name) {
  delete flags[name];
  render();
  await apiFetch('DELETE', { name });
}

async function addFlag() {
  const nameInput = document.querySelector('#add-form input[name="name"]');
  const valueInput = document.querySelector('#add-form input[name="value"]');
  const name = nameInput.value.trim();
  const rawValue = valueInput.value.trim();
  if (!name) return;

  let value;
  if (rawValue === 'true') value = true;
  else if (rawValue === 'false') value = false;
  else if (rawValue !== '' && !isNaN(Number(rawValue))) value = Number(rawValue);
  else {
    try { value = JSON.parse(rawValue); } catch { value = rawValue || true; }
  }

  flags[name] = value;
  render();
  nameInput.value = '';
  valueInput.value = '';
  await apiFetch('POST', { name, value });
  showStatus('Added ' + name);
}

function apiFetch(method, body) {
  const opts = {
    method,
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch('/feature-flags/api', opts);
}

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 4000);
}

function showStatus(msg) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 2000);
}

document.getElementById('api-key').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') authenticate();
});
</script>
</body>
</html>`
}
