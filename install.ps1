# MultiCC Windows one-click installer (standalone package)
# MultiCC version 2.1.3

[CmdletBinding()]
param(
    [string]$InstallDir = '',
    [string]$Version = '',
    [string]$AccessToken = '',
    [ValidateRange(1, 65535)]
    [int]$Port = 3000,
    [string]$From = '',
    [string]$AdoptData = '',
    [switch]$Yes,
    [switch]$NoData,
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
$InstallerVersion = '2.1.3'
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

# An installation from before the standalone package. Windows never had a
# source-checkout installer of its own, but the old POSIX installer was
# documented for Git Bash and MSYS, and a user who ran it has a checkout at
# this path with a `multicc` shell script in it - a real installation that the
# check above refuses. Refusing it would strand that user on the old version;
# the directory is upgraded instead, and kept as a backup. Identity is checked,
# not just file names, so a directory that merely holds a file called `multicc`
# is still refused.
function Test-LegacyInstall([string]$Root) {
    if (Test-StandaloneInstall $Root) { return $false }
    $launcher = (Test-Path -LiteralPath (Join-Path $Root 'multicc.cmd') -PathType Leaf) -or
        (Test-Path -LiteralPath (Join-Path $Root 'multicc') -PathType Leaf)
    if (-not $launcher) { return $false }
    if (Test-Path -LiteralPath (Join-Path $Root 'Resources\bundle-manifest.json') -PathType Leaf) { return $true }
    $package = Join-Path $Root 'package.json'
    if (Test-Path -LiteralPath $package -PathType Leaf) {
        try {
            $name = [string](Get-Content -LiteralPath $package -Raw | ConvertFrom-Json).name
            if ($name -eq 'multicc') { return $true }
        } catch {
            # An unreadable package.json is not evidence of anything.
        }
    }
    return (Test-Path -LiteralPath (Join-Path $Root 'Resources\runtime') -PathType Container)
}

# The ACCESS_TOKEN and PORT the old installation was configured with. The old
# installer wrote them into the install directory's own .env, and the user's
# bookmarks, phone and other devices already carry that token - generating a
# fresh one would silently lock them all out.
function Read-LegacyEnv([string]$Root) {
    $envFile = Join-Path $Root '.env'
    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { return }
    foreach ($line in (Get-Content -LiteralPath $envFile -ErrorAction SilentlyContinue)) {
        if ($line -match '^ACCESS_TOKEN=(.*)$') { $script:legacyToken = $Matches[1].Trim() }
        elseif ($line -match '^PORT=(.*)$') { $script:legacyPort = $Matches[1].Trim() }
    }
}

# Every state artifact a pre-standalone installation kept inside its own
# directory: for those releases src/paths.js resolved the data root to the
# package root, so this is what sat next to the code. The list is by name on
# purpose - the same directory also held the sources, node_modules and .git, and
# none of that is data. Anything absent is rebuilt on demand (caches) or already
# lived under ~/.multicc even then (detached jobs, voice runtimes, samples).
$script:LegacyDataItems = @(
    'sessions.json', 'directories.json', '.journal', 'chat_history',
    'aux_runs', 'events', 'bridges', 'artifacts',
    'notes.json', 'token_usage.json', 'token_daily.json', 'token_by_role.json',
    'providers.json', 'shares.json', 'fleet-shares.json', 'external-fleets.json',
    'push_subscriptions.json', 'push_notification_receipts.json',
    'tunnel-config.json', 'tunnel-repair-ledger.json', 'aux-config.json', 'goal-config.json',
    'provider-defaults.json', 'provider-relay-shares.json',
    'provider-limit-cache.db', 'provider-limit-cache.json', 'quota-bar-cache.json',
    'scheduled_tasks.json', 'cron_fanout_migration.json', 'docs_registry.json', 'secrets.json',
    'task_board.json', 'task-runs.sqlite', 'task-shells.sqlite', 'search-index.sqlite',
    'task-short-codes.json', 'ui-layout.json', 'air-pins.json',
    'orchestration.sqlite', 'orchestration.json', 'voice_examples.json', 'whisper_vocab.json',
    'memories'
)

function Test-LegacyDataPresent([string]$Root) {
    foreach ($item in $script:LegacyDataItems) {
        if (Test-Path -LiteralPath (Join-Path $Root $item)) { return $true }
    }
    return $false
}

function Get-LegacyDataSize([string]$Root) {
    [int64]$total = 0
    foreach ($item in $script:LegacyDataItems) {
        $path = Join-Path $Root $item
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $sum = (Get-ChildItem -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum).Sum
        if ($sum) { $total += [int64]$sum }
    }
    return $total
}

function Format-ByteSize([int64]$Bytes) {
    if ($Bytes -ge 1073741824) { return ('{0:N1} GB' -f ($Bytes / 1073741824)) }
    if ($Bytes -ge 1048576) { return ('{0:N1} MB' -f ($Bytes / 1048576)) }
    return ('{0:N0} KB' -f ($Bytes / 1024))
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

# -- An older installation that is somewhere else entirely -----------------
# Not every old installation is at the path this run installs into. The oldest
# installer put MultiCC wherever it happened to be run from ($PWD/MultiCC by
# default, $PWD itself with --no-clone), while this release installs to
# %USERPROFILE%\MultiCC, so an installation that predates the standalone package
# is routinely somewhere else. Two candidate directories are therefore checked
# in addition to the install path, and each still has to pass the same
# Test-LegacyInstall check - a directory that merely looks similar is never
# touched. Unlike macOS and Linux there is no login service to consult here: the
# old installer registered nothing of its own on Windows, so these candidates
# are the only evidence there is.
function Get-LegacyElsewhereCandidates {
    $current = (Get-Location).Path
    return @((Join-Path $current 'MultiCC'), $current)
}

function Find-LegacyElsewhere([string]$InstallDir) {
    foreach ($candidate in (Get-LegacyElsewhereCandidates)) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { continue }
        $full = [IO.Path]::GetFullPath($candidate)
        if ($full -eq $InstallDir) { continue }
        if (Test-LegacyInstall $full) { return $full }
    }
    return ''
}

# Whether that installation is running right now, from the pid file its own
# launcher kept. A running installation is still writing the files a copy would
# read, so it is worth saying before offering one.
function Test-LegacyInstallRunning([string]$Root) {
    $pidFile = Join-Path $Root '.multicc.pid'
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { return $false }
    $raw = Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue
    if ([string]::IsNullOrWhiteSpace($raw)) { return $false }
    $value = 0
    if (-not [int]::TryParse(($raw -replace '\D', ''), [ref]$value)) { return $false }
    return $null -ne (Get-Process -Id $value -ErrorAction SilentlyContinue)
}

# Something to say about an older installation that is not the one being
# replaced, and - when the user is there to say yes - consent to copy its data.
# It is never started, stopped, renamed or written to. The copy is offered,
# never assumed: a directory the user did not name is reported and left alone,
# with the one switch that includes it printed. -Yes still counts as an answer,
# because it is the default the question offers.
function Show-AdoptOffer([string]$Root) {
    if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root -PathType Container)) { return }
    if (-not (Test-LegacyDataPresent $Root)) {
        Write-Info "Another MultiCC installation is on this machine, at $Root (it holds no data)"
        $script:adoptCopy = $false
        return
    }
    $size = Format-ByteSize (Get-LegacyDataSize $Root)
    Write-Host ''
    Write-Host '  Another MultiCC installation is on this machine:'
    Write-Host "    $Root"
    Write-Host '  It is not the directory being installed into, so nothing in it is changed.'
    Write-Host "  It holds about $size of data: sessions, chat history, the task boards,"
    Write-Host '  memories and provider settings. Its own token and port are not taken -'
    Write-Host '  what data is copied, nothing else; this installation is configured on its own.'
    if (Test-LegacyInstallRunning $Root) {
        Write-Host '  It also looks like it is still running - it keeps writing those files,'
        Write-Host '  so a copy taken now is a snapshot of this moment.'
    }
    if ($script:adoptExplicit) {
        if (-not $script:adoptCopy) {
            $script:adoptDataLeftBehind = $true
            Write-Warn 'Both -AdoptData and -NoData were given - nothing was copied.'
            return
        }
        Write-Ok "Bringing your data across from $Root"
        return
    }
    if (-not $script:adoptCopy) {
        $script:adoptDataLeftBehind = $true
        Write-Host '  Its data stays where it is (-NoData). Include it later with:'
        Write-Host "    -AdoptData '$Root'"
        return
    }
    if ($Yes) {
        Write-Ok "Bringing your data across from $Root"
        return
    }
    # IsInputRedirected is the closest Windows has to the POSIX `[ -t 0 ]`, and
    # UserInteractive covers the other half: a runner or a service can hand over an
    # unredirected stdin that still has no one behind it.
    if ([Console]::IsInputRedirected -or -not [Environment]::UserInteractive) {
        # No console to ask on: the answer that cannot be declined has to be the
        # one that changes nothing.
        $script:adoptCopy = $false
        $script:adoptDataLeftBehind = $true
        Write-Host '  Nothing was copied: this installation starts without it. To include it, re-run'
        Write-Host '  with:'
        Write-Host "    -AdoptData '$Root'"
        return
    }
    Write-Host '  Copy it into this installation, so your history is here? The original stays'
    Write-Host '  where it is, as a second MultiCC you can keep or delete afterwards.'
    try {
        $answer = Read-Host 'Bring it across? [Y/n]'
    } catch {
        # A missing console has to end here rather than at the next command: this
        # is the one place where guessing means writing someone else's data.
        $script:adoptCopy = $false
        $script:adoptDataLeftBehind = $true
        Write-Warn "Could not read an answer ($($_.Exception.Message)) - nothing was copied."
        Write-Host "       Include it later with: -AdoptData '$Root'"
        return
    }
    if ([string]::IsNullOrWhiteSpace($answer) -or $answer -match '^[Yy]') {
        Write-Ok "Bringing your data across from $Root"
        return
    }
    $script:adoptCopy = $false
    $script:adoptDataLeftBehind = $true
    Write-Info 'Left where it is - this installation starts without it'
    Write-Host "       Include it later with: -AdoptData '$Root'"
}

# Copy the old data out of the source installation into the new data directory.
# The source is read, never written, and the destination is only ever an empty
# directory: if something is already in there it is either a second MultiCC or a
# first run of the new server, and in both cases those files are newer than the
# source. The source directory is passed in so the same code serves both an
# installation that was replaced and one that is being left where it is.
function Copy-LegacyDataAcross([string]$Command, [string]$Source) {
    if ([string]::IsNullOrWhiteSpace($Source) -or -not (Test-Path -LiteralPath $Source)) { return }

    # The data directory the launcher hands the server is `<userData>/data`, where
    # userData is whatever directory the CLI keeps multicc.env in
    # (desktop/lib/desktop-env.js). Asking the CLI keeps this right on every
    # platform instead of re-deriving the per-user path here.
    $envFile = (& $Command config path 2>$null | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($envFile)) {
        Write-Warn 'Could not work out where this release keeps its data; nothing was copied.'
        Write-Info "Your data is untouched in $Source."
        return
    }
    $dataDir = Join-Path (Split-Path -Parent $envFile) 'data'
    if ((Test-Path -LiteralPath $dataDir) -and
        @(Get-ChildItem -LiteralPath $dataDir -Force -ErrorAction SilentlyContinue).Count -gt 0) {
        Write-Warn 'This release already has data of its own - nothing was copied.'
        Write-Info "Your old data is untouched in $Source."
        return
    }
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

    $copied = 0
    $failed = 0
    foreach ($item in $script:LegacyDataItems) {
        $itemPath = Join-Path $Source $item
        if (-not (Test-Path -LiteralPath $itemPath)) { continue }
        $destination = Join-Path $dataDir $item
        if (Test-Path -LiteralPath $destination) { continue }
        try {
            Copy-Item -LiteralPath $itemPath -Destination $destination -Recurse -Force
            $copied++
        } catch {
            $failed++
            Write-Warn "Could not copy $item"
        }
    }

    if ($copied -eq 0 -and $failed -eq 0) {
        Write-Info 'No data from the previous installation needed bringing across'
        return
    }
    Write-Ok "Brought your data across: $copied item(s) into $dataDir"
    if ($failed -gt 0) {
        Write-Warn "$failed item(s) could not be copied and are still only in $Source."
    }
    Write-Host '       Sessions, chat history, tasks and memories are read from there now.' -ForegroundColor Blue
    Write-Host '       The source keeps its own copy - nothing was moved or deleted, so it' -ForegroundColor Blue
    Write-Host "       is safe to delete $Source once the new installation looks right." -ForegroundColor Blue
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
$legacyDir = ''
$legacyToken = ''
$legacyPort = ''
# Whether the old installation's data is copied into the new data directory.
# Starts from -NoData and can still be declined at the prompt.
$legacyDataCopy = -not $NoData.IsPresent
# Set when a real old installation's data was deliberately left in the backup, so
# the summary can say where it is and where it would have to go.
$legacyDataLeftBehind = $false
$legacyDataDest = ''

# An older installation that is NOT the directory this run installs into. It is
# never moved, stopped, renamed or written to: the only thing taken from it is a
# copy of the data, and only when the user asked for it (-AdoptData) or said yes
# to the question. $adoptExplicit records which of the two it was, because the
# answer changes what may happen without a prompt.
$adoptDir = ''
$adoptCopy = -not $NoData.IsPresent
$adoptExplicit = $false
$adoptDataLeftBehind = $false
# Whether this run replaces an installation that is already there. An upgrade in
# place already has whatever history matters; only a first install goes looking
# for a second installation elsewhere on the machine.
$targetHadInstall = (Test-Path -LiteralPath $InstallDir -PathType Container) -and (Test-StandaloneInstall $InstallDir)
# -AdoptData: an old installation the user named. Checked here, before anything
# is downloaded, so a wrong path costs nothing.
if (-not [string]::IsNullOrWhiteSpace($AdoptData)) {
    $adoptCandidate = [IO.Path]::GetFullPath($AdoptData)
    if (-not (Test-Path -LiteralPath $adoptCandidate -PathType Container) -or
        -not (Test-LegacyInstall $adoptCandidate)) {
        throw "-AdoptData: not a pre-standalone MultiCC installation: $adoptCandidate"
    }
    $adoptDir = $adoptCandidate
    $adoptExplicit = $true
    Write-Info "Using the data of the older installation at $adoptDir"
}

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
            if (-not (Test-LegacyInstall $InstallDir)) {
                throw "$InstallDir is not empty and does not look like a MultiCC standalone installation. Nothing was changed."
            }
            # A real older installation: upgrade it, and keep the old tree as a
            # backup rather than deleting it. Ask first unless -Yes - the old
            # installer worked from a checkout someone may still be developing in.
            Write-Info 'An older MultiCC installation was found; it will be kept as a backup.'
            if (-not [string]::IsNullOrWhiteSpace($adoptDir)) {
                Write-Warn "-AdoptData was ignored: $InstallDir is itself an older installation,"
                Write-Warn 'and it is that installation''s data which is being brought across.'
                $adoptDir = ''
            }
            Read-LegacyEnv $InstallDir
            if (-not $Yes) {
                $answer = Read-Host 'Upgrade it in place? The old directory is kept, never deleted. [Y/n]'
                if (-not [string]::IsNullOrWhiteSpace($answer) -and $answer -notmatch '^[Yy]') {
                    throw 'Upgrade cancelled. Nothing was changed.'
                }
            }
            $legacyStop = Join-Path $InstallDir 'multicc.cmd'
            if (Test-Path -LiteralPath $legacyStop -PathType Leaf) {
                try { & $legacyStop stop 2>$null | Out-Null } catch { }
            } else {
                # The POSIX installer's launcher is a shell script: it runs only
                # through bash, which is exactly what put it here in the first
                # place. Failing to stop it is not fatal - the new install still
                # lands - so this is wrapped and never allowed to abort.
                $legacyStop = Join-Path $InstallDir 'multicc'
                if ((Test-Path -LiteralPath $legacyStop -PathType Leaf) -and
                    (Get-Command bash -ErrorAction SilentlyContinue)) {
                    try {
                        Write-Info 'Stopping the previous installation before replacing it.'
                        & bash $legacyStop stop 2>$null | Out-Null
                    } catch { }
                }
            }
            $legacyDir = "$InstallDir.legacy-$([DateTime]::Now.ToString('yyyyMMddHHmmss'))"
            Move-Item -LiteralPath $InstallDir -Destination $legacyDir
            Write-Ok "Previous installation kept at $legacyDir"
            # The old releases kept their data inside the install directory:
            # sessions, chat history, tasks and memories all lived next to the
            # code. This release reads a per-user data directory instead, so
            # without an explicit copy the upgrade starts empty even though every
            # byte is still on disk. The copy happens later, once the new package
            # is in place and before the server has run for the first time.
            if (-not (Test-LegacyDataPresent $legacyDir)) {
                $legacyDataCopy = $false
            } elseif ($legacyDataCopy) {
                $dataBytes = Get-LegacyDataSize $legacyDir
                if (-not $Yes) {
                    Write-Host ''
                    Write-Host "  Your previous installation also holds about $(Format-ByteSize $dataBytes) of data:"
                    Write-Host '  sessions, chat history, the task boards, memories and provider settings.'
                    Write-Host '  It stays in the backup either way; bringing it across means the new'
                    Write-Host '  installation starts with your history instead of empty.'
                    $answer = Read-Host 'Bring it across? [Y/n]'
                    if (-not [string]::IsNullOrWhiteSpace($answer) -and $answer -notmatch '^[Yy]') {
                        $legacyDataCopy = $false
                    }
                }
            }
            if (-not $legacyDataCopy) {
                $legacyDataLeftBehind = $true
                Write-Warn "Your data stays in the backup: $legacyDir"
                Write-Host '       This release reads a per-user data directory, so it starts empty.' -ForegroundColor Yellow
                Write-Host '       Nothing was deleted, and the end of this run prints where it would' -ForegroundColor Yellow
                Write-Host '       have to be copied to.' -ForegroundColor Yellow
            }
        } elseif ($children.Count -gt 0) {
            # The branch above ran means the directory is no longer there (it
            # was renamed aside), so this must stay an elseif: falling through
            # with a plain second `if` would try to delete a path that is gone.
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
        # Whatever was moved aside goes back, so a failed install never leaves
        # someone with neither the new installation nor the working old one.
        if (-not [string]::IsNullOrWhiteSpace($legacyDir) -and (Test-Path -LiteralPath $legacyDir)) {
            Move-Item -LiteralPath $legacyDir -Destination $InstallDir
            Write-Warn "Your previous installation was put back at $InstallDir."
        } elseif (-not [string]::IsNullOrWhiteSpace($oldDir) -and (Test-Path -LiteralPath $oldDir)) {
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
    if (-not [string]::IsNullOrWhiteSpace($legacyDir)) {
        # A pre-standalone installation kept its settings in the install
        # directory's own .env, and that file holds more than the token and the
        # port: the push (VAPID) key pair and any ASR credentials the server
        # generated live there too. Carry the whole file across - but never over
        # one that already has content.
        $legacyEnvFile = Join-Path $legacyDir '.env'
        if (Test-Path -LiteralPath $legacyEnvFile -PathType Leaf) {
            $targetEnv = (& $MultiCCCommand config path 2>$null | Out-String).Trim()
            if (-not [string]::IsNullOrWhiteSpace($targetEnv)) {
                $targetEmpty = (-not (Test-Path -LiteralPath $targetEnv -PathType Leaf)) -or
                    ((Get-Item -LiteralPath $targetEnv).Length -eq 0)
                if ($targetEmpty) {
                    $targetParent = Split-Path -Parent $targetEnv
                    if (-not [string]::IsNullOrWhiteSpace($targetParent)) {
                        New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
                    }
                    Copy-Item -LiteralPath $legacyEnvFile -Destination $targetEnv -Force
                    Write-Info 'Kept the settings from your previous installation'
                }
            }
        }
        # The token the older installation was configured with is the one the
        # user's phone, bookmarks and other devices already carry, so it
        # outranks a token that merely happens to be in the data directory.
        if ([string]::IsNullOrWhiteSpace($AccessToken) -and -not [string]::IsNullOrWhiteSpace($legacyToken)) {
            $AccessToken = $legacyToken
        }
        $legacyPortValue = 0
        if (-not $PSBoundParameters.ContainsKey('Port') -and
            [int]::TryParse($legacyPort, [ref]$legacyPortValue) -and
            $legacyPortValue -ge 1 -and $legacyPortValue -le 65535) {
            $Port = $legacyPortValue
        }
    }
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

    # -- Bring an older installation's data across -------------------------
    # Before the server has ever started: the destination has to be empty for the
    # copy to be safe, and the first start is what makes it non-empty.
    if (-not [string]::IsNullOrWhiteSpace($legacyDir)) {
        Write-Step 'Bringing your data across'
        if ($legacyDataCopy) {
            Copy-LegacyDataAcross $MultiCCCommand $legacyDir
        } else {
            Write-Info "Skipped - the previous installation's data stays in $legacyDir"
        }
    } else {
        # Nothing was replaced here, which is not the same as there being nothing
        # to bring across: an installation from before the standalone package is
        # usually somewhere else on the machine (see Find-LegacyElsewhere). Only a
        # first install looks - an upgrade in place already has the history that
        # matters, and an installation named with -AdoptData is used either way.
        if ([string]::IsNullOrWhiteSpace($adoptDir) -and -not $targetHadInstall) {
            $adoptDir = Find-LegacyElsewhere $InstallDir
        }
        if (-not [string]::IsNullOrWhiteSpace($adoptDir)) {
            Show-AdoptOffer $adoptDir
            if ($adoptCopy) {
                Write-Step 'Bringing your data across'
                Copy-LegacyDataAcross $MultiCCCommand $adoptDir
            }
        }
    }
    # Resolved for the summary whatever the answer was: a "no" is only useful if
    # the user leaves knowing where their history is and where it would have to go.
    $legacyDataDest = (& $MultiCCCommand config path 2>$null | Out-String).Trim()
    if (-not [string]::IsNullOrWhiteSpace($legacyDataDest)) {
        $legacyDataDest = Join-Path (Split-Path -Parent $legacyDataDest) 'data'
    }

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
    if ($legacyDataLeftBehind) {
        Write-Host ''
        Write-Host '  Your previous sessions are still in the backup' -ForegroundColor Yellow
        Write-Host "    Backup:       $legacyDir"
        Write-Host "    This release: $legacyDataDest"
        Write-Host '    To use them, stop MultiCC, copy what you want out of the backup into the'
        Write-Host '    directory above, and start it again. Nothing was deleted.'
    }
    if ($adoptDataLeftBehind -and -not [string]::IsNullOrWhiteSpace($adoptDir)) {
        Write-Host ''
        Write-Host '  Another MultiCC installation still holds data for you' -ForegroundColor Yellow
        Write-Host "    Old install:  $adoptDir"
        Write-Host "    This release: $legacyDataDest"
        Write-Host '    Nothing in it was changed, and it was not moved or stopped. To use that'
        Write-Host "    data here, re-run this installer with -AdoptData '$adoptDir', or copy"
        Write-Host '    what you want into the directory above and start MultiCC again.'
    }
} catch {
    Write-Error $_
    exit 1
} finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
