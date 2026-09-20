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
$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Write-Host ('Native unpacked-extension folder selected: '+$ExtensionPath)
