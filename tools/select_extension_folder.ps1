param([Parameter(Mandatory=$true)][string]$ExtensionPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class QbaNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
$ExtensionPath=(Resolve-Path $ExtensionPath).Path
$deadline=(Get-Date).AddSeconds(25)
$dialog=$null
$windows=$null
while((Get-Date) -lt $deadline -and !$dialog){
  $windows=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  foreach($w in $windows){
    if($w.Current.ClassName -eq '#32770' -and $w.Current.Name -match 'extension|folder|directory'){
      $dialog=$w; break
    }
  }
  if(!$dialog){Start-Sleep -Milliseconds 200}
}
if(!$dialog){
  foreach($w in $windows){Write-Host ($w.Current.ClassName+' | '+$w.Current.Name)}
  throw 'Native unpacked-extension folder picker did not open'
}

$hwnd=[IntPtr]$dialog.Current.NativeWindowHandle
[QbaNative]::ShowWindow($hwnd,5) | Out-Null
[QbaNative]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 300

# Modern Chrome's shell folder picker does not expose the address bar as an Edit
# control. Navigate it the same way a user does: focus the address bar, paste the
# absolute folder, press Enter, then invoke Select Folder.
[System.Windows.Forms.Clipboard]::SetText($ExtensionPath)
[System.Windows.Forms.SendKeys]::SendWait('^l')
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 700

$button=$null
foreach($name in @('Select Folder','Select folder','Select')){
  $button=$dialog.FindFirst(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$name))
  )
  if($button){break}
}
if(!$button){
  $buttons=$dialog.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button))
  )
  foreach($b in $buttons){Write-Host ('Picker button: '+$b.Current.Name+' / '+$b.Current.AutomationId)}
  throw 'Select Folder button not found in native picker'
}
$clicked=$false
$pattern=$null
if($button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){
  $pattern.Invoke()
  $clicked=$true
  Write-Host 'Select Folder invoked through InvokePattern'
}
if(!$clicked){
  $rect=$button.Current.BoundingRectangle
  if($rect.Width -le 0 -or $rect.Height -le 0){throw 'Select Folder button has no clickable bounds'}
  $x=[int]($rect.Left + ($rect.Width/2))
  $y=[int]($rect.Top + ($rect.Height/2))
  [QbaNative]::SetForegroundWindow($hwnd) | Out-Null
  [QbaNative]::SetCursorPos($x,$y) | Out-Null
  Start-Sleep -Milliseconds 100
  [QbaNative]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)
  [QbaNative]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
  $clicked=$true
  Write-Host ('Select Folder clicked at '+$x+','+$y)
}
if(!$clicked){throw 'Could not activate Select Folder button'}
Start-Sleep -Milliseconds 500
Write-Host ('Native unpacked-extension folder selected: '+$ExtensionPath)
