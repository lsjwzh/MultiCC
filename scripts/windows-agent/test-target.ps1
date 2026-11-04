# Run in a separate STA process: UI Automation must be able to query the target
# while the verifier is waiting for an agent response.
param([Parameter(Mandatory=$true)][string]$Log, [Parameter(Mandatory=$true)][string]$Ready)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TargetDpi {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
}
'@
[TargetDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Record($event) {
    [IO.File]::AppendAllText($Log, ($event | ConvertTo-Json -Compress) + "`n", (New-Object Text.UTF8Encoding($false)))
}
$form = New-Object Windows.Forms.Form
$form.StartPosition = 'Manual'
$form.Location = New-Object Drawing.Point(40,40)
$form.ClientSize = New-Object Drawing.Size(480,260)
$form.TopMost = $true
$form.Text = 'MultiCC agent conformance target'
$text = New-Object Windows.Forms.TextBox
$text.Location = New-Object Drawing.Point(20,20)
$text.Size = New-Object Drawing.Size(420,30)
$text.Add_TextChanged({ Record @{event='text';text=$text.Text} })
$button = New-Object Windows.Forms.Button
$button.Location = New-Object Drawing.Point(20,80)
$button.Size = New-Object Drawing.Size(160,40)
$button.Text = 'Observe click'
$button.Add_MouseDown({ param($sender,$event) Record @{event='mouse-down';button=$event.Button.ToString();mods=[int][Windows.Forms.Control]::ModifierKeys} })
$password = New-Object Windows.Forms.TextBox
$password.Location = New-Object Drawing.Point(20,160)
$password.Size = New-Object Drawing.Size(420,30)
$password.UseSystemPasswordChar = $true
$password.Add_TextChanged({ Record @{event='password-changed'} })
$form.Controls.AddRange(@($text,$button,$password))
$form.Add_Shown({
    $text.Focus() | Out-Null
    $tp = $text.PointToScreen((New-Object Drawing.Point(20,10)))
    $bp = $button.PointToScreen((New-Object Drawing.Point(30,20)))
    $pp = $password.PointToScreen((New-Object Drawing.Point(20,10)))
    @{text=@{x=$tp.X;y=$tp.Y};button=@{x=$bp.X;y=$bp.Y};password=@{x=$pp.X;y=$pp.Y}} |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $Ready -Encoding UTF8
})
try { [Windows.Forms.Application]::Run($form) } finally { $form.Dispose() }
