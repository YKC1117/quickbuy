param(
  [string]$ExtensionName='QuickBuy',
  [string]$ProcessName='chrome'
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class QbaToolbarNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
function Click-UiaElement($el,[string]$label){
  if(!$el){throw "$label element not found"}
  $pattern=$null
  if($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){
    $pattern.Invoke()
    Write-Host ("Invoked "+$label+" through InvokePattern")
    return
  }
  $rect=$el.Current.BoundingRectangle
  if($rect.Width -le 0 -or $rect.Height -le 0){throw "$label has no clickable bounds"}
  $x=[int]($rect.Left+$rect.Width/2);$y=[int]($rect.Top+$rect.Height/2)
  [QbaToolbarNative]::SetCursorPos($x,$y)|Out-Null
  Start-Sleep -Milliseconds 100
  [QbaToolbarNative]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)
  [QbaToolbarNative]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
  Write-Host ("Clicked "+$label+" at "+$x+","+$y)
}
$deadline=(Get-Date).AddSeconds(15)
$proc=$null
while((Get-Date)-lt $deadline -and !$proc){
  $proc=Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object {$_.MainWindowHandle -ne 0} |
    Sort-Object StartTime |
    Select-Object -Last 1
  if(!$proc){Start-Sleep -Milliseconds 200}
}
if(!$proc){throw "Browser window not found for process $ProcessName"}
$hwnd=[IntPtr]$proc.MainWindowHandle
[QbaToolbarNative]::ShowWindow($hwnd,5)|Out-Null
[QbaToolbarNative]::SetForegroundWindow($hwnd)|Out-Null
Start-Sleep -Milliseconds 300
$window=[System.Windows.Automation.AutomationElement]::FromHandle($hwnd)

$buttons=$window.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button))
)
$extensionsButton=$null
foreach($b in $buttons){
  $name=[string]$b.Current.Name
  if($name){Write-Host ("Chrome button: "+$name+" / "+$b.Current.AutomationId)}
  if(!$extensionsButton -and $name -match '^Extensions$|Extensions menu|Manage extensions'){$extensionsButton=$b}
}
if($extensionsButton){
  Click-UiaElement $extensionsButton 'Chrome Extensions toolbar'
  Start-Sleep -Milliseconds 500
}else{
  Write-Host 'Chrome Extensions toolbar button not exposed; falling back to Main menu'
  $mainMenu=$null
  foreach($b in $buttons){if(([string]$b.Current.Name) -eq 'Main menu'){$mainMenu=$b;break}}
  if(!$mainMenu){throw 'Chrome Main menu button not found'}
  Click-UiaElement $mainMenu 'Chrome Main menu'
  Start-Sleep -Milliseconds 400
  $root=[System.Windows.Automation.AutomationElement]::RootElement
  $menuEls=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  $extensionsMenu=$null
  foreach($el in $menuEls){
    $name=[string]$el.Current.Name
    $ct=[string]$el.Current.ControlType.ProgrammaticName
    if($name){Write-Host ("Chrome menu candidate: "+$ct+" | "+$name+" | "+$el.Current.AutomationId)}
    if(!$extensionsMenu -and $name -match '^Extensions$|^Extensions and themes
if(!$candidates.Count){throw "No visible $ExtensionName item found in Extensions menu"}
$target=$candidates | Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button} | Select-Object -First 1
if(!$target){$target=$candidates | Select-Object -First 1}
Click-UiaElement $target $ExtensionName
Write-Host ("Chrome extension action activated: "+$ExtensionName)
){
      $extensionsMenu=$el
    }
  }
  if(!$extensionsMenu){throw 'Chrome Extensions menu item not found in Main menu'}
  Click-UiaElement $extensionsMenu 'Chrome Extensions menu'
  Start-Sleep -Milliseconds 500
}

$root=[System.Windows.Automation.AutomationElement]::RootElement
$all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
$candidates=@()
foreach($el in $all){
  $name=[string]$el.Current.Name
  if($name -and $name -match [regex]::Escape($ExtensionName)){
    $ct=[string]$el.Current.ControlType.ProgrammaticName
    Write-Host ("QuickBuy candidate: "+$ct+" | "+$name+" | "+$el.Current.AutomationId)
    if($el.Current.IsEnabled -and $el.Current.BoundingRectangle.Width -gt 0 -and $el.Current.BoundingRectangle.Height -gt 0){
      $candidates+=,$el
    }
  }
}
if(!$candidates.Count){throw "No visible $ExtensionName item found in Extensions menu"}
$target=$candidates | Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button} | Select-Object -First 1
if(!$target){$target=$candidates | Select-Object -First 1}
Click-UiaElement $target $ExtensionName
Write-Host ("Chrome extension action activated: "+$ExtensionName)
