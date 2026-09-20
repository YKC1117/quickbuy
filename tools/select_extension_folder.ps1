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
$edits=$dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)))
$folderEdit=$null
foreach($edit in $edits){
  Write-Host ('Picker edit: '+$edit.Current.Name+' / '+$edit.Current.AutomationId)
  if($edit.Current.Name -match '^Folder:|^File name:'){$folderEdit=$edit;break}
}
if($folderEdit){
  $folderEdit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($ExtensionPath)
  Write-Host 'Folder path entered through accessibility ValuePattern'
}else{
  Write-Host 'Folder edit field not exposed; using Windows address-bar keyboard fallback'
  $dialog.SetFocus()
  [System.Windows.Forms.Clipboard]::SetText($ExtensionPath)
  [System.Windows.Forms.SendKeys]::SendWait('^l')
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 150
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 800
}
$buttons=$dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)))
$button=$null
foreach($candidate in $buttons){
  Write-Host ('Picker button: '+$candidate.Current.Name+' / '+$candidate.Current.AutomationId)
  if(!$button -and $candidate.Current.Name -match '^(Select Folder|Select|Open|Choose)
){$button=$candidate}
}
if(!$button){
  $button=$dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'1')))
}
if(!$button){throw 'Select Folder/Open button not found in native picker'}
$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Write-Host 'Native unpacked-extension folder selected'
