[CmdletBinding()]
param(
  [string]$CodexHome,
  [string]$Email,
  [switch]$SkipClipboard
)

$ErrorActionPreference = 'Stop'

function ConvertTo-Base64Url([byte[]]$Bytes) {
  return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertTo-JsonBase64Url($Value) {
  $json = $Value | ConvertTo-Json -Depth 10 -Compress
  return ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($json))
}

function New-RandomBytes([int]$Length) {
  $bytes = New-Object byte[] $Length
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  }
  finally {
    $generator.Dispose()
  }
  return $bytes
}

function New-RandomBase64Url([int]$Length = 32) {
  return ConvertTo-Base64Url (New-RandomBytes $Length)
}

function Get-Sha256Hex([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
  }
  finally {
    $sha.Dispose()
  }
}

if ([string]::IsNullOrWhiteSpace($CodexHome)) {
  if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    throw 'Unable to determine the current user profile. Supply -CodexHome.'
  }
  $CodexHome = Join-Path $env:USERPROFILE '.codex'
}

$CodexHome = [IO.Path]::GetFullPath($CodexHome)

if ([string]::IsNullOrWhiteSpace($Email)) {
  $machineName = [string]$env:COMPUTERNAME
  $sanitizedMachineName = $machineName.ToLowerInvariant() -replace '[^a-z0-9]+', '-'
  $sanitizedMachineName = $sanitizedMachineName.Trim('-')
  if ([string]::IsNullOrWhiteSpace($sanitizedMachineName)) {
    $sanitizedMachineName = 'windows-pc'
  }
  $Email = "codex-$sanitizedMachineName@local.invalid"
}
else {
  $Email = $Email.Trim()
}

$userId = "local-dictation-$([Guid]::NewGuid().ToString('N'))"
$accountId = "local-dictation-$([Guid]::NewGuid().ToString('N'))"
$issuedAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

$header = [ordered]@{
  alg = 'none'
  typ = 'JWT'
}
$payload = [ordered]@{
  iss = 'https://auth.openai.com'
  aud = 'https://api.openai.com/v1'
  sub = $userId
  iat = $issuedAt
  email = $Email
  'https://api.openai.com/profile' = [ordered]@{
    email = $Email
  }
  'https://api.openai.com/auth' = [ordered]@{
    chatgpt_user_id = $userId
    chatgpt_plan_type = 'plus'
    chatgpt_account_id = $accountId
  }
}

$jwt = @(
  ConvertTo-JsonBase64Url $header
  ConvertTo-JsonBase64Url $payload
  New-RandomBase64Url 32
) -join '.'
$refreshToken = "local_$(New-RandomBase64Url 32)"
$digest = Get-Sha256Hex $jwt

$auth = [ordered]@{
  auth_mode = 'chatgpt'
  OPENAI_API_KEY = $null
  tokens = [ordered]@{
    id_token = $jwt
    access_token = $jwt
    refresh_token = $refreshToken
    account_id = $accountId
  }
  last_refresh = '2099-01-01T00:00:00Z'
}

[IO.Directory]::CreateDirectory($CodexHome) | Out-Null
$authPath = Join-Path $CodexHome 'auth.json'
$temporaryPath = Join-Path $CodexHome ".auth.json.$([Guid]::NewGuid().ToString('N')).tmp"
$backupPath = $null
$utf8NoBom = New-Object Text.UTF8Encoding($false)
$replacementObserverPath = [Environment]::GetEnvironmentVariable('CODEX_AUTH_TEST_REPLACEMENT_OBSERVER_PATH', 'Process')

try {
  $authJson = ($auth | ConvertTo-Json -Depth 10) + [Environment]::NewLine
  [IO.File]::WriteAllText($temporaryPath, $authJson, $utf8NoBom)

  if ([IO.File]::Exists($authPath)) {
    $backupRoot = Join-Path $CodexHome 'backups'
    [IO.Directory]::CreateDirectory($backupRoot) | Out-Null
    do {
      $timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
      $suffixBytes = New-RandomBytes 4
      $suffix = ([BitConverter]::ToString($suffixBytes)).Replace('-', '').ToLowerInvariant()
      $backupDirectory = Join-Path $backupRoot "codex-chatgpt-auth-$timestamp-$suffix"
    } while ([IO.Directory]::Exists($backupDirectory))

    [IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
    $backupPath = Join-Path $backupDirectory 'auth.json'
    if (-not [string]::IsNullOrWhiteSpace($replacementObserverPath)) {
      [IO.File]::WriteAllText($replacementObserverPath, $backupPath, $utf8NoBom)
    }
    [IO.File]::Replace($temporaryPath, $authPath, $backupPath)
  }
  else {
    [IO.File]::Move($temporaryPath, $authPath)
  }
}
finally {
  if ([IO.File]::Exists($temporaryPath)) {
    [IO.File]::Delete($temporaryPath)
  }
}

$clipboardStatus = 'Clipboard skipped. Copy the digest from the marker block.'
if (-not $SkipClipboard) {
  try {
    Set-Clipboard -Value $digest -ErrorAction Stop
    $clipboardStatus = 'Digest copied to the clipboard.'
  }
  catch {
    $clipboardStatus = 'Clipboard unavailable. Copy the digest from the marker block.'
  }
}

Write-Output "Auth path: $authPath"
if ($null -ne $backupPath) {
  Write-Output "Backup path: $backupPath"
}
Write-Output $clipboardStatus
Write-Output 'TRUSTED_JWT_SHA256_BEGIN'
Write-Output $digest
Write-Output 'TRUSTED_JWT_SHA256_END'
Write-Output 'Register only this SHA-256 digest at https://ai.ashesh.dev/dashboard#settings or send it to an administrator.'
Write-Output 'After registration, fully quit and reopen Codex Desktop.'
