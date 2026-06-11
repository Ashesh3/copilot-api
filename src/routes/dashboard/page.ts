/* eslint-disable max-lines, max-lines-per-function */
export function getDashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0 }
  html { height: 100% }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0F172A; color: #F8FAFC; display: flex; min-height: 100vh; min-height: 100dvh; overflow-x: hidden }
  code, .mono { font-family: monospace }
  .sidebar { width: 60px; background: #1E293B; border-right: 1px solid #334155; display: flex; flex-direction: column; align-items: center; padding: 12px 0; position: fixed; top: 0; left: 0; bottom: 0; z-index: 100 }
  .sidebar a { width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; border-radius: 8px; color: #94A3B8; text-decoration: none; position: relative; margin-bottom: 4px; border-left: 3px solid transparent; transition: all 0.15s }
  .sidebar a:hover { background: #272F42; color: #F8FAFC }
  .sidebar a.active { background: #22C55E20; color: #22C55E; border-left-color: #22C55E }
  .sidebar a svg { width: 20px; height: 20px }
  .sidebar a .tip { display: none; position: absolute; left: 56px; background: #1B2336; color: #F8FAFC; padding: 4px 10px; border-radius: 6px; font-size: 12px; white-space: nowrap; pointer-events: none; border: 1px solid #272F42; z-index: 200 }
  .sidebar a:hover .tip { display: block }
  .sidebar .spacer { flex: 1 }
  .main { margin-left: 60px; flex: 1; padding: 28px 32px; min-height: 100vh }
  .section { display: none }
  .section.active { display: block }
  #login-screen { display: none; position: fixed; inset: 0; background: #0F172A; z-index: 500; align-items: center; justify-content: center }
  #login-screen.visible { display: flex }
  .login-card { background: #1B2336; border: 1px solid #272F42; border-radius: 12px; padding: 32px; width: 360px; max-width: 90vw }
  .login-card h2 { font-size: 1.2rem; margin-bottom: 8px }
  .login-card p { color: #94A3B8; font-size: 0.85rem; margin-bottom: 20px }
  .login-card input { width: 100%; background: #0F172A; border: 1px solid #272F42; color: #F8FAFC; padding: 10px 14px; border-radius: 8px; font-size: 0.9rem; outline: none; margin-bottom: 14px }
  .login-card input:focus { border-color: #3B82F6 }
  .login-card button { width: 100%; padding: 10px; border: none; border-radius: 8px; background: #22C55E; color: #fff; font-weight: 600; cursor: pointer; font-size: 0.9rem }
  .login-card button:hover { background: #16A34A }
  .stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 20px }
  .stat-card { background: #1B2336; border: 1px solid #272F42; border-radius: 10px; padding: 20px; border-left: 4px solid #3B82F6 }
  .stat-card .label { color: #94A3B8; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px }
  .stat-card .value { font-size: 1.6rem; font-weight: 700 }
  .stat-card.green { border-left-color: #22C55E } .stat-card.purple { border-left-color: #A78BFA }
  .stat-card.orange { border-left-color: #F97316 } .stat-card.red { border-left-color: #EF4444 } .stat-card.blue { border-left-color: #3B82F6 }
  .section-header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; flex-wrap: wrap }
  .section-header h2 { font-size: 1.3rem }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 600 }
  .badge-green { background: #22C55E22; color: #22C55E } .badge-gray { background: #94A3B822; color: #94A3B8 }
  .badge-red { background: #EF444422; color: #F87171 }
  .badge-orange { background: #F9731622; color: #F97316 } .badge-blue { background: #3B82F622; color: #3B82F6 } .badge-purple { background: #A78BFA22; color: #A78BFA }
  table { width: 100%; border-collapse: collapse; margin-top: 12px }
  th { text-align: left; padding: 10px 12px; border-bottom: 1px solid #272F42; color: #94A3B8; font-weight: 500; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.5px }
  td { padding: 10px 12px; border-bottom: 1px solid #1E293B; vertical-align: middle; font-size: 0.88rem }
  tr:hover { background: #1B233680 }
  .session-list { display: flex; flex-direction: column; gap: 10px; margin-top: 12px }
  .session-card { background: #1B2336; border: 1px solid #272F42; border-radius: 10px; padding: 14px 18px; transition: border-color 0.15s }
  .session-card:hover { border-color: #334155 }
  .session-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap }
  .status-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0 }
  .status-dot.running { background: #22C55E; box-shadow: 0 0 6px #22C55E80 }
  .status-dot.idle { background: #94A3B8 } .status-dot.requires_action { background: #F97316; animation: pulse 1.5s infinite }
  .status-dot.connected { background: #A78BFA; box-shadow: 0 0 6px #A78BFA80 }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }
  .session-title { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  .session-id { font-family: monospace; font-size: 11px; color: #94A3B8 }
  .session-meta { color: #94A3B8; font-size: 0.8rem; display: flex; gap: 12px; margin-top: 6px; flex-wrap: wrap }
  .session-actions { display: flex; gap: 6px; flex-shrink: 0 }
  .action-desc { color: #F97316; font-size: 0.82rem; margin-top: 6px }
  .icon-btn { width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; border: 1px solid #272F42; background: transparent; color: #94A3B8; cursor: pointer }
  .icon-btn:hover { background: #272F42; color: #F8FAFC } .icon-btn.danger:hover { background: #EF444420; color: #EF4444; border-color: #EF4444 }
  .icon-btn svg { width: 16px; height: 16px }
  .events-panel { margin-top: 12px; background: #0F172A; border: 1px solid #272F42; border-radius: 8px; padding: 12px; max-height: 400px; overflow-y: auto; font-size: 0.82rem }
  .event-row { display: flex; gap: 10px; padding: 6px 0; border-bottom: 1px solid #1E293B; flex-wrap: wrap }
  .event-row:last-child { border-bottom: none }
  .event-seq { color: #3B82F6; font-family: monospace; min-width: 30px } .event-type { color: #22C55E; font-family: monospace; min-width: 100px }
  .event-source { color: #A78BFA; min-width: 60px } .event-time { color: #94A3B8; min-width: 80px; text-align: right; margin-left: auto }
  .event-payload { color: #94A3B8; font-family: monospace; font-size: 11px; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100% }
  .llm-debug-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px } .llm-debug-toolbar .form-input { min-width: 150px } .llm-debug-search { flex: 1; min-width: 260px }
  .llm-debug-list { display: flex; flex-direction: column; gap: 10px } .llm-log-card { background: #1B2336; border: 1px solid #272F42; border-radius: 10px; padding: 14px 16px } .llm-log-card.open { border-color: #3B82F6 }
  .llm-log-row { display: grid; grid-template-columns: minmax(120px, 170px) minmax(0, 1fr) auto; gap: 12px; align-items: center } .llm-log-main { min-width: 0 } .llm-log-actions { display: flex; gap: 6px; justify-content: flex-end }
  .llm-log-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px } .llm-log-path { font-family: monospace; font-size: 12px; color: #CBD5E1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100% } .llm-log-model { font-weight: 600; color: #F8FAFC }
  .llm-log-meta { color: #94A3B8; font-size: 0.78rem; display: flex; gap: 10px; flex-wrap: wrap } .llm-log-preview { color: #CBD5E1; font-family: monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 8px } .llm-log-detail { margin-top: 14px; border-top: 1px solid #273349; padding-top: 14px }
  .debug-detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px } .debug-panel { min-width: 0; background: #0F172A; border: 1px solid #273349; border-radius: 8px; overflow: hidden } .debug-panel.full { grid-column: 1 / -1 } .debug-panel summary { cursor: pointer; padding: 10px 12px; color: #F8FAFC; font-weight: 600; font-size: 0.84rem; background: #111A2E }
  .debug-panel-body { padding: 12px } .debug-panel-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 8px; color: #94A3B8; font-size: 0.78rem } .debug-empty { color: #94A3B8; padding: 14px; text-align: center; font-size: 0.85rem }
  .debug-kv { display: grid; grid-template-columns: minmax(110px, 180px) minmax(0, 1fr); border: 1px solid #273349; border-radius: 8px; overflow: hidden; margin-bottom: 12px } .debug-kv-key, .debug-kv-val { padding: 8px 10px; border-bottom: 1px solid #273349; font-size: 11px; word-break: break-word } .debug-kv-key { color: #94A3B8; background: #111A2E; font-family: monospace } .debug-kv-val { color: #CBD5E1; font-family: monospace } .debug-kv-key:nth-last-child(2), .debug-kv-val:last-child { border-bottom: none }
  .debug-pre { max-height: 360px; overflow: auto; padding: 12px; background: #020617; border: 1px solid #273349; border-radius: 8px; color: #E2E8F0; font-family: monospace; font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-word }
  .btn { padding: 8px 16px; border-radius: 8px; border: 1px solid #272F42; background: #1B2336; color: #F8FAFC; cursor: pointer; font-size: 0.85rem; font-family: inherit; transition: background 0.15s }
  .btn:hover { background: #272F42 } .btn-primary { background: #22C55E; border-color: #22C55E; color: #fff; font-weight: 600 }
  .btn-primary:hover { background: #16A34A } .btn-danger { background: #EF4444; border-color: #EF4444; color: #fff } .btn-danger:hover { background: #DC2626 }
  .form-row { display: flex; gap: 10px; align-items: center; margin-top: 16px; flex-wrap: wrap }
  .form-input { background: #0F172A; border: 1px solid #272F42; color: #F8FAFC; padding: 8px 12px; border-radius: 8px; font-size: 0.85rem; outline: none; font-family: inherit }
  .form-input:focus { border-color: #3B82F6 } .form-input.mono { font-family: monospace }
  .form-textarea { background: #0F172A; border: 1px solid #272F42; color: #F8FAFC; padding: 8px 12px; border-radius: 8px; font-size: 0.85rem; outline: none; font-family: monospace; width: 100%; min-height: 96px; resize: vertical }
  .form-textarea:focus { border-color: #3B82F6 }
  select.form-input { min-height: 36px }
  .toggle { width: 40px; height: 22px; border-radius: 11px; border: none; position: relative; cursor: pointer; padding: 0; transition: background 0.2s }
  .toggle::after { content: ''; position: absolute; width: 16px; height: 16px; border-radius: 50%; background: #fff; top: 3px; left: 3px; transition: transform 0.2s }
  .toggle.on { background: #22C55E } .toggle.on::after { transform: translateX(18px) } .toggle.off { background: #484f58 } .toggle.disabled { opacity: 0.4; cursor: not-allowed }
  .model-filter { flex: 1; min-width: 220px; max-width: 420px }
  .model-name { font-weight: 600; margin-bottom: 3px }
  .model-meta { color: #94A3B8; font-size: 0.78rem }
  .account-toggle-cell { text-align: center; min-width: 120px }
  .account-toggle-cell .badge { margin-top: 6px }
  .checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 0.85rem; color: #94A3B8; cursor: pointer }
  .checkbox-label input { accent-color: #3B82F6 }
  .model-settings-layout { display: grid; grid-template-columns: minmax(320px, 480px) minmax(0, 1fr); gap: 18px; align-items: start }
  .model-settings-panel { background: #111A2E; border: 1px solid #273349; border-radius: 10px; padding: 18px; min-width: 0 }
  .model-settings-panel h3 { font-size: 0.95rem; margin-bottom: 14px }
  .field-stack { display: flex; flex-direction: column; gap: 14px }
  .field-label { display: block; color: #CBD5E1; font-size: 0.78rem; font-weight: 600; margin-bottom: 7px }
  .field-label .optional { color: #64748B; font-weight: 500 }
  .full-input { width: 100%; min-height: 38px }
  .effort-picker { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px }
  .choice-pill { position: relative; display: block; cursor: pointer }
  .choice-pill input { position: absolute; opacity: 0; pointer-events: none }
  .choice-pill span { display: flex; align-items: center; justify-content: center; min-height: 36px; border: 1px solid #273349; border-radius: 8px; background: #0F172A; color: #CBD5E1; font-size: 0.82rem; font-weight: 600 }
  .choice-pill input:checked + span { border-color: #3B82F6; background: #1D4ED826; color: #DBEAFE }
  .settings-options { display: grid; grid-template-columns: 1fr 1fr; gap: 10px }
  .switch-row { display: flex; align-items: center; gap: 10px; min-height: 42px; padding: 10px 12px; border: 1px solid #273349; border-radius: 8px; background: #0F172A; color: #CBD5E1; font-size: 0.84rem; cursor: pointer }
  .switch-row input { accent-color: #3B82F6 }
  .model-settings-actions { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; padding-top: 2px }
  .model-settings-actions .btn { min-width: 120px }
  .model-settings-list .empty-state { padding: 28px 16px }
  .model-settings-list .empty-state svg { width: 36px; height: 36px; margin-bottom: 10px }
  .model-settings-list table { min-width: 1180px }
  .model-settings-list .effort-picker { display: flex; flex-wrap: wrap; gap: 6px; min-width: 178px }
  .model-settings-list .choice-pill { flex: 0 0 84px }
  .model-settings-list .choice-pill span { min-height: 32px; padding: 0 10px; white-space: nowrap }
  .model-settings-edit { display: flex; flex-direction: column; gap: 10px; min-width: 300px }
  .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; margin-top: 12px; background: #1B2336; border: 1px solid #272F42; border-radius: 10px; overflow: hidden }
  .setting-row { display: contents }
  .setting-key { padding: 14px 18px; font-size: 0.85rem; color: #94A3B8; border-bottom: 1px solid #272F42 }
  .setting-val { padding: 14px 18px; font-size: 0.85rem; border-bottom: 1px solid #272F42; word-break: break-all }
  .bool-yes { display: inline-block; padding: 2px 10px; border-radius: 12px; background: #22C55E22; color: #22C55E; font-size: 0.8rem; font-weight: 600 }
  .bool-no { display: inline-block; padding: 2px 10px; border-radius: 12px; background: #94A3B822; color: #94A3B8; font-size: 0.8rem; font-weight: 600 }
  .progress-bar { width: 100%; height: 8px; background: #272F42; border-radius: 4px; overflow: hidden; margin-top: 6px }
  .progress-fill { height: 100%; border-radius: 4px; transition: width 0.3s }
  .toast-container { position: fixed; top: 20px; right: 20px; z-index: 1000; display: flex; flex-direction: column; gap: 8px }
  .toast { padding: 12px 20px; border-radius: 8px; font-size: 0.85rem; color: #fff; animation: slideIn 0.2s ease-out; max-width: 360px }
  .toast.success { background: #22C55E } .toast.error { background: #EF4444 }
  @keyframes slideIn { from { transform: translateX(100%); opacity: 0 } to { transform: translateX(0); opacity: 1 } }
  .empty-state { text-align: center; padding: 48px 20px; color: #94A3B8 }
  .empty-state svg { width: 48px; height: 48px; margin-bottom: 16px; opacity: 0.4 } .empty-state p { margin-top: 8px; font-size: 0.9rem }
  .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch }
  @media (max-width: 1023px) { .stat-grid { grid-template-columns: repeat(2, 1fr) } }
  @media (max-width: 1023px) { .model-settings-layout { grid-template-columns: 1fr } }
  @media (max-width: 767px) { .sidebar { display: none } .main { margin-left: 0; padding: 16px; padding-bottom: 90px } .stat-grid { grid-template-columns: 1fr } .settings-grid { grid-template-columns: 1fr } .setting-row { display: flex; flex-direction: column } .bottom-nav { display: flex !important } .form-row { flex-direction: column; align-items: stretch } .form-row .form-input { width: 100% !important; min-width: 0 !important; flex: none !important } .form-row .checkbox-label { justify-content: flex-start } .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 -16px; padding: 0 16px } .section-header h2 { font-size: 1.1rem } .effort-picker { grid-template-columns: repeat(2, minmax(0, 1fr)) } .settings-options { grid-template-columns: 1fr } .model-settings-actions { justify-content: stretch } .model-settings-actions .btn { flex: 1 } }
  .bottom-nav { display: none; position: fixed; bottom: 0; left: 0; right: 0; background: #1E293B; border-top: 1px solid #334155; justify-content: space-around; padding: 8px 0; padding-bottom: max(8px, env(safe-area-inset-bottom)); z-index: 100 }
  .bottom-nav a { display: flex; flex-direction: column; align-items: center; gap: 3px; color: #94A3B8; text-decoration: none; font-size: 10px; padding: 4px 6px; border-radius: 6px; min-width: 44px; min-height: 44px; justify-content: center }
  .bottom-nav a.active { color: #22C55E } .bottom-nav a svg { width: 20px; height: 20px }
  .bottom-nav a .nav-label { font-size: 9px; line-height: 1; letter-spacing: 0.3px }
  @media (max-width: 767px) { .llm-debug-toolbar { flex-direction: column; align-items: stretch } .llm-debug-toolbar .form-input, .llm-debug-search { width: 100%; min-width: 0 } .llm-log-row { grid-template-columns: 1fr } .llm-log-actions { justify-content: flex-start } .debug-detail-grid { grid-template-columns: 1fr } .debug-panel.full { grid-column: auto } .debug-kv { grid-template-columns: 1fr } }
</style>
</head>
<body>
<div id="login-screen"><div class="login-card"><h2>Dashboard Login</h2><p>Enter your API key to access the admin dashboard.</p><input type="password" id="login-key" placeholder="API Key" autocomplete="off"><button onclick="doLogin()">Login</button></div></div>
<div class="toast-container" id="toasts"></div>
<nav class="sidebar" id="sidebar">
  <a href="#overview" data-section="overview" onclick="navigate('overview')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg><span class="tip">Overview</span></a>
  <a href="#sessions" data-section="sessions" onclick="navigate('sessions')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg><span class="tip">Sessions</span></a>
  <a href="#environments" data-section="environments" onclick="navigate('environments')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg><span class="tip">Environments</span></a>
  <a href="#flags" data-section="flags" onclick="navigate('flags')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg><span class="tip">Feature Flags</span></a>
  <a href="#replacements" data-section="replacements" onclick="navigate('replacements')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg><span class="tip">Replacements</span></a>
  <a href="#model-redirects" data-section="model-redirects" onclick="navigate('model-redirects')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h13"/><path d="M16 6l6 6-6 6"/><path d="M3 6v12"/></svg><span class="tip">Model Redirects</span></a>
  <a href="#model-settings" data-section="model-settings" onclick="navigate('model-settings')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10"/><path d="M7 12h4"/><path d="M13 12h4"/><path d="M7 16h10"/></svg><span class="tip">Model Settings</span></a>
  <a href="#custom-providers" data-section="custom-providers" onclick="navigate('custom-providers')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M3 8h18"/><path d="M3 16h18"/><path d="M7 3c2 4 2 14 0 18"/><path d="M17 3c-2 4-2 14 0 18"/></svg><span class="tip">Custom Providers</span></a>
  <a href="#model-routing" data-section="model-routing" onclick="navigate('model-routing')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20"/><path d="M2 12h20"/><path d="M4 4h6v6H4z"/><path d="M14 14h6v6h-6z"/></svg><span class="tip">Model Routing</span></a>
  <a href="#llm-debug" data-section="llm-debug" onclick="navigate('llm-debug')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h6"/><path d="M8 9h2"/></svg><span class="tip">LLM Debug</span></a>
  <a href="#usage" data-section="usage" onclick="navigate('usage')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg><span class="tip">Usage</span></a>
  <div class="spacer"></div>
  <a href="#settings" data-section="settings" onclick="navigate('settings')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg><span class="tip">Settings</span></a>
</nav>
<nav class="bottom-nav" id="bottom-nav">
  <a href="#overview" data-section="overview" onclick="navigate('overview')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg><span class="nav-label">Overview</span></a>
  <a href="#sessions" data-section="sessions" onclick="navigate('sessions')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg><span class="nav-label">Sessions</span></a>
  <a href="#flags" data-section="flags" onclick="navigate('flags')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg><span class="nav-label">Flags</span></a>
  <a href="#model-settings" data-section="model-settings" onclick="navigate('model-settings')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10"/><path d="M7 12h4"/><path d="M13 12h4"/><path d="M7 16h10"/></svg><span class="nav-label">Models</span></a>
  <a href="#custom-providers" data-section="custom-providers" onclick="navigate('custom-providers')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18"/><path d="M3 8h18"/><path d="M3 16h18"/><path d="M7 3c2 4 2 14 0 18"/><path d="M17 3c-2 4-2 14 0 18"/></svg><span class="nav-label">Providers</span></a>
  <a href="#model-routing" data-section="model-routing" onclick="navigate('model-routing')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20"/><path d="M2 12h20"/><path d="M4 4h6v6H4z"/><path d="M14 14h6v6h-6z"/></svg><span class="nav-label">Routing</span></a>
  <a href="#llm-debug" data-section="llm-debug" onclick="navigate('llm-debug')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h6"/></svg><span class="nav-label">Debug</span></a>
  <a href="#usage" data-section="usage" onclick="navigate('usage')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg><span class="nav-label">Usage</span></a>
  <a href="#settings" data-section="settings" onclick="navigate('settings')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg><span class="nav-label">Settings</span></a>
</nav>
<div class="main" id="main-content">
  <div class="section" id="sec-overview"><div class="section-header"><h2>Overview</h2></div><div class="stat-grid" id="overview-grid"></div></div>
  <div class="section" id="sec-sessions"><div class="section-header"><h2>Sessions</h2><span id="session-badges"></span></div><div id="sessions-list"></div></div>
  <div class="section" id="sec-environments"><div class="section-header"><h2>Environments</h2></div><div id="environments-content"></div></div>
  <div class="section" id="sec-flags"><div class="section-header"><h2>Feature Flags</h2></div><div id="flags-content"></div><div class="form-row" id="flag-form"><input class="form-input mono" name="flag-name" placeholder="flag_name" style="flex:2;min-width:180px"><input class="form-input" name="flag-value" placeholder="true" style="flex:1;min-width:100px"><button class="btn btn-primary" onclick="addFlag()">Add</button></div></div>
  <div class="section" id="sec-replacements"><div class="section-header"><h2>Replacements</h2></div><div id="replacements-content"></div><div class="form-row" id="replacement-form"><input class="form-input" name="repl-name" placeholder="Name (optional)" style="min-width:120px"><input class="form-input mono" name="repl-pattern" placeholder="Pattern" style="flex:2;min-width:140px"><input class="form-input" name="repl-replacement" placeholder="Replacement" style="flex:2;min-width:140px"><label class="checkbox-label"><input type="checkbox" name="repl-regex"> Regex</label><button class="btn btn-primary" onclick="addReplacement()">Add</button></div></div>
  <div class="section" id="sec-model-redirects"><div class="section-header"><h2>Model Redirects</h2><span class="badge badge-gray">Silent - clients see the original model</span></div><div id="model-redirects-content"></div><div class="form-row" id="model-redirect-form"><input class="form-input" name="mr-name" placeholder="Name (optional)" style="min-width:120px"><input class="form-input mono" name="mr-source" placeholder="Source model" style="flex:2;min-width:200px"><select class="form-input" name="mr-source-effort"><option value="all">All effort levels</option><option value="default">Default/no effort</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select><input class="form-input mono" name="mr-target" placeholder="Target model" style="flex:2;min-width:200px"><select class="form-input" name="mr-target-effort"><option value="">Preserve effort</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select><button class="btn btn-primary" onclick="addModelRedirect()">Add</button></div></div>
  <div class="section" id="sec-model-settings"><div class="section-header"><h2>Model Settings</h2><span class="badge badge-gray">Reasoning, Sentry, and request params</span></div><div class="model-settings-layout"><div class="model-settings-panel"><h3>Add setting</h3><div class="field-stack" id="model-settings-form"><label><span class="field-label">Model ID</span><input class="form-input mono full-input" name="ms-model" placeholder="provider-model-id" autocomplete="off"></label><label><span class="field-label">Sentry reported name <span class="optional">optional</span></span><input class="form-input mono full-input" name="ms-sentry-model" placeholder="sentry-model-id" autocomplete="off"></label><div><span class="field-label">Supported efforts <span class="optional">optional</span></span><div class="effort-picker" data-efforts="ms-efforts"><label class="choice-pill"><input type="checkbox" name="ms-effort" value="low"><span>low</span></label><label class="choice-pill"><input type="checkbox" name="ms-effort" value="medium"><span>medium</span></label><label class="choice-pill"><input type="checkbox" name="ms-effort" value="high"><span>high</span></label><label class="choice-pill"><input type="checkbox" name="ms-effort" value="xhigh"><span>xhigh</span></label><label class="choice-pill"><input type="checkbox" name="ms-effort" value="max"><span>max</span></label></div></div><label><span class="field-label">Default effort <span class="optional">optional</span></span><select class="form-input full-input" name="ms-default"><option value="">None</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select></label><div class="settings-options"><label><span class="field-label">Implicit default <span class="optional">optional</span></span><select class="form-input full-input" name="ms-implicit"><option value="">Not set</option><option value="true">Enabled</option><option value="false">Disabled</option></select></label><label><span class="field-label">Virtual variants <span class="optional">optional</span></span><select class="form-input full-input" name="ms-virtual"><option value="">Not set</option><option value="true">Show</option><option value="false">Hide</option></select></label></div><div><span class="field-label">Omit request params <span class="optional">optional</span></span><div class="effort-picker" data-params="ms-unsupported-params"><label class="choice-pill"><input type="checkbox" name="ms-param" value="temperature"><span>temperature</span></label><label class="choice-pill"><input type="checkbox" name="ms-param" value="top_p"><span>top_p</span></label></div></div><div class="model-settings-actions"><button class="btn" onclick="applyImplicitMediumPreset()">Implicit medium</button><button class="btn" onclick="applyNoSamplingPreset()">No sampling</button><button class="btn btn-primary" onclick="addModelSettings()">Save setting</button></div></div></div><div class="model-settings-panel model-settings-list"><h3>Configured models</h3><div id="model-settings-content"></div></div></div></div>
  <div class="section" id="sec-custom-providers"><div class="section-header"><h2>Custom Providers</h2><span class="badge badge-gray" id="custom-provider-count">0 providers</span><button class="btn" onclick="addNebiusProvider()">Add Nebius Qwen3</button></div><div class="model-settings-layout"><div class="model-settings-panel"><h3 id="custom-provider-form-title">Add provider</h3><div class="field-stack" id="custom-provider-form"><div class="settings-options"><label><span class="field-label">Provider ID</span><input class="form-input mono full-input" name="cp-id" placeholder="nebius" autocomplete="off"></label><label><span class="field-label">Name</span><input class="form-input full-input" name="cp-name" placeholder="Nebius" autocomplete="off"></label></div><label><span class="field-label">Base URL</span><input class="form-input mono full-input" name="cp-base-url" placeholder="https://api.example.com/v1" autocomplete="off"></label><div class="settings-options"><label><span class="field-label">API key</span><input class="form-input mono full-input" name="cp-api-key" type="password" placeholder="Provider API key" autocomplete="off"></label><label><span class="field-label">Timeout ms <span class="optional">optional</span></span><input class="form-input mono full-input" name="cp-timeout" placeholder="120000" autocomplete="off"></label></div><label class="switch-row"><input type="checkbox" name="cp-pass-reasoning"> Pass reasoning_effort</label><label><span class="field-label">Headers JSON <span class="optional">optional</span></span><textarea class="form-textarea" name="cp-headers" spellcheck="false">{}</textarea></label><label><span class="field-label">Models JSON</span><textarea class="form-textarea" name="cp-models" spellcheck="false">[{"id":"custom-chat-model","kind":"chat","supportsStreaming":true}]</textarea></label><div class="model-settings-actions"><button class="btn" onclick="clearCustomProviderForm()">Clear</button><button class="btn btn-primary" onclick="saveCustomProvider()">Save provider</button></div></div></div><div class="model-settings-panel model-settings-list"><h3>Configured providers</h3><div id="custom-providers-content"></div></div></div></div>
  <div class="section" id="sec-model-routing"><div class="section-header"><h2>Model Routing</h2><span class="badge badge-gray" id="model-routing-count">0 models</span><input class="form-input model-filter" id="model-routing-filter" placeholder="Filter models" oninput="renderModelRouting()"></div><div id="model-routing-content"></div></div>
  <div class="section" id="sec-llm-debug"><div class="section-header"><h2>LLM Debug</h2><span class="badge badge-gray" id="llm-debug-count">0 calls</span><span class="badge badge-orange">Memory only</span></div><div class="llm-debug-toolbar"><input class="form-input llm-debug-search" id="llm-debug-filter" placeholder="Filter model, path, request, response, error" oninput="renderLlmDebugLogs()"><select class="form-input" id="llm-debug-status" onchange="renderLlmDebugLogs()"><option value="all">All statuses</option><option value="error">Errors</option><option value="pending">Pending</option><option value="complete">Complete</option></select><select class="form-input" id="llm-debug-path" onchange="renderLlmDebugLogs()"><option value="all">All endpoints</option><option value="/chat/completions">Chat completions</option><option value="/responses">Responses</option><option value="/embeddings">Embeddings</option></select><button class="btn" onclick="loadLlmDebugLogs()">Refresh</button><button class="btn btn-danger" onclick="clearLlmDebugLogs()">Clear</button></div><div id="llm-debug-content"></div></div>
  <div class="section" id="sec-usage"><div class="section-header"><h2>Usage</h2></div><div id="usage-content"></div></div>
  <div class="section" id="sec-settings"><div class="section-header"><h2>Settings</h2><button class="btn btn-primary" onclick="exportConfig()">Export Config</button></div><div id="settings-content"></div></div>
</div>
<script>
var apiKey = sessionStorage.getItem('dashboard_api_key') || localStorage.getItem('dashboard_api_key') || ''
var currentSection = 'overview'
var refreshTimers = {}
var expandedSessions = {}
var eventTimers = {}
var flagsData = {}
var replacementsData = []
var modelRedirectsData = []
var editingModelRedirectId = null
var modelSettingsData = []
var editingModelSettingsModel = null
var customProvidersData = []
var editingCustomProviderId = null
var modelRoutingData = { accounts: [], models: [], multiToken: false }
var llmDebugData = { entries: [], count: 0, retentionMs: 600000 }
var settingsData = null
var ipAllowlistData = []
var expandedLlmDebug = {}
var llmDebugDetails = {}
var llmDebugDetailLoading = {}
var llmDebugListSignature = ''
var llmDebugPanelState = {}
var llmDebugPreScrollState = {}

function apiFetch(method, path, body) {
  var opts = { method: method, headers: { 'Content-Type': 'application/json' } }
  if (apiKey) opts.headers['x-api-key'] = apiKey
  if (body) opts.body = JSON.stringify(body)
  return fetch(path, opts)
}
function esc(s) { if (s == null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }
function escAttr(s) { return esc(s).replace(/'/g,'&#39;') }
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
function showLogin() { document.getElementById('login-screen').classList.add('visible'); document.getElementById('sidebar').style.display = 'none'; document.getElementById('main-content').style.display = 'none' }
function hideLogin() { document.getElementById('login-screen').classList.remove('visible'); document.getElementById('sidebar').style.display = ''; document.getElementById('main-content').style.display = '' }

function authenticate() {
  apiFetch('GET', '/dashboard/api/overview').then(function(res) {
    if (res.status === 401) { showLogin(); return }
    if (res.ok) { hideLogin(); discoverPublicIps(false); navigate(window.location.hash.slice(1) || 'overview'); return }
    showLogin()
  }).catch(function() { showLogin() })
}
function doLogin() {
  var key = document.getElementById('login-key').value.trim()
  if (!key) return
  apiKey = key
  sessionStorage.setItem('dashboard_api_key', key)
  localStorage.setItem('dashboard_api_key', key)
  apiFetch('GET', '/dashboard/api/overview').then(function(res) {
    if (res.ok) { hideLogin(); discoverPublicIps(false); navigate(window.location.hash.slice(1) || 'overview') }
    else { sessionStorage.removeItem('dashboard_api_key'); apiKey = ''; showToast('Invalid API key', 'error') }
  }).catch(function() { showToast('Connection failed', 'error') })
}

function navigate(section) {
  var sections = ['overview','sessions','environments','flags','replacements','model-redirects','model-settings','custom-providers','model-routing','llm-debug','usage','settings']
  if (sections.indexOf(section) === -1) section = 'overview'
  Object.keys(refreshTimers).forEach(function(k) { clearInterval(refreshTimers[k]); delete refreshTimers[k] })
  Object.keys(eventTimers).forEach(function(k) { clearInterval(eventTimers[k]); delete eventTimers[k] })
  currentSection = section
  document.querySelectorAll('.section').forEach(function(el) { el.classList.remove('active') })
  var secEl = document.getElementById('sec-' + section)
  if (secEl) secEl.classList.add('active')
  document.querySelectorAll('.sidebar a, .bottom-nav a').forEach(function(a) { a.classList.toggle('active', a.getAttribute('data-section') === section) })
  loadSection(section)
}
function loadSection(section) {
  switch (section) {
    case 'overview': loadOverview(); break; case 'sessions': loadSessions(); break; case 'environments': loadEnvironments(); break
    case 'flags': loadFlags(); break; case 'replacements': loadReplacements(); break; case 'model-redirects': loadModelRedirects(); break; case 'model-settings': loadModelSettings(); break; case 'custom-providers': loadCustomProviders(); break; case 'model-routing': loadModelRouting(); break; case 'llm-debug': loadLlmDebugLogs(); break; case 'usage': loadUsage(); break; case 'settings': loadSettings(); break
  }
}

function loadOverview() {
  apiFetch('GET', '/dashboard/api/overview').then(function(r) { if (r.ok) return r.json() }).then(function(d) { if (d) renderOverview(d) }).catch(function() { showToast('Failed to load overview', 'error') })
  refreshTimers.overview = setInterval(function() { if (currentSection !== 'overview') return; apiFetch('GET', '/dashboard/api/overview').then(function(r) { if (r.ok) return r.json() }).then(function(d) { if (d) renderOverview(d) }).catch(function(){}) }, 30000)
}
function renderOverview(d) {
  document.getElementById('overview-grid').innerHTML =
    '<div class="stat-card green"><div class="label">Active Sessions</div><div class="value">' + esc(d.activeSessions) + '</div></div>' +
    '<div class="stat-card purple"><div class="label">Direct Connect</div><div class="value">' + esc(d.directConnectCount) + '</div></div>' +
    '<div class="stat-card blue"><div class="label">Environments</div><div class="value">' + esc(d.environmentsCount) + '</div></div>' +
    '<div class="stat-card blue"><div class="label">Feature Flags</div><div class="value">' + esc(d.flagsCount) + '</div></div>' +
    '<div class="stat-card orange"><div class="label">Server Uptime</div><div class="value">' + esc(d.uptime) + '</div></div>' +
    '<div class="stat-card ' + (d.health === 'ok' ? 'green' : 'red') + '"><div class="label">Health</div><div class="value">' + esc(d.health) + '</div></div>'
}

function loadSessions() {
  apiFetch('GET', '/dashboard/api/sessions').then(function(r) { if (r.ok) return r.json() }).then(function(d) { if (d) renderSessions(d) }).catch(function() { showToast('Failed to load sessions', 'error') })
  refreshTimers.sessions = setInterval(function() { if (currentSection !== 'sessions') return; apiFetch('GET', '/dashboard/api/sessions').then(function(r) { if (r.ok) return r.json() }).then(function(d) { if (d) renderSessions(d) }).catch(function(){}) }, 10000)
}
function renderSessions(sessions) {
  var running = sessions.filter(function(s) { return s.state === 'running' || s.state === 'connected' }).length
  var idle = sessions.filter(function(s) { return s.state === 'idle' }).length
  var action = sessions.filter(function(s) { return s.state === 'requires_action' }).length
  var bh = ''
  if (running > 0) bh += '<span class="badge badge-green">' + running + ' Active</span> '
  if (idle > 0) bh += '<span class="badge badge-gray">' + idle + ' Idle</span> '
  if (action > 0) bh += '<span class="badge badge-orange">' + action + ' Action</span> '
  document.getElementById('session-badges').innerHTML = bh
  if (sessions.length === 0) { document.getElementById('sessions-list').innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg><p>No active sessions. Sessions are created when Claude Code connects.</p></div>'; return }
  var eyeSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
  var trashSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
  var rcSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
  var html = '<div class="session-list">'
  sessions.forEach(function(s) {
    var dotClass = s.state === 'running' ? 'running' : s.state === 'requires_action' ? 'requires_action' : s.state === 'connected' ? 'connected' : 'idle'
    var stateBadge = (s.state === 'running' || s.state === 'connected') ? 'badge-green' : s.state === 'requires_action' ? 'badge-orange' : 'badge-gray'
    var typeBadge = s.type === 'direct-connect' ? 'badge-purple' : 'badge-blue'
    html += '<div class="session-card" id="scard-' + esc(s.id) + '"><div class="session-row">'
    html += '<span class="status-dot ' + dotClass + '"></span>'
    html += '<span class="session-title">' + esc(s.title || 'Untitled Session') + '</span>'
    html += '<span class="badge ' + stateBadge + '">' + esc(s.state || 'unknown') + '</span>'
    html += '<span class="badge ' + typeBadge + '">' + esc(s.type) + '</span>'
    html += '<span class="session-actions">'
    if (s.type === 'code-session') html += '<button class="icon-btn" onclick="window.open(\\'/remote?session=' + esc(s.id) + '\\',\\'_blank\\')" title="Remote Control" style="color:#22C55E;border-color:#22C55E40">' + rcSvg + '</button>'
    if (s.type === 'code-session') html += '<button class="icon-btn" onclick="toggleEvents(\\'' + esc(s.id) + '\\')" title="View events">' + eyeSvg + '</button>'
    html += '<button class="icon-btn danger" onclick="destroySession(\\'' + esc(s.id) + '\\',\\'' + esc(s.type) + '\\')" title="Remove">' + trashSvg + '</button>'
    html += '</span></div><div class="session-meta"><span class="session-id">' + esc(s.id) + '</span>'
    if (s.createdAt) html += '<span>' + timeAgo(s.createdAt) + '</span>'
    html += '</div>'
    if (s.state === 'requires_action' && s.tags) { var at = s.tags.find(function(t) { return t.indexOf('action:') === 0 }); if (at) html += '<div class="action-desc">' + esc(at.slice(7)) + '</div>' }
    if (expandedSessions[s.id]) html += '<div class="events-panel" id="events-' + esc(s.id) + '">Loading events...</div>'
    html += '</div>'
  })
  html += '</div>'
  document.getElementById('sessions-list').innerHTML = html
  Object.keys(expandedSessions).forEach(function(id) { if (expandedSessions[id]) loadEvents(id) })
}
function toggleEvents(id) {
  if (expandedSessions[id]) { expandedSessions[id] = false; if (eventTimers[id]) { clearInterval(eventTimers[id]); delete eventTimers[id] }; var p = document.getElementById('events-' + id); if (p) p.remove() }
  else { expandedSessions[id] = true; var card = document.getElementById('scard-' + id); if (card) { var panel = document.createElement('div'); panel.className = 'events-panel'; panel.id = 'events-' + id; panel.textContent = 'Loading events...'; card.appendChild(panel); loadEvents(id); eventTimers[id] = setInterval(function() { loadEvents(id) }, 5000) } }
}
function loadEvents(id) { apiFetch('GET', '/dashboard/api/sessions/' + encodeURIComponent(id) + '/events').then(function(r) { if (r.ok) return r.json() }).then(function(ev) { if (ev) renderEvents(id, ev) }).catch(function(){}) }
function renderEvents(id, events) {
  var panel = document.getElementById('events-' + id); if (!panel) return
  if (!events || events.length === 0) { panel.innerHTML = '<div style="color:#94A3B8;text-align:center;padding:12px">No events yet</div>'; return }
  var html = ''
  events.forEach(function(ev, i) {
    var payload = ''
    if (ev.data) { try { payload = typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data) } catch(e) { payload = String(ev.data) }; if (payload.length > 200) payload = payload.slice(0, 200) + '...' }
    html += '<div class="event-row"><span class="event-seq">#' + (ev.seq != null ? ev.seq : i) + '</span><span class="event-type">' + esc(ev.type || ev.event || '') + '</span><span class="event-source">' + esc(ev.source || '') + '</span><span class="event-time">' + (ev.timestamp ? timeAgo(ev.timestamp) : '') + '</span>'
    if (payload) html += '<div class="event-payload" title="' + esc(payload) + '">' + esc(payload) + '</div>'
    html += '</div>'
  })
  panel.innerHTML = html
}
function destroySession(id, type) {
  var label = type === 'direct-connect' ? 'Destroy this direct-connect session?' : 'Archive this session?'
  if (!confirm(label)) return
  var url = type === 'direct-connect' ? '/dashboard/api/sessions/' + encodeURIComponent(id) : '/dashboard/api/sessions/' + encodeURIComponent(id) + '/archive'
  var method = type === 'direct-connect' ? 'DELETE' : 'POST'
  apiFetch(method, url).then(function(r) { if (r.ok) { showToast('Session removed', 'success'); loadSessions() } else { r.json().catch(function() { return {} }).then(function(d) { showToast(d.error || 'Failed', 'error') }) } }).catch(function() { showToast('Failed to remove session', 'error') })
}

function loadEnvironments() {
  apiFetch('GET', '/dashboard/api/environments').then(function(r) { if (r.ok) return r.json() }).then(function(d) { if (d) renderEnvironments(d) }).catch(function() { showToast('Failed to load environments', 'error') })
  refreshTimers.environments = setInterval(function() { if (currentSection !== 'environments') return; apiFetch('GET', '/dashboard/api/environments').then(function(r) { if (r.ok) return r.json() }).then(function(d) { if (d) renderEnvironments(d) }).catch(function(){}) }, 30000)
}
function renderEnvironments(envs) {
  if (!envs || envs.length === 0) { document.getElementById('environments-content').innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg><p>No environments registered. Use claude remote-control to register.</p></div>'; return }
  var html = '<div class="table-scroll"><table><thead><tr><th>ID</th><th>Machine</th><th>Directory</th><th>Branch</th><th>Max Sessions</th><th>Pending</th><th>Created</th><th></th></tr></thead><tbody>'
  envs.forEach(function(env) {
    html += '<tr><td class="mono" style="font-size:11px">' + esc(env.id) + '</td><td>' + esc(env.machineName) + '</td><td class="mono" style="font-size:12px">' + esc(env.directory) + '</td><td>' + esc(env.branch || '-') + '</td><td>' + esc(env.maxSessions) + '</td><td>' + esc(env.pendingWorkCount) + '</td><td>' + timeAgo(env.createdAt) + '</td><td style="white-space:nowrap"><button class="btn btn-primary" style="font-size:0.78rem;padding:4px 10px;margin-right:4px" onclick="startEnvSession(\\'' + esc(env.id) + '\\')">Start Session</button><button class="btn btn-danger" style="font-size:0.78rem;padding:4px 10px" onclick="deregisterEnv(\\'' + esc(env.id) + '\\')">Deregister</button></td></tr>'
  })
  html += '</tbody></table></div>'
  document.getElementById('environments-content').innerHTML = html
}
function deregisterEnv(id) {
  if (!confirm('Deregister this environment?')) return
  apiFetch('DELETE', '/dashboard/api/environments/' + encodeURIComponent(id)).then(function(r) { if (r.ok) { showToast('Environment deregistered', 'success'); loadEnvironments() } else showToast('Failed to deregister', 'error') }).catch(function() { showToast('Failed to deregister', 'error') })
}
function startEnvSession(envId) {
  apiFetch('POST', '/dashboard/api/environments/' + encodeURIComponent(envId) + '/start').then(function(r) { if (r.ok) return r.json(); throw new Error('Failed') }).then(function(d) {
    showToast('Session started: ' + d.sessionId, 'success')
    loadEnvironments()
    window.open('/remote?session=' + encodeURIComponent(d.sessionId), '_blank')
  }).catch(function() { showToast('Failed to start session', 'error') })
}

function loadFlags() {
  apiFetch('GET', '/dashboard/api/flags').then(function(r) { if (r.ok) return r.json() }).then(function(d) { if (d) { flagsData = d; renderFlags() } }).catch(function() { showToast('Failed to load flags', 'error') })
}
function renderFlags() {
  var entries = Object.entries(flagsData)
  if (entries.length === 0) { document.getElementById('flags-content').innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg><p>No feature flags configured.</p></div>'; return }
  entries.sort(function(a, b) { return a[0].localeCompare(b[0]) })
  var html = '<div class="table-scroll"><table><thead><tr><th>Flag</th><th>Value</th><th>Actions</th></tr></thead><tbody>'
  entries.forEach(function(entry) {
    var name = entry[0], value = entry[1], isBool = typeof value === 'boolean'
    var displayVal = typeof value === 'object' ? JSON.stringify(value) : String(value)
    html += '<tr><td class="mono" style="font-size:0.85rem">' + esc(name) + '</td><td style="font-size:0.85rem;color:#94A3B8">' + esc(displayVal) + '</td><td style="white-space:nowrap">'
    if (isBool) html += '<button class="toggle ' + (value ? 'on' : 'off') + '" onclick="toggleFlag(\\'' + esc(name) + '\\')"></button> '
    html += '<button class="btn btn-danger" style="font-size:0.78rem;padding:4px 10px" onclick="deleteFlag(\\'' + esc(name) + '\\')">Delete</button></td></tr>'
  })
  html += '</tbody></table></div>'
  document.getElementById('flags-content').innerHTML = html
}
function toggleFlag(name) { flagsData[name] = !flagsData[name]; renderFlags(); apiFetch('POST', '/dashboard/api/flags', { name: name, value: flagsData[name] }).catch(function() { showToast('Failed to toggle flag', 'error') }) }
function deleteFlag(name) {
  if (!confirm('Delete flag "' + name + '"?')) return
  apiFetch('DELETE', '/dashboard/api/flags', { name: name }).then(function(r) { if (r.ok) { delete flagsData[name]; renderFlags(); showToast('Flag deleted', 'success') } else showToast('Failed to delete flag', 'error') }).catch(function() { showToast('Failed to delete flag', 'error') })
}
function addFlag() {
  var nameEl = document.querySelector('#flag-form input[name="flag-name"]'), valEl = document.querySelector('#flag-form input[name="flag-value"]')
  var name = nameEl.value.trim(), rawVal = valEl.value.trim()
  if (!name) return
  var value
  if (rawVal === 'true') value = true; else if (rawVal === 'false') value = false
  else if (rawVal !== '' && !isNaN(Number(rawVal))) value = Number(rawVal)
  else { try { value = JSON.parse(rawVal) } catch(e) { value = rawVal || true } }
  apiFetch('POST', '/dashboard/api/flags', { name: name, value: value }).then(function(r) { if (r.ok) { flagsData[name] = value; renderFlags(); nameEl.value = ''; valEl.value = ''; showToast('Flag added', 'success') } else showToast('Failed to add flag', 'error') }).catch(function() { showToast('Failed to add flag', 'error') })
}

function loadReplacements() {
  apiFetch('GET', '/dashboard/api/replacements').then(function(r) { if (r.ok) return r.json() }).then(function(d) { if (d) { replacementsData = d; renderReplacements() } }).catch(function() { showToast('Failed to load replacements', 'error') })
}
function renderReplacements() {
  if (!replacementsData || replacementsData.length === 0) { document.getElementById('replacements-content').innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg><p>No replacements configured.</p></div>'; return }
  var html = '<div class="table-scroll"><table><thead><tr><th>Name</th><th>Pattern</th><th>Replacement</th><th>Type</th><th>Enabled</th><th>Actions</th></tr></thead><tbody>'
  replacementsData.forEach(function(r) {
    var isSys = r.isSystem, typeBadge = r.isRegex ? '<span class="badge badge-purple">regex</span>' : '<span class="badge badge-blue">string</span>'
    html += '<tr><td>' + esc(r.name || '-') + (isSys ? ' <span class="badge badge-gray">system</span>' : '') + '</td><td class="mono" style="font-size:12px">' + esc(r.pattern) + '</td><td style="font-size:0.85rem">' + esc(r.replacement || '') + '</td><td>' + typeBadge + '</td><td>'
    if (isSys) html += '<button class="toggle ' + (r.enabled !== false ? 'on' : 'off') + ' disabled" disabled></button>'
    else html += '<button class="toggle ' + (r.enabled !== false ? 'on' : 'off') + '" onclick="toggleReplacement(\\'' + esc(r.id) + '\\')"></button>'
    html += '</td><td>'
    if (isSys) html += '<button class="btn" style="font-size:0.78rem;padding:4px 10px;opacity:0.3;cursor:not-allowed" disabled>Delete</button>'
    else html += '<button class="btn btn-danger" style="font-size:0.78rem;padding:4px 10px" onclick="deleteReplacement(\\'' + esc(r.id) + '\\')">Delete</button>'
    html += '</td></tr>'
  })
  html += '</tbody></table></div>'
  document.getElementById('replacements-content').innerHTML = html
}
function toggleReplacement(id) { apiFetch('PATCH', '/dashboard/api/replacements/' + encodeURIComponent(id)).then(function(r) { if (r.ok) { showToast('Toggled', 'success'); loadReplacements() } else showToast('Failed to toggle', 'error') }).catch(function() { showToast('Failed to toggle', 'error') }) }
function deleteReplacement(id) {
  if (!confirm('Delete this replacement rule?')) return
  apiFetch('DELETE', '/dashboard/api/replacements/' + encodeURIComponent(id)).then(function(r) { if (r.ok) { showToast('Deleted', 'success'); loadReplacements() } else showToast('Failed to delete', 'error') }).catch(function() { showToast('Failed to delete', 'error') })
}
function addReplacement() {
  var nameEl = document.querySelector('#replacement-form input[name="repl-name"]'), patEl = document.querySelector('#replacement-form input[name="repl-pattern"]')
  var replEl = document.querySelector('#replacement-form input[name="repl-replacement"]'), regexEl = document.querySelector('#replacement-form input[name="repl-regex"]')
  var pattern = patEl.value.trim(); if (!pattern) return
  var body = { pattern: pattern, replacement: replEl.value, isRegex: regexEl.checked, name: nameEl.value.trim() || undefined }
  apiFetch('POST', '/dashboard/api/replacements', body).then(function(r) { if (r.ok) { nameEl.value = ''; patEl.value = ''; replEl.value = ''; regexEl.checked = false; showToast('Added', 'success'); loadReplacements() } else r.json().catch(function() { return {} }).then(function(d) { showToast(d.error || 'Failed', 'error') }) }).catch(function() { showToast('Failed to add', 'error') })
}

function loadModelRedirects() {
  apiFetch('GET', '/dashboard/api/model-redirects').then(function(r) { if (r.ok) return r.json() }).then(function(d) { if (d) { modelRedirectsData = d; renderModelRedirects() } }).catch(function() { showToast('Failed to load model redirects', 'error') })
}
function effortLabel(effort, isTarget) {
  if (!effort && isTarget) return 'Preserve'
  if (effort === 'all') return 'All effort levels'
  if (effort === 'default') return 'Default/no effort'
  return effort || 'All effort levels'
}
function effortValue(effort, isTarget) {
  if (!effort && isTarget) return ''
  return effort || 'all'
}
function optionHtml(value, label, selectedValue) {
  return '<option value="' + esc(value) + '"' + (value === selectedValue ? ' selected' : '') + '>' + esc(label) + '</option>'
}
function sourceEffortSelect(name, value) {
  var selected = effortValue(value, false)
  return '<select class="form-input" name="' + name + '">' + optionHtml('all', 'All effort levels', selected) + optionHtml('default', 'Default/no effort', selected) + optionHtml('low', 'low', selected) + optionHtml('medium', 'medium', selected) + optionHtml('high', 'high', selected) + optionHtml('xhigh', 'xhigh', selected) + optionHtml('max', 'max', selected) + '</select>'
}
function targetEffortSelect(name, value) {
  var selected = effortValue(value, true)
  return '<select class="form-input" name="' + name + '">' + optionHtml('', 'Preserve effort', selected) + optionHtml('low', 'low', selected) + optionHtml('medium', 'medium', selected) + optionHtml('high', 'high', selected) + optionHtml('xhigh', 'xhigh', selected) + optionHtml('max', 'max', selected) + '</select>'
}
function conflictLabel(conflicts) {
  if (!conflicts || conflicts.length === 0) return '<span class="badge badge-green">clear</span>'
  var names = conflicts.map(function(c) { return c.name || c.id }).join(', ')
  return '<span class="badge badge-red" title="Conflicts with: ' + esc(names) + '">' + conflicts.length + ' conflict' + (conflicts.length === 1 ? '' : 's') + '</span>'
}
function renderModelRedirects() {
  if (!modelRedirectsData || modelRedirectsData.length === 0) { document.getElementById('model-redirects-content').innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 12h13"/><path d="M16 6l6 6-6 6"/><path d="M3 6v12"/></svg><p>No model redirects configured.</p><p style="font-size:0.8rem;margin-top:6px">Add a redirect to silently route one requested model to another.</p></div>'; return }
  var html = '<div class="table-scroll"><table><thead><tr><th>Order</th><th>Name</th><th>Source</th><th></th><th>Target</th><th>Conflicts</th><th>Enabled</th><th>Actions</th></tr></thead><tbody>'
  modelRedirectsData.forEach(function(r, index) {
    if (editingModelRedirectId === r.id) {
      html += '<tr id="model-redirect-edit-' + esc(r.id) + '"><td style="white-space:nowrap"><button class="btn" title="Move up" style="font-size:0.78rem;padding:4px 8px" disabled>&uarr;</button> <button class="btn" title="Move down" style="font-size:0.78rem;padding:4px 8px" disabled>&darr;</button></td>'
      html += '<td><input class="form-input" name="mr-edit-name" value="' + esc(r.name || '') + '" placeholder="Name" style="min-width:120px;width:100%"></td>'
      html += '<td><input class="form-input mono" name="mr-edit-source" value="' + esc(r.sourceModel) + '" placeholder="Source model" style="min-width:200px;width:100%;margin-bottom:6px">' + sourceEffortSelect('mr-edit-source-effort', r.sourceEffort) + '</td>'
      html += '<td style="color:#94A3B8">&rarr;</td><td><input class="form-input mono" name="mr-edit-target" value="' + esc(r.targetModel) + '" placeholder="Target model" style="min-width:200px;width:100%;margin-bottom:6px">' + targetEffortSelect('mr-edit-target-effort', r.targetEffort) + '</td>'
      html += '<td>' + conflictLabel(r.conflicts) + '</td><td><button class="toggle ' + (r.enabled !== false ? 'on' : 'off') + '" onclick="toggleModelRedirect(\\'' + esc(r.id) + '\\')"></button></td>'
      html += '<td style="white-space:nowrap"><button class="btn btn-primary" style="font-size:0.78rem;padding:4px 10px" onclick="saveModelRedirect(\\'' + esc(r.id) + '\\')">Save</button> <button class="btn" style="font-size:0.78rem;padding:4px 10px" onclick="cancelModelRedirectEdit()">Cancel</button></td></tr>'
      return
    }
    var upDisabled = index === 0 ? ' disabled' : ''
    var downDisabled = index === modelRedirectsData.length - 1 ? ' disabled' : ''
    html += '<tr><td style="white-space:nowrap"><button class="btn" title="Move up" style="font-size:0.78rem;padding:4px 8px"' + upDisabled + ' onclick="moveModelRedirect(&quot;' + esc(r.id) + '&quot;,&quot;up&quot;)">&uarr;</button> <button class="btn" title="Move down" style="font-size:0.78rem;padding:4px 8px"' + downDisabled + ' onclick="moveModelRedirect(&quot;' + esc(r.id) + '&quot;,&quot;down&quot;)">&darr;</button></td>'
    html += '<td>' + esc(r.name || '-') + '</td><td><div class="mono" style="font-size:12px">' + esc(r.sourceModel) + '</div><span class="badge badge-blue">' + esc(effortLabel(r.sourceEffort, false)) + '</span></td><td style="color:#94A3B8">&rarr;</td><td><div class="mono" style="font-size:12px">' + esc(r.targetModel) + '</div><span class="badge badge-purple">' + esc(effortLabel(r.targetEffort, true)) + '</span></td><td>' + conflictLabel(r.conflicts) + '</td><td>'
    html += '<button class="toggle ' + (r.enabled !== false ? 'on' : 'off') + '" onclick="toggleModelRedirect(\\'' + esc(r.id) + '\\')"></button>'
    html += '</td><td style="white-space:nowrap"><button class="btn" style="font-size:0.78rem;padding:4px 10px" onclick="editModelRedirect(\\'' + esc(r.id) + '\\')">Edit</button> <button class="btn btn-danger" style="font-size:0.78rem;padding:4px 10px" onclick="deleteModelRedirect(\\'' + esc(r.id) + '\\')">Delete</button></td></tr>'
  })
  html += '</tbody></table></div>'
  document.getElementById('model-redirects-content').innerHTML = html
}
function editModelRedirect(id) { editingModelRedirectId = id; renderModelRedirects() }
function cancelModelRedirectEdit() { editingModelRedirectId = null; renderModelRedirects() }
function saveModelRedirect(id) {
  var row = document.getElementById('model-redirect-edit-' + id)
  if (!row) return
  var nameEl = row.querySelector('input[name="mr-edit-name"]')
  var srcEl = row.querySelector('input[name="mr-edit-source"]')
  var srcEffortEl = row.querySelector('select[name="mr-edit-source-effort"]')
  var tgtEl = row.querySelector('input[name="mr-edit-target"]')
  var tgtEffortEl = row.querySelector('select[name="mr-edit-target-effort"]')
  var src = srcEl.value.trim(), tgt = tgtEl.value.trim()
  if (!src || !tgt) { showToast('Source and target models are required', 'error'); return }
  var body = { name: nameEl.value.trim(), sourceModel: src, sourceEffort: srcEffortEl.value, targetModel: tgt, targetEffort: tgtEffortEl.value || null }
  apiFetch('PATCH', '/dashboard/api/model-redirects/' + encodeURIComponent(id), body).then(function(r) { if (r.ok) { editingModelRedirectId = null; showToast('Updated', 'success'); loadModelRedirects() } else r.json().catch(function() { return {} }).then(function(d) { showToast(d.error || 'Failed to update', 'error') }) }).catch(function() { showToast('Failed to update', 'error') })
}
function toggleModelRedirect(id) { apiFetch('PATCH', '/dashboard/api/model-redirects/' + encodeURIComponent(id) + '/toggle').then(function(r) { if (r.ok) { showToast('Toggled', 'success'); loadModelRedirects() } else showToast('Failed to toggle', 'error') }).catch(function() { showToast('Failed to toggle', 'error') }) }
function moveModelRedirect(id, direction) {
  apiFetch('POST', '/dashboard/api/model-redirects/' + encodeURIComponent(id) + '/move', { direction: direction }).then(function(r) { if (r.ok) { showToast('Order updated', 'success'); loadModelRedirects() } else showToast('Failed to move', 'error') }).catch(function() { showToast('Failed to move', 'error') })
}
function deleteModelRedirect(id) {
  if (!confirm('Delete this model redirect?')) return
  apiFetch('DELETE', '/dashboard/api/model-redirects/' + encodeURIComponent(id)).then(function(r) { if (r.ok) { showToast('Deleted', 'success'); loadModelRedirects() } else showToast('Failed to delete', 'error') }).catch(function() { showToast('Failed to delete', 'error') })
}
function addModelRedirect() {
  var nameEl = document.querySelector('#model-redirect-form input[name="mr-name"]')
  var srcEl = document.querySelector('#model-redirect-form input[name="mr-source"]')
  var srcEffortEl = document.querySelector('#model-redirect-form select[name="mr-source-effort"]')
  var tgtEl = document.querySelector('#model-redirect-form input[name="mr-target"]')
  var tgtEffortEl = document.querySelector('#model-redirect-form select[name="mr-target-effort"]')
  var src = srcEl.value.trim(), tgt = tgtEl.value.trim()
  if (!src || !tgt) { showToast('Source and target models are required', 'error'); return }
  var body = { sourceModel: src, sourceEffort: srcEffortEl.value, targetModel: tgt, targetEffort: tgtEffortEl.value || undefined, name: nameEl.value.trim() || undefined }
  apiFetch('POST', '/dashboard/api/model-redirects', body).then(function(r) { if (r.ok) { nameEl.value = ''; srcEl.value = ''; srcEffortEl.value = 'all'; tgtEl.value = ''; tgtEffortEl.value = ''; showToast('Added', 'success'); loadModelRedirects() } else r.json().catch(function() { return {} }).then(function(d) { showToast(d.error || 'Failed', 'error') }) }).catch(function() { showToast('Failed to add', 'error') })
}

function ensureModelSettingsPrefillControl() {
  var form = document.getElementById('model-settings-form')
  if (!form || form.querySelector('select[name="ms-prefill"]')) return
  var options = form.querySelector('.settings-options')
  if (!options) return
  var label = document.createElement('label')
  label.innerHTML = '<span class="field-label">Assistant prefill <span class="optional">optional</span></span><select class="form-input full-input" name="ms-prefill"><option value="">Not set</option><option value="true">Supported</option><option value="false">Unsupported</option></select>'
  options.appendChild(label)
}
function loadModelSettings() {
  ensureModelSettingsPrefillControl()
  apiFetch('GET', '/dashboard/api/model-settings').then(function(r) { if (r.ok) return r.json() }).then(function(d) { if (d) { modelSettingsData = d; renderModelSettings() } }).catch(function() { showToast('Failed to load model settings', 'error') })
}
function selectedOptions(selectEl) {
  return Array.prototype.slice.call(selectEl.options).filter(function(o) { return o.selected }).map(function(o) { return o.value })
}
function selectedEffortChecks(root) {
  return Array.prototype.slice.call(root.querySelectorAll('input[name="ms-effort"]')).filter(function(o) { return o.checked }).map(function(o) { return o.value })
}
function setEffortChecks(root, efforts) {
  var selected = efforts || []
  Array.prototype.forEach.call(root.querySelectorAll('input[name="ms-effort"]'), function(o) { o.checked = selected.indexOf(o.value) !== -1 })
}
function selectedParamChecks(root) {
  return Array.prototype.slice.call(root.querySelectorAll('input[name="ms-param"]')).filter(function(o) { return o.checked }).map(function(o) { return o.value })
}
function setParamChecks(root, params) {
  var selected = params || []
  Array.prototype.forEach.call(root.querySelectorAll('input[name="ms-param"]'), function(o) { o.checked = selected.indexOf(o.value) !== -1 })
}
function effortListLabel(efforts) {
  if (!efforts || efforts.length === 0) return '<span class="badge badge-gray">not set</span>'
  return efforts.map(function(e) { return '<span class="badge badge-blue">' + esc(e) + '</span>' }).join(' ')
}
function requestParamListLabel(params) {
  if (!params || params.length === 0) return '<span class="badge badge-gray">not set</span>'
  return params.map(function(p) { return '<span class="badge badge-orange">' + esc(p) + '</span>' }).join(' ')
}
function boolBadge(value) {
  if (value === true) return '<span class="bool-yes">Yes</span>'
  if (value === false) return '<span class="bool-no">No</span>'
  return '<span class="badge badge-gray">not set</span>'
}
function assistantPrefillBadge(value) {
  if (value === true) return '<span class="bool-yes">Supported</span>'
  if (value === false) return '<span class="bool-no">Unsupported</span>'
  return '<span class="badge badge-gray">not set</span>'
}
function boolSelect(name, value, trueLabel, falseLabel) {
  var selected = value === undefined ? '' : String(value)
  return '<select class="form-input" name="' + name + '">' + optionHtml('', 'Not set', selected) + optionHtml('true', trueLabel, selected) + optionHtml('false', falseLabel, selected) + '</select>'
}
function effortMultiSelect(name, values) {
  var selected = values || []
  return '<div class="effort-picker" data-efforts="' + name + '"><label class="choice-pill"><input type="checkbox" name="ms-effort" value="low"' + (selected.indexOf('low') !== -1 ? ' checked' : '') + '><span>low</span></label><label class="choice-pill"><input type="checkbox" name="ms-effort" value="medium"' + (selected.indexOf('medium') !== -1 ? ' checked' : '') + '><span>medium</span></label><label class="choice-pill"><input type="checkbox" name="ms-effort" value="high"' + (selected.indexOf('high') !== -1 ? ' checked' : '') + '><span>high</span></label><label class="choice-pill"><input type="checkbox" name="ms-effort" value="xhigh"' + (selected.indexOf('xhigh') !== -1 ? ' checked' : '') + '><span>xhigh</span></label><label class="choice-pill"><input type="checkbox" name="ms-effort" value="max"' + (selected.indexOf('max') !== -1 ? ' checked' : '') + '><span>max</span></label></div>'
}
function defaultEffortSelect(name, value) {
  var selected = value || ''
  return '<select class="form-input" name="' + name + '">' + optionHtml('', 'Default effort', selected) + optionHtml('low', 'low', selected) + optionHtml('medium', 'medium', selected) + optionHtml('high', 'high', selected) + optionHtml('xhigh', 'xhigh', selected) + optionHtml('max', 'max', selected) + '</select>'
}
function requestParamMultiSelect(name, values) {
  var selected = values || []
  return '<div class="effort-picker" data-params="' + name + '"><label class="choice-pill"><input type="checkbox" name="ms-param" value="temperature"' + (selected.indexOf('temperature') !== -1 ? ' checked' : '') + '><span>temperature</span></label><label class="choice-pill"><input type="checkbox" name="ms-param" value="top_p"' + (selected.indexOf('top_p') !== -1 ? ' checked' : '') + '><span>top_p</span></label></div>'
}
function renderModelSettings() {
  var content = document.getElementById('model-settings-content')
  if (!modelSettingsData || modelSettingsData.length === 0) { content.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10"/><path d="M7 12h4"/><path d="M13 12h4"/><path d="M7 16h10"/></svg><p>No per-model settings configured.</p></div>'; return }
  var html = '<div class="table-scroll"><table><thead><tr><th>Model</th><th>Sentry Name</th><th>Supported Efforts</th><th>Default</th><th>Implicit Default</th><th>Virtual Variants</th><th>Assistant Prefill</th><th>Omit Params</th><th>Actions</th></tr></thead><tbody>'
  modelSettingsData.forEach(function(s) {
    if (editingModelSettingsModel === s.model) {
      html += '<tr id="model-settings-edit-' + esc(s.model) + '"><td><div class="mono" style="font-size:12px">' + esc(s.model) + '</div></td>'
      html += '<td><input class="form-input mono" name="ms-edit-sentry-model" value="' + esc(s.sentryModelName || '') + '" placeholder="Sentry name" style="min-width:180px;width:100%"></td>'
      html += '<td>' + effortMultiSelect('ms-edit-efforts', s.supportedReasoningEfforts || []) + '</td><td>' + defaultEffortSelect('ms-edit-default', s.defaultReasoningEffort) + '</td>'
      html += '<td>' + boolSelect('ms-edit-implicit', s.implicitReasoningDefault, 'Enabled', 'Disabled') + '</td>'
      html += '<td>' + boolSelect('ms-edit-virtual', s.exposeVirtualReasoningModels, 'Show', 'Hide') + '</td>'
      html += '<td>' + boolSelect('ms-edit-prefill', s.supportsAssistantPrefill, 'Supported', 'Unsupported') + '</td>'
      html += '<td>' + requestParamMultiSelect('ms-edit-unsupported-params', s.unsupportedRequestParameters || []) + '</td>'
      html += '<td style="white-space:nowrap"><button class="btn btn-primary" style="font-size:0.78rem;padding:4px 10px" onclick="saveModelSettings(&quot;' + esc(s.model) + '&quot;)">Save</button> <button class="btn" style="font-size:0.78rem;padding:4px 10px" onclick="cancelModelSettingsEdit()">Cancel</button></td></tr>'
      return
    }
    html += '<tr><td><div class="model-name mono">' + esc(s.model) + '</div></td><td>' + (s.sentryModelName ? '<span class="badge badge-blue mono">' + esc(s.sentryModelName) + '</span>' : '<span class="badge badge-gray">not set</span>') + '</td><td>' + effortListLabel(s.supportedReasoningEfforts) + '</td><td>' + (s.defaultReasoningEffort ? '<span class="badge badge-purple">' + esc(s.defaultReasoningEffort) + '</span>' : '<span class="badge badge-gray">not set</span>') + '</td><td>' + boolBadge(s.implicitReasoningDefault) + '</td><td>' + boolBadge(s.exposeVirtualReasoningModels) + '</td><td>' + assistantPrefillBadge(s.supportsAssistantPrefill) + '</td><td>' + requestParamListLabel(s.unsupportedRequestParameters) + '</td>'
    html += '<td style="white-space:nowrap"><button class="btn" style="font-size:0.78rem;padding:4px 10px" onclick="editModelSettings(&quot;' + esc(s.model) + '&quot;)">Edit</button> <button class="btn btn-danger" style="font-size:0.78rem;padding:4px 10px" onclick="deleteModelSettings(&quot;' + esc(s.model) + '&quot;)">Delete</button></td></tr>'
  })
  html += '</tbody></table></div>'
  content.innerHTML = html
}
function editModelSettings(model) { editingModelSettingsModel = model; renderModelSettings() }
function cancelModelSettingsEdit() { editingModelSettingsModel = null; renderModelSettings() }
function boolSettingValue(selectEl) {
  if (selectEl.value === 'true') return true
  if (selectEl.value === 'false') return false
  return null
}
function modelSettingsBody(model, sentryEl, effortsEl, defaultEl, implicitEl, virtualEl, prefillEl, paramsEl, includeUnset) {
  var efforts = effortsEl.tagName === 'SELECT' ? selectedOptions(effortsEl) : selectedEffortChecks(effortsEl)
  var params = selectedParamChecks(paramsEl)
  var body = { model: model }
  var sentryModelName = sentryEl.value.trim()
  var implicit = boolSettingValue(implicitEl)
  var virtual = boolSettingValue(virtualEl)
  var prefill = boolSettingValue(prefillEl)
  if (sentryModelName || includeUnset) body.sentryModelName = sentryModelName || null
  if (efforts.length > 0 || includeUnset) body.supportedReasoningEfforts = efforts.length > 0 ? efforts : null
  if (defaultEl.value || includeUnset) body.defaultReasoningEffort = defaultEl.value || null
  if (implicit !== null || includeUnset) body.implicitReasoningDefault = implicit
  if (virtual !== null || includeUnset) body.exposeVirtualReasoningModels = virtual
  if (prefill !== null || includeUnset) body.supportsAssistantPrefill = prefill
  if (params.length > 0 || includeUnset) body.unsupportedRequestParameters = params.length > 0 ? params : null
  return body
}
function saveModelSettings(model) {
  var row = document.getElementById('model-settings-edit-' + model)
  if (!row) return
  var body = modelSettingsBody(model, row.querySelector('input[name="ms-edit-sentry-model"]'), row.querySelector('[data-efforts="ms-edit-efforts"]'), row.querySelector('select[name="ms-edit-default"]'), row.querySelector('select[name="ms-edit-implicit"]'), row.querySelector('select[name="ms-edit-virtual"]'), row.querySelector('select[name="ms-edit-prefill"]'), row.querySelector('[data-params="ms-edit-unsupported-params"]'), true)
  apiFetch('POST', '/dashboard/api/model-settings', body).then(function(r) { if (r.ok) { editingModelSettingsModel = null; showToast('Saved', 'success'); loadModelSettings() } else r.json().catch(function() { return {} }).then(function(d) { showToast(d.error || 'Failed to save', 'error') }) }).catch(function() { showToast('Failed to save', 'error') })
}
function deleteModelSettings(model) {
  if (!confirm('Delete settings for ' + model + '?')) return
  apiFetch('DELETE', '/dashboard/api/model-settings/' + encodeURIComponent(model)).then(function(r) { if (r.ok) { showToast('Deleted', 'success'); loadModelSettings() } else showToast('Failed to delete', 'error') }).catch(function() { showToast('Failed to delete', 'error') })
}
function addModelSettings() {
  ensureModelSettingsPrefillControl()
  var form = document.getElementById('model-settings-form')
  var modelEl = form.querySelector('input[name="ms-model"]')
  var sentryEl = form.querySelector('input[name="ms-sentry-model"]')
  var effortsEl = form.querySelector('[data-efforts="ms-efforts"]')
  var defaultEl = form.querySelector('select[name="ms-default"]')
  var implicitEl = form.querySelector('select[name="ms-implicit"]')
  var virtualEl = form.querySelector('select[name="ms-virtual"]')
  var prefillEl = form.querySelector('select[name="ms-prefill"]')
  var paramsEl = form.querySelector('[data-params="ms-unsupported-params"]')
  var model = modelEl.value.trim()
  if (!model) { showToast('Model ID is required', 'error'); return }
  var body = modelSettingsBody(model, sentryEl, effortsEl, defaultEl, implicitEl, virtualEl, prefillEl, paramsEl, false)
  if (Object.keys(body).length === 1) { showToast('Set a Sentry name or another model setting', 'error'); return }
  apiFetch('POST', '/dashboard/api/model-settings', body).then(function(r) { if (r.ok) { modelEl.value = ''; sentryEl.value = ''; clearModelSettingsForm(); showToast('Saved', 'success'); loadModelSettings() } else r.json().catch(function() { return {} }).then(function(d) { showToast(d.error || 'Failed to save', 'error') }) }).catch(function() { showToast('Failed to save', 'error') })
}
function clearModelSettingsForm() {
  ensureModelSettingsPrefillControl()
  var form = document.getElementById('model-settings-form')
  setEffortChecks(form, [])
  form.querySelector('select[name="ms-default"]').value = ''
  form.querySelector('select[name="ms-implicit"]').value = ''
  form.querySelector('select[name="ms-virtual"]').value = ''
  form.querySelector('select[name="ms-prefill"]').value = ''
  setParamChecks(form, [])
}
function applyImplicitMediumPreset() {
  var form = document.getElementById('model-settings-form')
  setEffortChecks(form, ['medium'])
  form.querySelector('select[name="ms-default"]').value = 'medium'
  form.querySelector('select[name="ms-implicit"]').value = 'true'
  form.querySelector('select[name="ms-virtual"]').value = 'false'
}
function applyNoSamplingPreset() {
  var form = document.getElementById('model-settings-form')
  setParamChecks(form, ['temperature', 'top_p'])
}

function loadCustomProviders() {
  apiFetch('GET', '/dashboard/api/custom-providers').then(function(r) { if (r.ok) return r.json() }).then(function(d) { if (d) { customProvidersData = d; renderCustomProviders() } }).catch(function() { showToast('Failed to load custom providers', 'error') })
}
function renderCustomProviders() {
  var content = document.getElementById('custom-providers-content')
  var count = document.getElementById('custom-provider-count')
  if (count) count.textContent = customProvidersData.length + ' provider' + (customProvidersData.length === 1 ? '' : 's')
  if (!customProvidersData || customProvidersData.length === 0) { content.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3v18"/><path d="M3 8h18"/><path d="M3 16h18"/></svg><p>No custom providers configured.</p></div>'; return }
  var html = '<div class="table-scroll"><table><thead><tr><th>Provider</th><th>Base URL</th><th>API Key</th><th>Models</th><th>Actions</th></tr></thead><tbody>'
  customProvidersData.forEach(function(provider) {
    var models = (provider.models || []).map(function(model) { var details = [model.kind]; if (model.aliases && model.aliases.length) details.push('aliases: ' + model.aliases.join(', ')); if (model.dimensions) details.push(model.dimensions + ' dims'); return '<div class="mono" style="font-size:12px;margin-bottom:4px">' + esc(model.id) + ' <span class="badge badge-blue">' + esc(details.join(' | ')) + '</span></div>' }).join('')
    var keySource = provider.apiKey ? 'Stored' : (provider.apiKeyEnv ? 'Env: ' + provider.apiKeyEnv : 'Missing')
    html += '<tr><td><div class="model-name">' + esc(provider.name) + '</div><div class="model-meta mono">' + esc(provider.id) + '</div></td><td class="mono" style="font-size:12px">' + esc(provider.baseUrl) + '</td><td class="mono" style="font-size:12px">' + esc(keySource) + '</td><td>' + models + '</td><td style="white-space:nowrap"><button class="btn" style="font-size:0.78rem;padding:4px 10px" onclick="editCustomProvider(&quot;' + esc(provider.id) + '&quot;)">Edit</button> <button class="btn btn-danger" style="font-size:0.78rem;padding:4px 10px" onclick="deleteCustomProvider(&quot;' + esc(provider.id) + '&quot;)">Delete</button></td></tr>'
  })
  html += '</tbody></table></div>'
  content.innerHTML = html
}
function parseJsonField(text, fallback) {
  var trimmed = text.trim()
  if (!trimmed) return fallback
  return JSON.parse(trimmed)
}
function customProviderFormBody() {
  var form = document.getElementById('custom-provider-form')
  var id = form.querySelector('input[name="cp-id"]').value.trim()
  var name = form.querySelector('input[name="cp-name"]').value.trim()
  var baseUrl = form.querySelector('input[name="cp-base-url"]').value.trim()
  var apiKey = form.querySelector('input[name="cp-api-key"]').value.trim()
  var timeoutRaw = form.querySelector('input[name="cp-timeout"]').value.trim()
  var headers = parseJsonField(form.querySelector('textarea[name="cp-headers"]').value, {})
  var models = parseJsonField(form.querySelector('textarea[name="cp-models"]').value, [])
  var body = { id: id, name: name, type: 'openai-compatible', baseUrl: baseUrl, apiKey: apiKey, headers: headers, models: models, passReasoningEffort: form.querySelector('input[name="cp-pass-reasoning"]').checked }
  if (timeoutRaw) body.timeoutMs = Number(timeoutRaw)
  return body
}
function saveCustomProvider() {
  var body
  try { body = customProviderFormBody() } catch(e) { showToast('Provider JSON is invalid', 'error'); return }
  if (!body.id || !body.name || !body.baseUrl || !body.apiKey) { showToast('Provider ID, name, base URL, and API key are required', 'error'); return }
  if (!Array.isArray(body.models) || body.models.length === 0) { showToast('Add at least one model', 'error'); return }
  apiFetch('POST', '/dashboard/api/custom-providers', body).then(function(r) { if (r.ok) { clearCustomProviderForm(); showToast('Provider saved', 'success'); loadCustomProviders(); return } r.json().catch(function() { return {} }).then(function(d) { showToast(d.error || 'Failed to save provider', 'error') }) }).catch(function() { showToast('Failed to save provider', 'error') })
}
function clearCustomProviderForm() {
  editingCustomProviderId = null
  document.getElementById('custom-provider-form-title').textContent = 'Add provider'
  var form = document.getElementById('custom-provider-form')
  form.querySelector('input[name="cp-id"]').value = ''
  form.querySelector('input[name="cp-id"]').disabled = false
  form.querySelector('input[name="cp-name"]').value = ''
  form.querySelector('input[name="cp-base-url"]').value = ''
  form.querySelector('input[name="cp-api-key"]').value = ''
  form.querySelector('input[name="cp-timeout"]').value = ''
  form.querySelector('input[name="cp-pass-reasoning"]').checked = false
  form.querySelector('textarea[name="cp-headers"]').value = '{}'
  form.querySelector('textarea[name="cp-models"]').value = '[{"id":"custom-chat-model","kind":"chat","supportsStreaming":true}]'
}
function editCustomProvider(id) {
  var provider = customProvidersData.find(function(item) { return item.id === id })
  if (!provider) return
  editingCustomProviderId = id
  document.getElementById('custom-provider-form-title').textContent = 'Edit provider'
  var form = document.getElementById('custom-provider-form')
  form.querySelector('input[name="cp-id"]').value = provider.id
  form.querySelector('input[name="cp-id"]').disabled = true
  form.querySelector('input[name="cp-name"]').value = provider.name || ''
  form.querySelector('input[name="cp-base-url"]').value = provider.baseUrl || ''
  form.querySelector('input[name="cp-api-key"]').value = provider.apiKey || ''
  form.querySelector('input[name="cp-timeout"]').value = provider.timeoutMs || ''
  form.querySelector('input[name="cp-pass-reasoning"]').checked = provider.passReasoningEffort === true
  form.querySelector('textarea[name="cp-headers"]').value = JSON.stringify(provider.headers || {}, null, 2)
  form.querySelector('textarea[name="cp-models"]').value = JSON.stringify(provider.models || [], null, 2)
}
function deleteCustomProvider(id) {
  if (!confirm('Delete custom provider ' + id + '?')) return
  apiFetch('DELETE', '/dashboard/api/custom-providers/' + encodeURIComponent(id)).then(function(r) { if (r.ok) { if (editingCustomProviderId === id) clearCustomProviderForm(); showToast('Provider deleted', 'success'); loadCustomProviders() } else showToast('Failed to delete provider', 'error') }).catch(function() { showToast('Failed to delete provider', 'error') })
}
function addNebiusProvider() {
  var apiKey = prompt('Nebius API key')
  if (!apiKey) return
  apiFetch('POST', '/dashboard/api/custom-providers/nebius-qwen3', { apiKey: apiKey }).then(function(r) { if (r.ok) { showToast('Nebius provider saved', 'success'); loadCustomProviders() } else r.json().catch(function() { return {} }).then(function(d) { showToast(d.error || 'Failed to add Nebius provider', 'error') }) }).catch(function() { showToast('Failed to add Nebius provider', 'error') })
}

function loadModelRouting() {
  apiFetch('GET', '/dashboard/api/model-routing').then(function(r) { if (r.ok) return r.json() }).then(function(d) { if (d) { modelRoutingData = d; renderModelRouting() } }).catch(function() { showToast('Failed to load model routing', 'error') })
}
function modelAccountState(model, accountId) {
  for (var i = 0; i < model.accounts.length; i++) {
    if (model.accounts[i].accountId === accountId) return model.accounts[i]
  }
  return null
}
function renderModelRouting() {
  var content = document.getElementById('model-routing-content')
  var count = document.getElementById('model-routing-count')
  var filterEl = document.getElementById('model-routing-filter')
  var query = filterEl ? filterEl.value.trim().toLowerCase() : ''
  var accounts = modelRoutingData.accounts || []
  var models = modelRoutingData.models || []
  if (count) count.textContent = models.length + ' models'
  if (!modelRoutingData.multiToken) { content.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2v20"/><path d="M2 12h20"/></svg><p>Model routing controls are available in multi-token mode.</p></div>'; return }
  if (accounts.length === 0 || models.length === 0) { content.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2v20"/><path d="M2 12h20"/></svg><p>No account model data is available yet.</p></div>'; return }
  var filtered = models.filter(function(model) { return !query || model.id.toLowerCase().indexOf(query) !== -1 || (model.name || '').toLowerCase().indexOf(query) !== -1 || (model.vendor || '').toLowerCase().indexOf(query) !== -1 })
  if (filtered.length === 0) { content.innerHTML = '<div class="empty-state"><p>No models match this filter.</p></div>'; return }
  var html = '<div class="table-scroll"><table><thead><tr><th>Model</th>'
  accounts.forEach(function(account) { html += '<th class="account-toggle-cell">Account #' + esc(account.id) + '<div class="model-meta">' + esc(account.accountType) + '</div></th>' })
  html += '</tr></thead><tbody>'
  filtered.forEach(function(model) {
    html += '<tr><td><div class="model-name mono">' + esc(model.id) + '</div><div class="model-meta">' + esc(model.name || model.vendor || '') + (model.preview ? ' <span class="badge badge-orange">preview</span>' : '') + '</div></td>'
    accounts.forEach(function(account) {
      var state = modelAccountState(model, account.id)
      if (!state) { html += '<td class="account-toggle-cell"><span class="badge badge-gray">unavailable</span></td>'; return }
      var disabled = !state.healthy ? ' disabled' : ''
      var title = state.healthy ? 'Toggle routing for this account' : 'Account is unhealthy'
      var modelIdArg = esc(JSON.stringify(model.id))
      html += '<td class="account-toggle-cell"><button title="' + title + '" class="toggle ' + (state.enabled ? 'on' : 'off') + (!state.healthy ? ' disabled' : '') + '"' + disabled + ' onclick="setModelRouting(' + modelIdArg + ',' + account.id + ',' + (!state.enabled) + ')"></button>'
      if (!state.healthy) html += '<div class="badge badge-orange">unhealthy</div>'
      else if (state.overridden) html += '<div class="badge badge-blue">custom</div>'
      html += '</td>'
    })
    html += '</tr>'
  })
  html += '</tbody></table></div>'
  content.innerHTML = html
}
function setModelRouting(modelId, accountId, enabled) {
  apiFetch('POST', '/dashboard/api/model-routing', { modelId: modelId, accountId: accountId, enabled: enabled }).then(function(r) {
    if (r.ok) { showToast('Routing updated', 'success'); loadModelRouting(); return }
    r.json().catch(function() { return {} }).then(function(d) { showToast(d.error || 'Failed to update routing', 'error') })
  }).catch(function() { showToast('Failed to update routing', 'error') })
}

function loadLlmDebugLogs() { refreshLlmDebugLogs(true); if (refreshTimers.llmDebug) return; refreshTimers.llmDebug = setInterval(function() { if (currentSection !== 'llm-debug') return; refreshLlmDebugLogs(false) }, 5000) }
function refreshLlmDebugLogs(showError) { apiFetch('GET', '/dashboard/api/llm-debug').then(function(r) { if (r.ok) return r.json() }).then(function(d) { if (d) { llmDebugData = d; renderLlmDebugLogs() } }).catch(function() { if (showError) showToast('Failed to load LLM debug logs', 'error') }) }
function formatBytes(n) { if (n == null) return '-'; if (n >= 1048576) return (n / 1048576).toFixed(1) + 'MB'; if (n >= 1024) return (n / 1024).toFixed(1) + 'KB'; return n + 'B' }
function formatDurationMs(n) { if (n == null) return '-'; return n >= 1000 ? (n / 1000).toFixed(1) + 's' : n + 'ms' }
function llmStatusBadge(e) { if (e.status === 'pending') return '<span class="badge badge-orange">pending</span>'; if (e.status === 'error' || (e.responseStatus && e.responseStatus >= 400)) return '<span class="badge badge-red">' + esc(e.responseStatus || 'error') + '</span>'; return '<span class="badge badge-green">' + esc(e.responseStatus || 'ok') + '</span>' }
function llmEntryMatches(e, q, s, p) { if (s !== 'all' && e.status !== s) return false; if (p !== 'all' && e.path !== p) return false; if (!q) return true; return [e.model, e.path, e.requestPreview, e.responsePreview, e.errorMessage, e.requestId, e.responseStatusText].join(' ').toLowerCase().indexOf(q) !== -1 }
function llmDebugEntrySignature(e) { return [e.id, e.status, e.responseStatus || '', e.responseStatusText || '', e.durationMs || '', e.requestBodyBytes || '', e.responseBodyBytes || '', e.errorMessage || '', e.requestPreview || '', e.responsePreview || ''].join('|') }
function llmDebugRenderSignature(entries, q, s, p) { var parts = [q, s, p, llmDebugData.count || 0]; entries.forEach(function(e) { parts.push(llmDebugEntrySignature(e)) }); return parts.join('||') }
function pruneLlmDebugUiState(entries) { var keep = {}; entries.forEach(function(e) { keep[e.id] = true }); var maps = [expandedLlmDebug, llmDebugDetails, llmDebugDetailLoading]; maps.forEach(function(map) { Object.keys(map).forEach(function(id) { if (!keep[id]) delete map[id] }) }); Object.keys(llmDebugPanelState).forEach(function(key) { if (!keep[key.split('|')[0]]) delete llmDebugPanelState[key] }); Object.keys(llmDebugPreScrollState).forEach(function(key) { if (!keep[key.split('|')[0]]) delete llmDebugPreScrollState[key] }) }
function llmDebugPanelKey(panel) { var card = panel ? panel.closest('.llm-log-card') : null; if (!card || !card.id) return ''; var summary = panel.querySelector('summary'); return card.id.replace('llm-log-', '') + '|' + (summary ? summary.textContent || '' : '') }
function captureLlmDebugViewState(container) { if (!container) return null; container.querySelectorAll('.llm-log-card .debug-panel').forEach(function(panel) { var key = llmDebugPanelKey(panel); if (key) llmDebugPanelState[key] = panel.open }); container.querySelectorAll('.llm-log-card .debug-pre').forEach(function(pre) { var key = llmDebugPanelKey(pre.closest('.debug-panel')); if (key) llmDebugPreScrollState[key] = { top: pre.scrollTop, left: pre.scrollLeft } }); return getLlmDebugViewportAnchor(container) }
function getLlmDebugViewportAnchor(container) { var cards = container ? container.querySelectorAll('.llm-log-card') : []; for (var i = 0; i < cards.length; i++) { var rect = cards[i].getBoundingClientRect(); if (rect.bottom > 0 && rect.top < window.innerHeight) return { id: cards[i].id, top: rect.top } } return null }
function restoreLlmDebugViewState(container, anchor) { if (!container) return; container.querySelectorAll('.llm-log-card .debug-panel').forEach(function(panel) { var key = llmDebugPanelKey(panel); if (key && Object.prototype.hasOwnProperty.call(llmDebugPanelState, key)) panel.open = llmDebugPanelState[key] }); container.querySelectorAll('.llm-log-card .debug-pre').forEach(function(pre) { var key = llmDebugPanelKey(pre.closest('.debug-panel')), pos = key ? llmDebugPreScrollState[key] : null; if (pos) { pre.scrollTop = pos.top; pre.scrollLeft = pos.left } }); if (anchor) { var el = document.getElementById(anchor.id); if (el) window.scrollBy(0, el.getBoundingClientRect().top - anchor.top) } }
function renderLlmDebugLogs(force) { var c = document.getElementById('llm-debug-content'), n = document.getElementById('llm-debug-count'), qEl = document.getElementById('llm-debug-filter'), sEl = document.getElementById('llm-debug-status'), pEl = document.getElementById('llm-debug-path'); var entries = llmDebugData.entries || [], q = qEl ? qEl.value.trim().toLowerCase() : '', s = sEl ? sEl.value : 'all', p = pEl ? pEl.value : 'all', filtered = entries.filter(function(e) { return llmEntryMatches(e, q, s, p) }), signature = llmDebugRenderSignature(filtered, q, s, p); if (n) n.textContent = filtered.length + ' of ' + (llmDebugData.count || 0) + ' calls'; pruneLlmDebugUiState(entries); if (!force && signature === llmDebugListSignature && c.firstChild) return; var anchor = captureLlmDebugViewState(c); llmDebugListSignature = signature; if (!entries.length) { c.innerHTML = '<div class="empty-state"><p>No LLM calls captured in the last 10 minutes.</p></div>'; return } if (!filtered.length) { c.innerHTML = '<div class="empty-state"><p>No debug logs match this filter.</p></div>'; return } var html = '<div class="llm-debug-list">'; filtered.forEach(function(e) { html += renderLlmDebugRow(e) }); c.innerHTML = html + '</div>'; restoreLlmDebugViewState(c, anchor) }
function renderLlmDebugRow(e) { var open = !!expandedLlmDebug[e.id], html = '<div class="llm-log-card' + (open ? ' open' : '') + '" id="llm-log-' + escAttr(e.id) + '">'; html += '<div class="llm-log-row"><div><div class="llm-log-path">' + esc(e.path) + '</div><div class="llm-log-meta"><span>' + timeAgo(e.startedAt) + '</span><span>' + formatDurationMs(e.durationMs) + '</span><span>' + formatBytes(e.requestBodyBytes) + ' req</span>' + (e.responseBodyBytes != null ? '<span>' + formatBytes(e.responseBodyBytes) + ' resp</span>' : '') + '</div></div>'; html += '<div class="llm-log-main"><div class="llm-log-title">' + llmStatusBadge(e) + '<span class="badge badge-blue">' + esc(e.method) + '</span>' + (e.stream ? '<span class="badge badge-purple">stream</span>' : '') + '<span class="llm-log-model mono">' + esc(e.model || 'unknown model') + '</span></div><div class="llm-log-preview" title="' + escAttr(e.requestPreview || '') + '">' + esc(e.requestPreview || e.errorMessage || 'No request body preview') + '</div></div>'; html += '<div class="llm-log-actions"><button class="btn" style="font-size:0.78rem;padding:5px 10px" onclick="toggleLlmDebugDetail(&quot;' + escAttr(e.id) + '&quot;)">' + (open ? 'Collapse' : 'Expand') + '</button></div></div>'; if (open) html += '<div class="llm-log-detail" id="llm-detail-' + escAttr(e.id) + '">' + renderLlmDebugDetail(e.id) + '</div>'; return html + '</div>' }
function toggleLlmDebugDetail(id) { expandedLlmDebug[id] = !expandedLlmDebug[id]; renderLlmDebugLogs(true); if (expandedLlmDebug[id] && !llmDebugDetails[id]) loadLlmDebugDetail(id) }
function loadLlmDebugDetail(id) { if (llmDebugDetailLoading[id]) return; llmDebugDetailLoading[id] = true; apiFetch('GET', '/dashboard/api/llm-debug/' + encodeURIComponent(id)).then(function(r) { if (r.ok) return r.json(); throw new Error('not found') }).then(function(d) { delete llmDebugDetailLoading[id]; llmDebugDetails[id] = d; var c = document.getElementById('llm-debug-content'), anchor = captureLlmDebugViewState(c), el = document.getElementById('llm-detail-' + id); if (el) { el.innerHTML = renderLlmDebugDetail(id); restoreLlmDebugViewState(c, anchor) } }).catch(function() { delete llmDebugDetailLoading[id]; showToast('Failed to load debug log', 'error') }) }
function renderHeaderTable(headers) { if (!headers || Object.keys(headers).length === 0) return '<div class="debug-empty">No headers</div>'; var html = '<div class="debug-kv">'; Object.keys(headers).sort().forEach(function(k) { html += '<div class="debug-kv-key">' + esc(k) + '</div><div class="debug-kv-val">' + esc(headers[k]) + '</div>' }); return html + '</div>' }
function prettyBody(body) { if (body == null || body === '') return ''; try { return JSON.stringify(JSON.parse(body), null, 2) } catch(e) { return body } }
function copyText(text) { if (!navigator.clipboard || !navigator.clipboard.writeText) { showToast('Clipboard is unavailable', 'error'); return } navigator.clipboard.writeText(text || '').then(function() { showToast('Copied', 'success') }).catch(function() { showToast('Copy failed', 'error') }) }
function bodyPanel(title, body, bytes) { var text = prettyBody(body); return '<details class="debug-panel" open><summary>' + esc(title) + '</summary><div class="debug-panel-body"><div class="debug-panel-head"><span>' + formatBytes(bytes || 0) + '</span><button class="btn" style="font-size:0.76rem;padding:4px 9px" onclick="copyText(llmPanelText(this))">Copy</button></div>' + (text ? '<pre class="debug-pre">' + esc(text) + '</pre>' : '<div class="debug-empty">Empty body</div>') + '</div></details>' }
function headersPanel(title, headers) { return '<details class="debug-panel"><summary>' + esc(title) + '</summary><div class="debug-panel-body"><div class="debug-panel-head"><span>' + Object.keys(headers || {}).length + ' headers</span><button class="btn" style="font-size:0.76rem;padding:4px 9px" onclick="copyText(llmPanelText(this))">Copy</button></div>' + renderHeaderTable(headers) + '</div></details>' }
function llmPanelText(button) { var panel = button.closest('.debug-panel'); if (!panel) return ''; var pre = panel.querySelector('pre'); if (pre) return pre.textContent || ''; var rows = []; panel.querySelectorAll('.debug-kv-key').forEach(function(k) { var v = k.nextElementSibling; rows.push((k.textContent || '') + ': ' + (v ? v.textContent || '' : '')) }); return rows.join(String.fromCharCode(10)) }
function renderLlmDebugDetail(id) { var d = llmDebugDetails[id]; if (!d) return '<div class="debug-empty">Loading full raw request and response...</div>'; var r = d.response, html = '<div class="debug-detail-grid"><details class="debug-panel full" open><summary>Call Metadata</summary><div class="debug-panel-body"><div class="debug-kv">'; var meta = { id: d.id, requestId: d.requestId || '', model: d.model || '', status: d.status, startedAt: d.startedAt, duration: formatDurationMs(d.durationMs), method: d.request.method, url: d.request.url, responseStatus: r ? r.status + ' ' + r.statusText : '' }; Object.keys(meta).forEach(function(k) { html += '<div class="debug-kv-key">' + esc(k) + '</div><div class="debug-kv-val">' + esc(meta[k]) + '</div>' }); html += '</div></div></details>' + bodyPanel('Request Body', d.request.body, d.request.bodyBytes) + bodyPanel('Response Body', r ? r.body : null, r ? r.bodyBytes : 0) + headersPanel('Request Headers', d.request.headers) + headersPanel('Response Headers', r ? r.headers : {}); if (d.error || (r && r.bodyReadError)) html += '<details class="debug-panel full" open><summary>Error</summary><div class="debug-panel-body"><pre class="debug-pre">' + esc(JSON.stringify(d.error || r.bodyReadError, null, 2)) + '</pre></div></details>'; return html + '</div>' }
function clearLlmDebugLogs() { if (!confirm('Clear in-memory LLM debug logs?')) return; apiFetch('DELETE', '/dashboard/api/llm-debug').then(function(r) { if (r.ok) { llmDebugData = { entries: [], count: 0, retentionMs: 600000 }; expandedLlmDebug = {}; llmDebugDetails = {}; llmDebugDetailLoading = {}; llmDebugPanelState = {}; llmDebugPreScrollState = {}; llmDebugListSignature = ''; renderLlmDebugLogs(true); showToast('Cleared', 'success') } else showToast('Failed to clear logs', 'error') }).catch(function() { showToast('Failed to clear logs', 'error') }) }

function loadUsage() { apiFetch('GET', '/dashboard/api/usage').then(function(r) { if (r.ok) return r.json() }).then(function(d) { if (d) renderUsage(d) }).catch(function() { showToast('Failed to load usage', 'error') }) }
function formatLabel(key) { return key.split('_').map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1) }).join(' ') }
function formatNumber(n) { if (n == null) return '-'; if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'; if (n >= 1000) return (n / 1000).toFixed(1) + 'K'; return String(n) }
function formatResetTime(ts) { if (!ts) return ''; var d = new Date(ts * 1000); var now = new Date(); var diff = d.getTime() - now.getTime(); if (diff <= 0) return 'now'; var h = Math.floor(diff / 3600000); var m = Math.floor((diff % 3600000) / 60000); if (h > 24) return Math.floor(h / 24) + 'd ' + (h % 24) + 'h'; if (h > 0) return h + 'h ' + m + 'm'; return m + 'm' }
function renderUsage(data) {
  if (!data || Object.keys(data).length === 0) { document.getElementById('usage-content').innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg><p>No usage data available.</p></div>'; return }
  var html = ''
  Object.keys(data).forEach(function(key) {
    var section = data[key]
    if (!section || typeof section !== 'object') return
    var sectionLabel = formatLabel(key)
    html += '<div style="margin-bottom:24px"><h3 style="font-size:1rem;color:#F8FAFC;margin-bottom:12px">' + esc(sectionLabel) + '</h3>'
    if (section.utilization != null) {
      var pct = Math.round(section.utilization * 100)
      var color = pct > 90 ? '#EF4444' : pct > 70 ? '#F97316' : '#22C55E'
      html += '<div class="stat-card blue" style="margin-bottom:10px"><div class="label">Utilization</div><div class="value">' + pct + '%</div><div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%;background:' + color + '"></div></div></div>'
    }
    html += '<div class="stat-grid">'
    if (section.tokens_used != null) html += '<div class="stat-card green"><div class="label">Tokens Used</div><div class="value">' + formatNumber(section.tokens_used) + '</div></div>'
    if (section.request_count != null) html += '<div class="stat-card blue"><div class="label">Requests</div><div class="value">' + formatNumber(section.request_count) + '</div></div>'
    if (section.resets_at) html += '<div class="stat-card orange"><div class="label">Resets In</div><div class="value">' + formatResetTime(section.resets_at) + '</div></div>'
    if (section.total_tokens != null) html += '<div class="stat-card green"><div class="label">Total Tokens</div><div class="value">' + formatNumber(section.total_tokens) + '</div></div>'
    if (section.total_input_tokens != null) html += '<div class="stat-card blue"><div class="label">Input Tokens</div><div class="value">' + formatNumber(section.total_input_tokens) + '</div></div>'
    if (section.total_output_tokens != null) html += '<div class="stat-card purple"><div class="label">Output Tokens</div><div class="value">' + formatNumber(section.total_output_tokens) + '</div></div>'
    if (section.total_requests != null) html += '<div class="stat-card blue"><div class="label">Total Requests</div><div class="value">' + formatNumber(section.total_requests) + '</div></div>'
    if (section.first_request_at) html += '<div class="stat-card orange"><div class="label">First Request</div><div class="value">' + timeAgo(section.first_request_at * 1000) + '</div></div>'
    html += '</div></div>'
  })
  document.getElementById('usage-content').innerHTML = html
}

function loadSettings() {
  Promise.all([
    apiFetch('GET', '/dashboard/api/settings').then(function(r) { if (r.ok) return r.json(); throw new Error('settings') }),
    apiFetch('GET', '/dashboard/api/ip-allowlist').then(function(r) { if (r.ok) return r.json(); throw new Error('ip-allowlist') })
  ]).then(function(results) {
    settingsData = results[0]
    ipAllowlistData = Array.isArray(results[1]) ? results[1] : []
    renderSettings(settingsData)
  }).catch(function() { showToast('Failed to load settings', 'error') })
}
function renderSettings(data) {
  var labels = { version:'Version', port:'Port', host:'Host', authEnabled:'API Key Configured', multiToken:'Multi-Token Mode', rateLimitSeconds:'Rate Limit (seconds)', sentryEnabled:'Sentry Enabled', groqEnabled:'Groq Enabled', dataDir:'Data Directory', debug:'Debug Mode', verbose:'Verbose Logging' }
  var skip = { codexCleanupModel:1, codexCleanupModelDefault:1, availableModels:1 }
  var html = '<div class="settings-grid">'
  Object.keys(data).forEach(function(key) {
    if (skip[key]) return
    var val = data[key], label = labels[key] || key, display
    if (typeof val === 'boolean') display = val ? '<span class="bool-yes">Yes</span>' : '<span class="bool-no">No</span>'
    else if (val == null) display = '<span style="color:#94A3B8">-</span>'
    else display = esc(String(val))
    html += '<div class="setting-row"><div class="setting-key">' + esc(label) + '</div><div class="setting-val">' + display + '</div></div>'
  })
  html += '</div>'

  var current = data.codexCleanupModel || ''
  var fallback = data.codexCleanupModelDefault || ''
  var models = Array.isArray(data.availableModels) ? data.availableModels : []
  var hasCurrentInList = current === '' || models.indexOf(current) !== -1
  var defaultOptionLabel = fallback ? 'Use default (' + fallback + ')' : 'Use default'
  html += '<div class="section-header" style="margin-top:24px"><h2>Codex Dictation Cleanup</h2><span class="badge badge-gray">Used by /codex/responses</span></div>'
  html += '<div class="settings-grid"><div class="setting-row"><div class="setting-key">Cleanup Model</div><div class="setting-val">'
  html += '<select class="form-input mono" id="codex-cleanup-model-select" style="min-width:280px">'
  html += '<option value="">' + esc(defaultOptionLabel) + '</option>'
  if (!hasCurrentInList) {
    html += '<option value="' + escAttr(current) + '" selected>' + esc(current) + ' (not in current model list)</option>'
  }
  models.forEach(function(id) {
    var sel = id === current ? ' selected' : ''
    html += '<option value="' + escAttr(id) + '"' + sel + '>' + esc(id) + '</option>'
  })
  html += '</select> '
  html += '<button class="btn btn-primary" onclick="saveCodexCleanupModel()" style="margin-left:8px">Save</button>'
  html += '</div></div></div>'

  html += renderIpAllowlistSection()

  document.getElementById('settings-content').innerHTML = html
}
function saveCodexCleanupModel() {
  var sel = document.getElementById('codex-cleanup-model-select')
  if (!sel) return
  var value = sel.value || null
  apiFetch('POST', '/dashboard/api/settings/codex-cleanup-model', { model: value }).then(function(r) {
    if (r.ok) { showToast('Cleanup model saved', 'success'); loadSettings() }
    else { r.json().then(function(e) { showToast('Save failed: ' + (e && e.error || r.status), 'error') }).catch(function() { showToast('Save failed: ' + r.status, 'error') }) }
  }).catch(function() { showToast('Save failed', 'error') })
}
function getExportFilename(response) {
  var disposition = response.headers.get('content-disposition') || ''
  var match = disposition.match(/filename="([^"]+)"/) || disposition.match(/filename=([^;]+)/)
  return match && match[1] ? match[1].trim() : 'copilot-api-config.zip'
}
function exportConfig() {
  apiFetch('GET', '/dashboard/api/settings/export').then(function(r) {
    if (!r.ok) throw new Error('export failed')
    var filename = getExportFilename(r)
    return r.blob().then(function(blob) { return { blob: blob, filename: filename } })
  }).then(function(result) {
    var url = URL.createObjectURL(result.blob)
    var link = document.createElement('a')
    link.href = url
    link.download = result.filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    showToast('Config export started', 'success')
  }).catch(function() { showToast('Failed to export config', 'error') })
}

function renderIpAllowlistSection() {
  var html = '<div class="section-header" style="margin-top:24px"><h2>IP Allowlist</h2><span class="badge badge-gray">Used by /transcribe</span><button class="btn" onclick="discoverPublicIps(true)">Detect public IPs</button></div>'
  html += '<div class="model-settings-panel"><div class="form-row" style="margin-top:0"><input class="form-input mono" id="ip-allowlist-input" placeholder="IPv4 or IPv6 address" style="flex:1;min-width:260px"><button class="btn btn-primary" onclick="addIpAllowlistEntry()">Add IP</button></div><div id="ip-allowlist-detected" style="margin-top:12px;color:#94A3B8;font-size:0.82rem"></div>'
  if (!ipAllowlistData.length) {
    html += '<div class="empty-state" style="padding:28px 16px"><p>No managed IPs yet.</p></div></div>'
    return html
  }
  html += '<div class="table-scroll"><table><thead><tr><th>IP Address</th><th>Status</th><th>Source</th><th>Last Seen</th><th>Actions</th></tr></thead><tbody>'
  ipAllowlistData.forEach(function(entry) {
    html += '<tr><td class="mono">' + esc(entry.ip) + '</td>'
    html += '<td>' + (entry.enabled ? '<span class="badge badge-green">enabled</span>' : '<span class="badge badge-red">disabled</span>') + '</td>'
    html += '<td>' + esc(entry.source || 'manual') + '</td>'
    html += '<td>' + (entry.lastSeenAt ? timeAgo(entry.lastSeenAt) : '-') + '</td>'
    html += '<td><button class="btn" style="font-size:0.78rem;padding:5px 10px" onclick="setIpAllowlistEnabled(&quot;' + escAttr(entry.ip) + '&quot;,' + (!entry.enabled) + ')">' + (entry.enabled ? 'Disable' : 'Enable') + '</button> <button class="btn btn-danger" style="font-size:0.78rem;padding:5px 10px" onclick="removeIpAllowlistEntry(&quot;' + escAttr(entry.ip) + '&quot;)">Remove</button></td></tr>'
  })
  html += '</tbody></table></div></div>'
  return html
}
function reloadIpAllowlist() {
  return apiFetch('GET', '/dashboard/api/ip-allowlist').then(function(r) {
    if (r.ok) return r.json()
    throw new Error('Failed')
}).then(function(d) {
    ipAllowlistData = Array.isArray(d) ? d : []
    renderSettingsIfOpen()
  })
}
function saveDetectedIp(ip, label) {
  if (!ip) return Promise.resolve(false)
  return apiFetch('POST', '/dashboard/api/ip-allowlist', { ip: ip, enabled: true }).then(function(r) {
    if (!r.ok) return false
    return true
  }).catch(function() { return false })
}
function fetchIpText(url) {
  return fetch(url, { cache: 'no-store' }).then(function(r) {
    if (!r.ok) throw new Error('failed')
    return r.text()
}).then(function(text) { return text.trim() })
}
function renderSettingsIfOpen() {
  if (currentSection === 'settings' && settingsData) renderSettings(settingsData)
}
function discoverPublicIps(showResult) {
  var sources = [
    { label: 'IPv4', url: 'https://api4.ipify.org' },
    { label: 'IPv6', url: 'https://api6.ipify.org' }
  ]
  return Promise.allSettled(sources.map(function(source) {
    return fetchIpText(source.url).then(function(ip) {
      return saveDetectedIp(ip, source.label).then(function(saved) {
        return { label: source.label, ip: ip, saved: saved }
      })
    })
  })).then(function(results) {
    var found = []
    results.forEach(function(result) {
      if (result.status === 'fulfilled' && result.value.ip) found.push(result.value)
    })
    var target = document.getElementById('ip-allowlist-detected')
    if (target) {
      target.textContent = found.length ? 'Detected ' + found.map(function(item) { return item.label + ' ' + item.ip }).join(', ') : 'No public IPs detected by the browser.'
    }
    if (found.length) {
      reloadIpAllowlist().catch(function(){})
      if (showResult) showToast('Detected IPs added', 'success')
    } else if (showResult) {
      showToast('No public IPs detected', 'error')
    }
  })
}
function addIpAllowlistEntry() {
  var input = document.getElementById('ip-allowlist-input')
  var ip = input ? input.value.trim() : ''
  if (!ip) { showToast('Enter an IP address', 'error'); return }
  apiFetch('POST', '/dashboard/api/ip-allowlist', { ip: ip, enabled: true }).then(function(r) {
    if (r.ok) { if (input) input.value = ''; showToast('IP added', 'success'); reloadIpAllowlist().catch(function() { showToast('Failed to refresh IP list', 'error') }); return }
    r.json().catch(function() { return {} }).then(function(d) { showToast(d.error || 'Failed to add IP', 'error') })
  }).catch(function() { showToast('Failed to add IP', 'error') })
}
function setIpAllowlistEnabled(ip, enabled) {
  apiFetch('PATCH', '/dashboard/api/ip-allowlist/' + encodeURIComponent(ip), { enabled: enabled }).then(function(r) {
    if (r.ok) { showToast(enabled ? 'IP enabled' : 'IP disabled', 'success'); reloadIpAllowlist().catch(function() { showToast('Failed to refresh IP list', 'error') }); return }
    r.json().catch(function() { return {} }).then(function(d) { showToast(d.error || 'Failed to update IP', 'error') })
  }).catch(function() { showToast('Failed to update IP', 'error') })
}
function removeIpAllowlistEntry(ip) {
  if (!confirm('Remove ' + ip + ' from the managed allowlist?')) return
  apiFetch('DELETE', '/dashboard/api/ip-allowlist/' + encodeURIComponent(ip)).then(function(r) {
    if (r.ok) { showToast('IP removed', 'success'); reloadIpAllowlist().catch(function() { showToast('Failed to refresh IP list', 'error') }); return }
    r.json().catch(function() { return {} }).then(function(d) { showToast(d.error || 'Failed to remove IP', 'error') })
  }).catch(function() { showToast('Failed to remove IP', 'error') })
}

document.getElementById('login-key').addEventListener('keydown', function(e) { if (e.key === 'Enter') doLogin() })
window.addEventListener('hashchange', function() { navigate(window.location.hash.slice(1) || 'overview') })
authenticate()
</script>
</body>
</html>`
}
