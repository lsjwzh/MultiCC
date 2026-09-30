# Exercises install.ps1's "older installation somewhere else" code with a real
# fixture. Run by tests/test-standalone-installer.js wherever pwsh exists; the
# Windows job in desktop-release.yml runs the whole installer on windows-latest,
# but not this path, and the string assertions in the suite cannot tell a working
# copy from one that copies into the wrong directory.
#
# The functions are lifted out of the installer's own AST, so what runs here is
# the shipped text rather than a copy of it that can drift.
param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$Fixture
)

$ErrorActionPreference = 'Stop'
# Deliberately strict: an undefined variable in the real script would otherwise
# only surface the first time a Windows user ran it.
Set-StrictMode -Version 2.0

$ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$null, [ref]$null)
foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    Invoke-Expression $f.Extent.Text
}
# The one script-level data list the copy functions read.
$itemsAst = $ast.FindAll({ param($n)
    $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $n.Left.Extent.Text -eq '$script:LegacyDataItems' }, $true)
if ($itemsAst.Count -ne 1) { throw 'install.ps1 must keep $script:LegacyDataItems a script-level literal' }
Invoke-Expression $itemsAst[0].Extent.Text

$failures = 0
function Check([string]$what, [bool]$ok) {
    if ($ok) { Write-Host "  ok   $what" } else { Write-Host "  FAIL $what"; $script:failures++ }
}

$work = Join-Path $Fixture 'work'
$legacy = Join-Path $work 'MultiCC'
$target = Join-Path $Fixture 'target'
$userData = Join-Path $Fixture 'userdata'
$fakeCommand = Join-Path $Fixture 'fake-multicc.ps1'
Set-Content -LiteralPath $fakeCommand -Value "Write-Output '$(Join-Path $userData 'multicc.env')'"

Write-Host 'Find-LegacyElsewhere'
Set-Location -LiteralPath $work
Check 'finds the installation in the directory this run was started from' ((Find-LegacyElsewhere $target) -eq $legacy)
Check 'never returns the directory being installed into' ((Find-LegacyElsewhere $legacy) -ne $legacy)
Set-Location -LiteralPath $Fixture
Check 'finds nothing when there is nothing' ((Find-LegacyElsewhere $target) -eq '')

Write-Host 'Show-AdoptOffer without a console'
$script:adoptCopy = $true
$script:adoptExplicit = $false
$script:adoptDataLeftBehind = $false
$Yes = $false
Check 'this process has no interactive input, as on a runner or in a pipe' ([Console]::IsInputRedirected)
Show-AdoptOffer $legacy
Check 'does not copy when there is nobody to ask' ($script:adoptCopy -eq $false)
Check 'and says so in the summary' ($script:adoptDataLeftBehind -eq $true)
Check 'leaves the data directory uncreated' (-not (Test-Path -LiteralPath (Join-Path $userData 'data')))

Write-Host 'Show-AdoptOffer with the path named on the command line'
$script:adoptCopy = $true
$script:adoptExplicit = $true
$script:adoptDataLeftBehind = $false
Show-AdoptOffer $legacy
Check 'a named path is used without asking' ($script:adoptCopy -eq $true)
Check 'and is not reported as left behind' ($script:adoptDataLeftBehind -eq $false)

Write-Host 'Copy-LegacyDataAcross'
Copy-LegacyDataAcross $fakeCommand $legacy
$dataDir = Join-Path $userData 'data'
Check 'lands in <userData>/data, which is what the launcher reads' (Test-Path -LiteralPath (Join-Path $dataDir 'sessions.json'))
Check 'carries the chat history' (Test-Path -LiteralPath (Join-Path $dataDir 'chat_history/legacy-session.jsonl'))
Check 'the source keeps its own copy' ((Get-Content -LiteralPath (Join-Path $legacy 'sessions.json') -Raw).Trim() -eq '{"sessions":[{"id":"legacy-session"}]}')
Check 'copies nothing that is code' (-not (Test-Path -LiteralPath (Join-Path $dataDir 'node_modules')))

Write-Host 'Copy-LegacyDataAcross into a data directory that already has data'
$before = (Get-ChildItem -LiteralPath $dataDir -Force).Count
Copy-LegacyDataAcross $fakeCommand $legacy
Check 'refuses to merge into a data directory in use' ((Get-ChildItem -LiteralPath $dataDir -Force).Count -eq $before)

Write-Host 'Test-LegacyInstallRunning'
Set-Content -LiteralPath (Join-Path $legacy '.multicc.pid') -Value "$PID"
Check 'reports the installation whose pid file names a live process' (Test-LegacyInstallRunning $legacy)
Set-Content -LiteralPath (Join-Path $legacy '.multicc.pid') -Value '999999'
Check 'and not one whose pid is gone' (-not (Test-LegacyInstallRunning $legacy))
Remove-Item -LiteralPath (Join-Path $legacy '.multicc.pid') -Force

Write-Host 'the directory that was found is untouched'
Check 'no backup rename happened next to it' (((Get-ChildItem -LiteralPath $work -Force | Select-Object -ExpandProperty Name) -join ',') -eq 'MultiCC')
Check 'nothing new appeared beside the install target' (-not (Test-Path -LiteralPath $target))

if ($failures -gt 0) { Write-Host "$failures FAILED"; exit 1 }
Write-Host 'all checks passed'
