param(
    [ValidateSet('install','status','uninstall')][string]$Action = 'status',
    [string]$Binary = '',
    [string]$AgentDir = (Join-Path $env:USERPROFILE '.multicc\agent\windows'),
    [string]$StartupDir = [Environment]::GetFolderPath('Startup')
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This installer requires Windows.' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$AgentDir = [IO.Path]::GetFullPath($AgentDir)
$StartupDir = [IO.Path]::GetFullPath($StartupDir)
$exe = Join-Path $AgentDir 'multicc-desktop-agent.exe'
$shortcut = Join-Path $StartupDir 'MultiCC Desktop Agent.lnk'

function Stop-Agent {
    # Only stop the binary installed in this directory, never another user's/debug agent.
    Get-CimInstance Win32_Process -Filter "Name = 'multicc-desktop-agent.exe'" |
        Where-Object { $_.ExecutablePath -eq $exe } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
}

if ($Action -eq 'uninstall') {
    Stop-Agent
    Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
    Write-Output 'Desktop agent removed. No Windows service was installed.'
    exit 0
}
if ($Action -eq 'status') {
    if (!(Test-Path -LiteralPath $exe)) { Write-Output 'Desktop agent is not installed.'; exit 1 }
    & $exe status
    exit $LASTEXITCODE
}

if (!$Binary) {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $prebuilt = Join-Path $repo "native\prebuilt\win32-$arch\multicc-desktop-agent.exe"
    if (Test-Path -LiteralPath $prebuilt) { $Binary = $prebuilt }
    else {
        if (!(Get-Command cargo -ErrorAction SilentlyContinue)) {
            throw 'No prebuilt Windows agent found. Install Rust with MSVC build tools, or pass -Binary <trusted multicc-desktop-agent.exe>.'
        }
        $buildDir = Join-Path $env:LOCALAPPDATA 'MultiCC\build\desktop-agent'
        & cargo build --locked --release --manifest-path (Join-Path $repo 'native\Cargo.toml') -p multicc-desktop-agent --target-dir $buildDir
        if ($LASTEXITCODE -ne 0) { throw 'Desktop agent build failed.' }
        $Binary = Join-Path $buildDir 'release\multicc-desktop-agent.exe'
    }
}
$Binary = (Resolve-Path -LiteralPath $Binary).Path
$version = & $Binary --version
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^multicc-desktop-agent \d') { throw 'Invalid desktop agent binary.' }
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $AgentDir -AclObject $acl
$temporary = Join-Path $AgentDir 'multicc-desktop-agent.new.exe'
Copy-Item -LiteralPath $Binary -Destination $temporary -Force
Stop-Agent
Move-Item -LiteralPath $temporary -Destination $exe -Force

# A per-user Startup shortcut inherits that user's interactive desktop and environment.
# PowerShell 7's $PSHOME contains pwsh.exe, not powershell.exe. Use the Windows
# inbox host so the shortcut also survives a later PowerShell 7 upgrade/removal.
$startupHost = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
if (!(Test-Path -LiteralPath $startupHost)) { throw 'Windows PowerShell startup host is missing.' }
New-Item -ItemType Directory -Force -Path $StartupDir | Out-Null
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
$link.TargetPath = $startupHost
$quotedExe = $exe.Replace("'", "''")
$link.Arguments = "-NoProfile -WindowStyle Hidden -Command `"& '$quotedExe' serve`""
$link.WorkingDirectory = $AgentDir
$link.WindowStyle = 7
$link.Description = 'MultiCC desktop agent for the signed-in Windows user'
$link.Save()
$process = Start-Process -FilePath $exe -ArgumentList 'serve' -WindowStyle Hidden -PassThru
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 100
    if ($process.HasExited) { throw 'Agent exited before becoming ready. Check whether another agent owns its pipe.' }
    # Windows PowerShell can turn redirected native stderr into a terminating
    # NativeCommandError. A not-yet-created pipe is expected during startup.
    $pong = $null
    try { $pong = & $exe ping 2>$null } catch { }
    if ($LASTEXITCODE -eq 0 -and $pong) {
        Write-Output "Installed $version at $exe"
        Write-Output 'Agent is running and will start at the next user login.'
        exit 0
    }
}
throw 'Agent installed but did not answer ping.'
