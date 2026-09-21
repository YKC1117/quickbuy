param(
  [Parameter(Mandatory=$true)][string]$Url,
  [string]$ProcessName='chrome'
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class QbaBrowserNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$deadline=(Get-Date).AddSeconds(15)
$proc=$null
while((Get-Date) -lt $deadline -and !$proc){
  $proc=Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object {$_.MainWindowHandle -ne 0} |
    Sort-Object StartTime |
    Select-Object -Last 1
  if(!$proc){Start-Sleep -Milliseconds 200}
}
if(!$proc){throw "Browser window not found for process $ProcessName"}
$hwnd=[IntPtr]$proc.MainWindowHandle
[QbaBrowserNative]::ShowWindow($hwnd,5) | Out-Null
[QbaBrowserNative]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 300
[System.Windows.Forms.Clipboard]::SetText($Url)
[System.Windows.Forms.SendKeys]::SendWait('^l')
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Write-Host ("Browser address navigation submitted: "+$Url)
