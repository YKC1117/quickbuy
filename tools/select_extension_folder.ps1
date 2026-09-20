param([Parameter(Mandatory=$true)][string]$ExtensionPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$deadline=(Get-Date).AddSeconds(25)
$dialog=$null
while((Get-Date) -lt $deadline -and !$dialog){
  $windows=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  foreach($w in $windows){if($w.Current.ClassName -eq '#32770' -and $w.Current.Name -match 'extension|folder|directory'){ $dialog=$w; break }}
  if(!$dialog){Start-Sleep -Milliseconds 200}
}
if(!$dialog){
  foreach($w in $windows){Write-Host ($w.Current.ClassName+' | '+$w.Current.Name)}
  throw 'Native unpacked-extension folder picker did not open'
}
$dialog.SetFocus()
[System.Windows.Forms.SendKeys]::SendWait('^l')
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait($ExtensionPath)
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 500
$button=$dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'Select Folder')))
if(!$button){throw 'Select Folder button not found in native picker'}
$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Write-Host 'Native unpacked-extension folder selected'
