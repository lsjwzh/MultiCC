param([switch]$Launch, [int]$RelayPid)
$ErrorActionPreference = 'Stop'
$powerShell = Join-Path $PSHOME 'powershell.exe'
if ($Launch) {
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -RelayPid {1}' -f $PSCommandPath, $PID
    Start-Process -FilePath $powerShell -ArgumentList $arguments -WindowStyle Hidden -WorkingDirectory ([IO.Path]::GetTempPath())
    exit 0
}

$request = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'request.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$installer = Join-Path $PSScriptRoot 'install.ps1'
$code = 1
try {
    foreach ($idToWait in @($RelayPid, $request.waitForPid)) {
        if ($idToWait) {
            $process = Get-Process -Id $idToWait -ErrorAction SilentlyContinue
            if ($process -and -not $process.WaitForExit(30000)) { throw "Process $idToWait did not exit." }
        }
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/lsjwzh/MultiCC/main/install.ps1' -OutFile $installer
    if ((Get-Item -LiteralPath $installer).Length -eq 0) { throw 'Downloaded install.ps1 is empty.' }
    $arguments = @('-InstallDir', $request.bundleRoot, '-Version', $request.targetVersion, '-NoOpen', '-NoService', '-NoShortcut', '-Yes')
    if ($null -ne $request.port) { $arguments += @('-Port', $request.port) }
    if ($request.from) { $arguments += @('-From', $request.from) }
    if ($request.noStart) { $arguments += '-NoStart' }
    # Windows PowerShell 5 converts native stderr to ErrorRecords; warnings
    # written there must not stop the installer before its exit code is read.
    $ErrorActionPreference = 'Continue'
    & $powerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installer @arguments 2>&1 |
        ForEach-Object { [IO.File]::AppendAllText($request.logPath, "$_`r`n") }
    $code = $LASTEXITCODE
} catch {
    [IO.File]::AppendAllText($request.logPath, "$($_.Exception.Message)`r`n")
} finally {
    [IO.File]::AppendAllText($request.logPath, "__MULTICC_UPDATE_EXIT__ $code`r`n")
    Remove-Item -LiteralPath $PSScriptRoot -Recurse -Force -ErrorAction SilentlyContinue
}
exit $code
