# MultiCC Windows one-click installer (standalone package)
# MultiCC version 2.1.0

[CmdletBinding()]
param(
    [string]$InstallDir = '',
    [string]$Version = '',
    [string]$AccessToken = '',
    [ValidateRange(1, 65535)]
    [int]$Port = 3000,
    [string]$From = '',
    [switch]$NoService,
    [switch]$NoStart,
    [switch]$NoOpen
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# Keep this in sync with package.json when cutting a release. The stable raw
# URL and the release asset are intentionally pinned to the same immutable tag.
$InstallerVersion = '2.1.0'
$Repository = 'lsjwzh/MultiCC'
$ReleasesUrl = "https://github.com/$Repository/releases"
$LatestApi = "https://api.github.com/repos/$Repository/releases/latest"

function Write-Step([string]$Text) { Write-Host "`n>> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "[OK] $Text" -ForegroundColor Green }
function Write-Info([string]$Text) { Write-Host "[i] $Text" -ForegroundColor Blue }
function Write-Warn([string]$Text) { Write-Host "[!] $Text" -ForegroundColor Yellow }

function Get-RandomToken {
    $bytes = New-Object byte[] 24
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Get-ReleaseVersion([string]$Requested) {
    if ([string]::IsNullOrWhiteSpace($Requested)) { return $InstallerVersion }
    if ($Requested -eq 'latest') {
        $release = Invoke-RestMethod -UseBasicParsing -Headers @{
            Accept = 'application/vnd.github+json'
            'User-Agent' = 'MultiCC-standalone-installer'
        } -Uri $LatestApi
        $resolved = [string]$release.tag_name
    } else {
        $resolved = $Requested
    }
    $resolved = $resolved -replace '^v', ''
    if ($resolved -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
        throw "Invalid release version: $resolved"
    }
    return $resolved
}

function Get-Archive([string]$Source, [string]$Archive, [string]$Checksum) {
    if ([string]::IsNullOrWhiteSpace($Source)) {
        $asset = Split-Path -Leaf $Archive
        $base = "$ReleasesUrl/download/v$script:ResolvedVersion/$asset"
        Invoke-WebRequest -UseBasicParsing -Uri $base -OutFile $Archive
        Invoke-WebRequest -UseBasicParsing -Uri "$base.sha256" -OutFile $Checksum
        return
    }
    if ($Source -match '^https?://') {
        Invoke-WebRequest -UseBasicParsing -Uri $Source -OutFile $Archive
        Invoke-WebRequest -UseBasicParsing -Uri "$Source.sha256" -OutFile $Checksum
        return
    }
    $local = [IO.Path]::GetFullPath($Source)
    if (Test-Path -LiteralPath $local -PathType Container) {
        $script:SourceDirectory = $local
        return
    }
    if (-not (Test-Path -LiteralPath $local -PathType Leaf)) {
        throw "--From path does not exist: $local"
    }
    $sidecar = "$local.sha256"
    if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) {
        throw "Local archive requires its checksum sidecar: $sidecar"
    }
    Copy-Item -LiteralPath $local -Destination $Archive
    Copy-Item -LiteralPath $sidecar -Destination $Checksum
}

function Confirm-Checksum([string]$Archive, [string]$Checksum) {
    $line = (Get-Content -LiteralPath $Checksum -Raw).Trim()
    $expected = ($line -split '\s+')[0].ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$') { throw 'Published checksum is not a SHA-256 digest.' }
    $actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "Checksum mismatch: expected $expected, got $actual" }
}

function Test-StandaloneInstall([string]$Root) {
    return (Test-Path -LiteralPath (Join-Path $Root 'multicc.cmd') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Root 'Resources\bundle-manifest.json') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Root 'Resources\runtime\node.exe') -PathType Leaf)
}

function Assert-Bundle([string]$Root) {
    foreach ($relative in @(
        'multicc.cmd',
        'Resources\bundle-manifest.json',
        'Resources\runtime\node.exe',
        'Resources\launcher\standalone-cli.js',
        'Resources\app-server\server.js'
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf)) {
            throw "Standalone package is incomplete: missing $relative"
        }
    }
    $manifest = Get-Content -LiteralPath (Join-Path $Root 'Resources\bundle-manifest.json') -Raw | ConvertFrom-Json
    if ([string]$manifest.version -ne $script:ResolvedVersion) {
        throw "Package version $($manifest.version) does not match requested $script:ResolvedVersion"
    }
    if ([string]$manifest.platform -ne 'win32' -or [string]$manifest.arch -ne 'x64') {
        throw "Package target is $($manifest.platform)/$($manifest.arch), expected win32/x64"
    }
}

function Invoke-MultiCC([string[]]$Arguments, [switch]$IgnoreFailure) {
    & $script:MultiCCCommand @Arguments
    $code = $LASTEXITCODE
    if ($code -ne 0 -and -not $IgnoreFailure) {
        throw "multicc.cmd $($Arguments -join ' ') failed with exit code $code"
    }
    return $code
}

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    $InstallDir = Join-Path $env:USERPROFILE 'MultiCC'
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$ResolvedVersion = Get-ReleaseVersion $Version
$asset = "multicc-standalone-$ResolvedVersion-win32-x64.zip"
$work = Join-Path ([IO.Path]::GetTempPath()) ("multicc-install-" + [Guid]::NewGuid().ToString('N'))
$archive = Join-Path $work $asset
$checksum = "$archive.sha256"
$extract = Join-Path $work 'extract'
$staged = Join-Path $work 'staged'
$SourceDirectory = ''
$oldDir = ''

Write-Host ''
Write-Host "MultiCC Windows One-Click Installer (v$ResolvedVersion)" -ForegroundColor Magenta
Write-Host 'No Node, npm, git, Visual Studio or administrator access required.'

try {
    New-Item -ItemType Directory -Path $work | Out-Null
    Write-Step 'Downloading and verifying the standalone package'
    Get-Archive $From $archive $checksum
    if ([string]::IsNullOrWhiteSpace($SourceDirectory)) {
        Confirm-Checksum $archive $checksum
        Write-Ok 'SHA-256 verified'
        New-Item -ItemType Directory -Path $extract | Out-Null
        Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
        $entries = @(Get-ChildItem -LiteralPath $extract -Force)
        if ($entries.Count -ne 1 -or -not $entries[0].PSIsContainer) {
            throw 'Archive must contain exactly one top-level bundle directory.'
        }
        Move-Item -LiteralPath $entries[0].FullName -Destination $staged
    } else {
        Copy-Item -LiteralPath $SourceDirectory -Destination $staged -Recurse
    }
    Assert-Bundle $staged

    Write-Step 'Installing'
    $parent = Split-Path -Parent $InstallDir
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    if (Test-Path -LiteralPath $InstallDir) {
        $children = @(Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue)
        if ($children.Count -gt 0 -and -not (Test-StandaloneInstall $InstallDir)) {
            throw "$InstallDir is not empty and does not look like a MultiCC standalone installation. Nothing was changed."
        }
        if ($children.Count -gt 0) {
            Write-Info 'Existing standalone installation found; stopping it before replacement.'
            $existingCommand = Join-Path $InstallDir 'multicc.cmd'
            & $existingCommand stop 2>$null | Out-Null
            $oldDir = "$InstallDir.old-$PID"
            Move-Item -LiteralPath $InstallDir -Destination $oldDir
        } else {
            Remove-Item -LiteralPath $InstallDir -Force
        }
    }
    try {
        Move-Item -LiteralPath $staged -Destination $InstallDir
    } catch {
        if (-not [string]::IsNullOrWhiteSpace($oldDir) -and (Test-Path -LiteralPath $oldDir)) {
            Move-Item -LiteralPath $oldDir -Destination $InstallDir
            Write-Warn 'The previous installation was restored.'
        }
        throw
    }
    if (-not [string]::IsNullOrWhiteSpace($oldDir) -and (Test-Path -LiteralPath $oldDir)) {
        Remove-Item -LiteralPath $oldDir -Recurse -Force
    }
    $MultiCCCommand = Join-Path $InstallDir 'multicc.cmd'
    Write-Ok "Installed MultiCC $ResolvedVersion at $InstallDir"

    Write-Step 'Configuring'
    if (-not [string]::IsNullOrWhiteSpace($AccessToken)) {
        Invoke-MultiCC @('config', 'set', 'ACCESS_TOKEN', $AccessToken) | Out-Null
        Write-Ok 'ACCESS_TOKEN saved'
    } else {
        $existingToken = (& $MultiCCCommand config get ACCESS_TOKEN 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($existingToken)) {
            $AccessToken = $existingToken
            Write-Info 'Keeping the existing ACCESS_TOKEN'
        } else {
            $AccessToken = Get-RandomToken
            Invoke-MultiCC @('config', 'set', 'ACCESS_TOKEN', $AccessToken) | Out-Null
            Write-Ok 'ACCESS_TOKEN generated'
        }
    }
    Invoke-MultiCC @('config', 'set', 'PORT', [string]$Port) | Out-Null
    Write-Ok "PORT set to $Port"

    if ($NoStart) { $NoService = $true }
    if (-not $NoService) {
        Write-Step 'Start automatically on login'
        $answer = Read-Host 'Set that up now? [Y/n]'
        if ([string]::IsNullOrWhiteSpace($answer) -or $answer -match '^[Yy]') {
            if ((Invoke-MultiCC @('service', 'install') -IgnoreFailure) -eq 0) {
                Write-Ok 'Auto-start installed'
            } else {
                Write-Warn 'Auto-start setup failed; you can retry with multicc.cmd service install.'
            }
        }
    }

    if (-not $NoStart) {
        Write-Step 'Starting MultiCC'
        $startArgs = @('start')
        if ($NoOpen) { $startArgs += '--no-open' }
        Invoke-MultiCC $startArgs | Out-Null
        $actualUrl = (& $MultiCCCommand url 2>$null | Out-String).Trim()
        Write-Ok "MultiCC is ready at $actualUrl"
    } else {
        Write-Info 'Installed without starting (-NoStart)'
    }

    Write-Host ''
    Write-Host 'Installation Complete!' -ForegroundColor Green
    Write-Host "  Install: $InstallDir"
    Write-Host "  Status:  & '$MultiCCCommand' status"
    Write-Host '  Data and configuration live outside the install directory and survive upgrades.'
} catch {
    Write-Error $_
    exit 1
} finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
