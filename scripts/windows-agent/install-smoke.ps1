param([Parameter(Mandatory=$true)][string]$Binary)
$ErrorActionPreference = 'Stop'
$Binary = (Resolve-Path -LiteralPath $Binary).Path
$installer = Join-Path $PSScriptRoot 'install.ps1'
$work = Join-Path ([IO.Path]::GetTempPath()) ('multicc-agent-install-' + [guid]::NewGuid().ToString('N'))
# Exercise both spaces and a quote in the shortcut's executable path.
$agentDir = Join-Path $work "user's agent files"
$startupDir = Join-Path $work 'Startup'
$exe = Join-Path $agentDir 'multicc-desktop-agent.exe'
$shortcut = Join-Path $startupDir 'MultiCC Desktop Agent.lnk'
$previousPipe = $env:MULTICC_AGENT_PIPE
$env:MULTICC_AGENT_PIPE = '\\.\pipe\multicc-install-test-' + [guid]::NewGuid().ToString('N')
function Check($condition, $name) {
    if (!$condition) { throw "FAIL: $name" }
    Write-Output "PASS: $name"
}
function InstalledProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name = 'multicc-desktop-agent.exe'" |
        Where-Object { $_.ExecutablePath -eq $exe })
}
function StopInstalled {
    InstalledProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
}
try {
    & $installer install -Binary $Binary -AgentDir $agentDir -StartupDir $startupDir
    Check ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $exe)) 'install creates a running binary'
    & $installer status -AgentDir $agentDir -StartupDir $startupDir
    Check ($LASTEXITCODE -eq 0) 'installed agent answers status'
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($shortcut)
    Check (Test-Path -LiteralPath $link.TargetPath) 'startup host exists for this PowerShell edition'
    Check ($link.WorkingDirectory -eq $agentDir) 'startup working directory preserves spaces and quotes'
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl = Get-Acl -LiteralPath $agentDir
    $rules = @($acl.Access)
    Check $acl.AreAccessRulesProtected 'install directory has a protected ACL'
    Check ($rules.Count -eq 1 -and $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid) 'only the current user can access the installed agent'
    StopInstalled
    $launcher = Start-Process -FilePath $link.TargetPath -ArgumentList $link.Arguments -PassThru -WindowStyle Hidden
    try {
        $ready = $false
        for ($i=0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 100
            $pong = $null
            try { $pong = & $exe ping 2>$null } catch { }
            if ($LASTEXITCODE -eq 0 -and $pong) { $ready=$true; break }
        }
        Check $ready 'the actual startup command launches the agent'
    } finally {
        StopInstalled
        if (!$launcher.HasExited) { Stop-Process -Id $launcher.Id -ErrorAction SilentlyContinue }
    }
    & $installer install -Binary $Binary -AgentDir $agentDir -StartupDir $startupDir
    Check ($LASTEXITCODE -eq 0) 'reinstall succeeds after startup launch'
    & $installer install -Binary $Binary -AgentDir $agentDir -StartupDir $startupDir
    Check ($LASTEXITCODE -eq 0 -and @(InstalledProcesses).Count -eq 1) 'reinstall replaces the old process'
    & $installer uninstall -AgentDir $agentDir -StartupDir $startupDir
    Check ($LASTEXITCODE -eq 0 -and !(Test-Path -LiteralPath $exe) -and !(Test-Path -LiteralPath $shortcut)) 'uninstall removes binary and startup shortcut'
    Check (@(InstalledProcesses).Count -eq 0) 'uninstall stops the installed process'
} finally {
    StopInstalled
    $env:MULTICC_AGENT_PIPE = $previousPipe
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
