param([string]$Binary, [switch]$Desktop)
$ErrorActionPreference = 'Stop'
if (!$Binary) { throw 'Pass -Binary <multicc-desktop-agent.exe>.' }
$Binary = (Resolve-Path -LiteralPath $Binary).Path
$previousPipe = $env:MULTICC_AGENT_PIPE
$env:MULTICC_AGENT_PIPE = '\\.\pipe\multicc-agent-test-' + [guid]::NewGuid().ToString('N')
$process = Start-Process -FilePath $Binary -ArgumentList 'serve' -PassThru -WindowStyle Hidden
$work = Join-Path ([IO.Path]::GetTempPath()) ('multicc-win-agent-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
function Request($request) {
    $name = $env:MULTICC_AGENT_PIPE.Substring(9)
    $pipe = New-Object IO.Pipes.NamedPipeClientStream('.', $name, [IO.Pipes.PipeDirection]::InOut)
    try {
        $pipe.Connect(3000)
        $writer = New-Object IO.StreamWriter($pipe, (New-Object Text.UTF8Encoding($false)))
        $writer.AutoFlush = $true
        $writer.WriteLine(($request | ConvertTo-Json -Compress -Depth 8))
        $reader = New-Object IO.StreamReader($pipe)
        $read = $reader.ReadLineAsync()
        if (!$read.Wait(10000)) { throw 'Agent response timed out.' }
        return ($read.Result | ConvertFrom-Json)
    } finally { $pipe.Dispose() }
}
function Check($condition, $name) { if (!$condition) { throw "FAIL: $name" }; Write-Output "PASS: $name" }
function ObservedEvents {
    if (Test-Path -LiteralPath $eventsPath) {
        Get-Content -LiteralPath $eventsPath -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json }
    }
}
function InputRequest($request) {
    $request.session = 'desktop-test'
    $request.allowSystem = $true
    $reply = Request $request
    Check ($reply.ok -eq $true) ($request.op + ' executes on the target')
    Start-Sleep -Milliseconds 150
    return $reply
}
try {
    for ($i=0; $i -lt 30; $i++) {
        try { $ping = Request @{op='ping'}; break } catch { Start-Sleep -Milliseconds 100 }
    }
    Check ($ping.pong -eq $true) 'named pipe round trip'
    $status = Request @{op='status'}
    Check ($status.backend -eq 'win32-gdi') 'Windows backend metadata'
    $unlock = Request @{op='unlock'}
    Check ($unlock.reason -eq 'unlock-unsupported') 'secure desktop cannot be unlocked'
    $resume = Request @{op='resume'}
    Check ($resume.ok -eq $true) 'resume protocol'
    if ($Desktop) {
        Check (!$status.screenLocked -and $status.control.escWatch) 'interactive desktop and physical Esc hook available'
        # Visible target makes a black/incorrect screenshot fail, even on GPU-less hosts.
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $form = New-Object Windows.Forms.Form
        $form.StartPosition = 'Manual'
        $form.Location = New-Object Drawing.Point(80,80)
        $form.Size = New-Object Drawing.Size(400,300)
        $form.BackColor = [Drawing.Color]::FromArgb(43,166,122)
        $form.TopMost = $true
        $form.Show()
        [Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 200
        $imagePath = Join-Path $work 'screen.png'
        $snap = Request @{op='snap';path=$imagePath}
        Check ($snap.ok -and (Test-Path $imagePath)) 'full PNG screenshot'
        $bitmap = [Drawing.Bitmap]::FromFile($imagePath)
        try {
            $found = $false
            for ($y=0; $y -lt $bitmap.Height -and !$found; $y+=4) {
                for ($x=0; $x -lt $bitmap.Width; $x+=4) {
                    $pixel=$bitmap.GetPixel($x,$y)
                    if ($pixel.R -eq 43 -and $pixel.G -eq 166 -and $pixel.B -eq 122) { $found=$true; break }
                }
            }
            Check $found 'screenshot contains the visible target color'
            Check ($bitmap.Width -eq $snap.width -and $bitmap.Height -eq $snap.height) 'screen coordinates match pixels'
        } finally { $bitmap.Dispose() }
        $cropPath = Join-Path $work 'crop.jpg'
        $crop = Request @{op='snap';path=$cropPath;crop=@{x=0;y=0;width=64;height=64};jpeg=$true}
        Check ($crop.ok -and $crop.crop.width -eq 64 -and $crop.width -eq $snap.width) 'crop preserves full-screen coordinate metadata'
        $bad = Request @{op='click';session='test';allowSystem=$true;x=1000000;y=0}
        Check ($bad.reason -eq 'bad-arguments') 'off-screen input rejected'
        $lease = Request @{op='lease';session='one'}
        Check $lease.ok 'explicit control lease'
        $busy = Request @{op='lease';session='two'}
        Check ($busy.reason -eq 'busy') 'second owner rejected'
        $null = Request @{op='release';session='one'}
        $lease2 = Request @{op='lease';session='two'}
        Check $lease2.ok 'released lease can be acquired'
        $null = Request @{op='release';session='two'}
        $form.Close()
        $form.Dispose()
        $form = $null
        $eventsPath = Join-Path $work 'events.jsonl'
        $readyPath = Join-Path $work 'target-ready.json'
        $targetScript = (Join-Path $PSScriptRoot 'test-target.ps1').Replace("'", "''")
        $command = "& '$targetScript' -Log '$($eventsPath.Replace("'", "''"))' -Ready '$($readyPath.Replace("'", "''"))'"
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
        $hostExe = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
        $target = Start-Process -FilePath $hostExe -ArgumentList @('-NoProfile','-STA','-EncodedCommand',$encoded) -PassThru -WindowStyle Hidden
        for ($i=0; $i -lt 50 -and !(Test-Path -LiteralPath $readyPath); $i++) { Start-Sleep -Milliseconds 100 }
        Check (Test-Path -LiteralPath $readyPath) 'separate interactive target is ready'
        $points = Get-Content -LiteralPath $readyPath -Encoding UTF8 | ConvertFrom-Json
        $null = InputRequest @{op='click';x=$points.button.x;y=$points.button.y;mods=@('ctrl','shift')}
        Check (@(ObservedEvents | Where-Object { $_.event -eq 'mouse-down' -and $_.button -eq 'Left' -and $_.mods -eq 196608 }).Count -eq 1) 'target observes Ctrl+Shift click'
        $null = InputRequest @{op='click';x=$points.button.x;y=$points.button.y}
        Check (@(ObservedEvents | Where-Object { $_.event -eq 'mouse-down' -and $_.mods -eq 0 }).Count -eq 1) 'modifiers are released after a click'
        $null = InputRequest @{op='click';x=$points.text.x;y=$points.text.y}
        # Build Unicode at runtime so Windows PowerShell 5 also reads this UTF-8
        # script correctly without relying on a source-file BOM.
        $sample = 'MultiCC ' + [char]0x4e2d + [char]0x6587 + [char]::ConvertFromUtf32(0x1f642)
        $null = InputRequest @{op='type';text=$sample}
        Check ((@(ObservedEvents | Where-Object { $_.event -eq 'text' }) | Select-Object -Last 1).text -ceq $sample) 'target receives exact ASCII, Chinese and surrogate-pair text'
        $null = InputRequest @{op='press';keys='ctrl+a'}
        $null = InputRequest @{op='type';text='replacement'}
        Check ((@(ObservedEvents | Where-Object { $_.event -eq 'text' }) | Select-Object -Last 1).text -ceq 'replacement') 'Ctrl+A chord selects existing text'
        $null = InputRequest @{op='click';x=$points.password.x;y=$points.password.y}
        $protected = Request @{op='type';session='desktop-test';allowSystem=$true;text='blocked'}
        Check ($protected.reason -eq 'protected-app') 'password control rejects remote typing'
        Check (@(ObservedEvents | Where-Object { $_.event -eq 'password-changed' }).Count -eq 0) 'password control receives no text'
        $null = Request @{op='release';session='desktop-test'}
        Write-Output 'Desktop capture, input, password and lease checks passed. Physical Esc still requires a hardware acceptance run.'
    }
} finally {
    if ($form) { $form.Close(); $form.Dispose() }
    if ($target) { Stop-Process -Id $target.Id -ErrorAction SilentlyContinue }
    Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    $env:MULTICC_AGENT_PIPE = $previousPipe
    Remove-Item -LiteralPath $work -Recurse -Force
}
