$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskState = Join-Path $taskRoot 'state'
New-Item -ItemType Directory -Path $taskState -Force | Out-Null
Write-Host 'Aliyun Bailian TTS setup (Beijing region)'
Write-Host 'Paste the API Key here. Input is hidden. Do not send it in chat.'
$taskSecret = Read-Host 'DASHSCOPE_API_KEY' -AsSecureString
$taskPtr = [IntPtr]::Zero
try {
    $taskPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecret)
    $taskKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPtr).Trim()
    if (-not $taskKey -or $taskKey -match '\s') { throw 'API Key is empty or contains whitespace.' }
    $taskWorkspace = (Read-Host 'Beijing Workspace ID').Trim()
    if ($taskWorkspace -notmatch '^[a-zA-Z0-9-]{1,80}$') { throw 'Invalid Workspace ID.' }
    $taskPath = Join-Path $taskState 'tts-secrets.json'
    if (-not (Test-Path -LiteralPath $taskPath)) {
        [IO.File]::WriteAllText($taskPath, '{}', [Text.UTF8Encoding]::new($false))
    }
    $taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $taskPath /inheritance:r /grant:r "*$($taskSid):F" /grant:r '*S-1-5-18:F' /grant:r '*S-1-5-32-544:F' /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect credentials file. Key was not saved.' }
    $taskData = @{ apiKey = $taskKey; workspaceId = $taskWorkspace } | ConvertTo-Json
    [IO.File]::WriteAllText($taskPath, $taskData, [Text.UTF8Encoding]::new($false))
    Write-Host 'Saved locally. No API call or audio upload was made.' -ForegroundColor Green
    Write-Host 'Voice cloning and preview are the next steps; group TTS remains disabled.'
} finally {
    if ($taskPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPtr) }
    $taskKey = $null
    $taskData = $null
    $taskSecret.Dispose()
}
