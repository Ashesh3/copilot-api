[CmdletBinding()]
param(
  [string]$CodexHome,
  [string]$Email,
  [string]$FullName,
  [switch]$PromptForIdentity,
  [switch]$SkipWindowsIdentityDiscovery,
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

function Get-DefaultEmail([string]$MachineName) {
  $sanitizedMachineName = $MachineName.ToLowerInvariant() -replace '[^a-z0-9]+', '-'
  $sanitizedMachineName = $sanitizedMachineName.Trim('-')
  if ([string]::IsNullOrWhiteSpace($sanitizedMachineName)) {
    $sanitizedMachineName = 'windows-pc'
  }
  return "codex-$sanitizedMachineName@local.invalid"
}

function Test-EmailAddress([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $false
  }
  try {
    $address = New-Object Net.Mail.MailAddress($Value.Trim())
    return $address.Address -eq $Value.Trim()
  }
  catch {
    return $false
  }
}

function ConvertTo-FriendlyName([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }
  $words = @($Value.Trim() -split '[._\-\s]+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($words.Count -eq 0) {
    return $null
  }
  $culture = [Globalization.CultureInfo]::CurrentCulture
  return ($words | ForEach-Object { $culture.TextInfo.ToTitleCase($_.ToLower($culture)) }) -join ' '
}

function Get-WindowsIdentity {
  $identity = [ordered]@{
    FullName = $null
    Email = $null
    UserName = [string][Environment]::UserName
  }

  if ($SkipWindowsIdentityDiscovery) {
    return $identity
  }

  try {
    Add-Type -AssemblyName System.DirectoryServices.AccountManagement -ErrorAction Stop
    $principal = [System.DirectoryServices.AccountManagement.UserPrincipal]::Current
    if ($null -ne $principal) {
      if (-not [string]::IsNullOrWhiteSpace($principal.DisplayName)) {
        $identity.FullName = $principal.DisplayName.Trim()
      }
      if (Test-EmailAddress ([string]$principal.EmailAddress)) {
        $identity.Email = $principal.EmailAddress.Trim()
      }
      elseif (Test-EmailAddress ([string]$principal.UserPrincipalName)) {
        $identity.Email = $principal.UserPrincipalName.Trim()
      }
      if (-not [string]::IsNullOrWhiteSpace($principal.SamAccountName)) {
        $identity.UserName = $principal.SamAccountName.Trim()
      }
    }
  }
  catch {
    # Continue through Windows-local discovery fallbacks.
  }

  if ([string]::IsNullOrWhiteSpace($identity.FullName)) {
    try {
      $localUserCommand = Get-Command Get-LocalUser -ErrorAction SilentlyContinue
      if ($null -ne $localUserCommand -and -not [string]::IsNullOrWhiteSpace($identity.UserName)) {
        $localUser = Get-LocalUser -Name $identity.UserName -ErrorAction Stop
        if (-not [string]::IsNullOrWhiteSpace($localUser.FullName)) {
          $identity.FullName = $localUser.FullName.Trim()
        }
      }
    }
    catch {
      # Windows PowerShell editions without LocalAccounts continue to CIM.
    }
  }

  if ([string]::IsNullOrWhiteSpace($identity.FullName) -and -not [string]::IsNullOrWhiteSpace($identity.UserName)) {
    try {
      $escapedUserName = $identity.UserName.Replace("'", "''")
      $account = Get-CimInstance Win32_UserAccount -Filter "Name='$escapedUserName'" -ErrorAction Stop |
        Where-Object { $_.LocalAccount } |
        Select-Object -First 1
      if ($null -ne $account -and -not [string]::IsNullOrWhiteSpace($account.FullName)) {
        $identity.FullName = $account.FullName.Trim()
      }
    }
    catch {
      # A friendly username fallback is still available below.
    }
  }

  if ([string]::IsNullOrWhiteSpace($identity.Email)) {
    try {
      $upn = (& whoami.exe /upn 2>$null | Out-String).Trim()
      if (Test-EmailAddress $upn) {
        $identity.Email = $upn
      }
    }
    catch {
      # Local accounts commonly have no UPN.
    }
  }

  if ([string]::IsNullOrWhiteSpace($identity.FullName)) {
    $identity.FullName = ConvertTo-FriendlyName $identity.UserName
  }
  return $identity
}

function Get-FriendlyUserId(
  [string]$SelectedEmail,
  [string]$SelectedFullName,
  [string]$WindowsUserName,
  [bool]$HasUserEmail,
  [bool]$UsedFallbackIdentity
) {
  if ($UsedFallbackIdentity) {
    return 'copilot-api'
  }

  $candidate = $null
  if ($HasUserEmail -and (Test-EmailAddress $SelectedEmail)) {
    $candidate = $SelectedEmail.Substring(0, $SelectedEmail.LastIndexOf('@'))
  }
  if ([string]::IsNullOrWhiteSpace($candidate)) {
    $candidate = $SelectedFullName
  }
  if ([string]::IsNullOrWhiteSpace($candidate)) {
    $candidate = $WindowsUserName
  }

  $userId = ([string]$candidate).ToLowerInvariant() -replace '[^a-z0-9._-]+', '-'
  $userId = ($userId -replace '-{2,}', '-').Trim([char[]]'._-')
  if ([string]::IsNullOrWhiteSpace($userId)) {
    return 'copilot-api'
  }
  return $userId
}

function Test-NonInteractivePowerShell {
  $commandLineArguments = [Environment]::GetCommandLineArgs()
  foreach ($argument in $commandLineArguments) {
    if ($argument -match '^(?i)-noni(?:n(?:t(?:e(?:r(?:a(?:c(?:t(?:i(?:v(?:e)?)?)?)?)?)?)?)?)?)?$') {
      return $true
    }
  }
  return $false
}

if ([string]::IsNullOrWhiteSpace($CodexHome)) {
  if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    throw 'Unable to determine the current user profile. Supply -CodexHome.'
  }
  $CodexHome = Join-Path $env:USERPROFILE '.codex'
}

$CodexHome = [IO.Path]::GetFullPath($CodexHome)

$machineName = [string]$env:COMPUTERNAME
$defaultEmail = Get-DefaultEmail $machineName
if ([string]::IsNullOrWhiteSpace($FullName) -and -not [string]::IsNullOrWhiteSpace($env:CODEX_AUTH_FULL_NAME)) {
  $FullName = $env:CODEX_AUTH_FULL_NAME
}
if ([string]::IsNullOrWhiteSpace($Email) -and -not [string]::IsNullOrWhiteSpace($env:CODEX_AUTH_EMAIL)) {
  $Email = $env:CODEX_AUTH_EMAIL
}
$windowsIdentity = [ordered]@{
  FullName = $null
  Email = $null
  UserName = [string][Environment]::UserName
}
if ([string]::IsNullOrWhiteSpace($FullName) -or [string]::IsNullOrWhiteSpace($Email)) {
  $windowsIdentity = Get-WindowsIdentity
  if ([string]::IsNullOrWhiteSpace($FullName)) {
    $FullName = $windowsIdentity.FullName
  }
  if ([string]::IsNullOrWhiteSpace($Email)) {
    $Email = $windowsIdentity.Email
  }
}

if (-not [string]::IsNullOrWhiteSpace($FullName)) {
  $FullName = $FullName.Trim()
}
if (-not [string]::IsNullOrWhiteSpace($Email)) {
  $Email = $Email.Trim()
}

$canPrompt = -not (Test-NonInteractivePowerShell) -and ($PromptForIdentity -or -not [Console]::IsInputRedirected)
if ($canPrompt -and [string]::IsNullOrWhiteSpace($FullName)) {
  $enteredFullName = Read-Host 'Full name [copilot-api]'
  if (-not [string]::IsNullOrWhiteSpace($enteredFullName)) {
    $FullName = $enteredFullName.Trim()
  }
}
if ($canPrompt -and [string]::IsNullOrWhiteSpace($Email)) {
  $enteredEmail = Read-Host "Email [$defaultEmail]"
  if (-not [string]::IsNullOrWhiteSpace($enteredEmail)) {
    $Email = $enteredEmail.Trim()
  }
}

$usedFallbackIdentity = [string]::IsNullOrWhiteSpace($FullName) -and [string]::IsNullOrWhiteSpace($Email)
$hasUserEmail = -not [string]::IsNullOrWhiteSpace($Email)
if ([string]::IsNullOrWhiteSpace($FullName)) {
  $FullName = 'copilot-api'
}
if ([string]::IsNullOrWhiteSpace($Email)) {
  $Email = $defaultEmail
}
if (-not (Test-EmailAddress $Email)) {
  throw 'Email must be a valid email address.'
}

$userId = Get-FriendlyUserId $Email $FullName $windowsIdentity.UserName $hasUserEmail $usedFallbackIdentity
$accountId = $userId
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
    name = $FullName
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
$refreshToken = "local_codex_v1.$(ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($jwt)))"
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
