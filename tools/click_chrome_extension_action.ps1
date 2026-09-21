param(
  [string]$ExtensionName = "QuickBuy",
  [string]$ActionTitle = "",
  [string]$ProcessName = "chrome",
  [string]$ArtifactDir = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
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

function Save-DesktopShot {
  param([string]$Stage)
  if (-not $ArtifactDir) { return }
  New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null
  $bounds=[System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp=New-Object System.Drawing.Bitmap $bounds.Width,$bounds.Height
  $g=[System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$bmp.Size)
    $bmp.Save((Join-Path $ArtifactDir ("chrome-native-" + $Stage + ".png")),[System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $g.Dispose(); $bmp.Dispose() }
}

function Get-PatternNames {
  param($Element)
  $names=@()
  foreach($entry in @(
    @("Invoke",[System.Windows.Automation.InvokePattern]::Pattern),
    @("ExpandCollapse",[System.Windows.Automation.ExpandCollapsePattern]::Pattern),
    @("SelectionItem",[System.Windows.Automation.SelectionItemPattern]::Pattern),
    @("Toggle",[System.Windows.Automation.TogglePattern]::Pattern)
  )){
    $p=$null
    try { if($Element.TryGetCurrentPattern($entry[1],[ref]$p)){ $names += $entry[0] } } catch {}
  }
  return ($names -join ",")
}

function Save-UiaSnapshot {
  param([string]$Stage,[int]$BrowserPid)
  $root=[System.Windows.Automation.AutomationElement]::RootElement
  $all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  $rows=@()
  foreach($e in $all){
    try {
      $elementPid=[int]$e.Current.ProcessId
      $type=[string]$e.Current.ControlType.ProgrammaticName
      if($elementPid -ne $BrowserPid -and $type -notin @("ControlType.Window","ControlType.Menu","ControlType.MenuItem","ControlType.Pane","ControlType.ListItem","ControlType.Text","ControlType.Button")){ continue }
      $rect=$e.Current.BoundingRectangle
      $rows += [pscustomobject]@{
        ControlType=$type; Name=[string]$e.Current.Name; AutomationId=[string]$e.Current.AutomationId;
        ClassName=[string]$e.Current.ClassName; ProcessId=$elementPid; IsEnabled=[bool]$e.Current.IsEnabled;
        IsOffscreen=[bool]$e.Current.IsOffscreen; BoundingRectangle=("$($rect.Left),$($rect.Top),$($rect.Width),$($rect.Height)");
        NativeWindowHandle=$e.Current.NativeWindowHandle;
        RuntimeId=($e.GetRuntimeId() -join '.');
        ParentName=([System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($e)).Current.Name;
        Patterns=(Get-PatternNames $e)
      }
    } catch {}
  }
  if($ArtifactDir){
    New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null
    $rows | ConvertTo-Json -Depth 3 | Set-Content -Encoding UTF8 (Join-Path $ArtifactDir ("chrome-uia-" + $Stage + ".json"))
  }
  Write-Host ("UIA snapshot " + $Stage + ": " + $rows.Count + " nodes")
  Save-DesktopShot -Stage $Stage
}

function Click-UiaElement {
  param(
    [Parameter(Mandatory=$true)]$Element,
    [Parameter(Mandatory=$true)][string]$Label
  )
  $pattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $pattern.Invoke()
    Write-Host ("Invoked " + $Label + " through InvokePattern")
    return
  }
  $rect = $Element.Current.BoundingRectangle
  if ($rect.Width -le 0 -or $rect.Height -le 0) { throw "$Label has no clickable bounds" }
  $x = [int]($rect.Left + ($rect.Width / 2))
  $y = [int]($rect.Top + ($rect.Height / 2))
  [QbaToolbarNative]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 100
  [QbaToolbarNative]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)
  [QbaToolbarNative]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
  Write-Host ("Clicked " + $Label + " at " + $x + "," + $y)
}

function Get-VisibleQuickBuyCandidates {
  param([string]$Name)
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $all = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $found = @()
  foreach ($element in $all) {
    $label = [string]$element.Current.Name
    if ($label -and $label -match [regex]::Escape($Name)) {
      $type = [string]$element.Current.ControlType.ProgrammaticName
      $rect = $element.Current.BoundingRectangle
      Write-Host ("QuickBuy candidate: " + $type + " | " + $label + " | " + $element.Current.AutomationId + " | " + $rect.Left + "," + $rect.Top + "," + $rect.Width + "," + $rect.Height)
      if ($element.Current.IsEnabled -and $rect.Width -gt 0 -and $rect.Height -gt 0) {
        $found += $element
      }
    }
  }
  return $found
}

$deadline = (Get-Date).AddSeconds(15)
$proc = $null
while ((Get-Date) -lt $deadline -and -not $proc) {
  $proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Sort-Object StartTime |
    Select-Object -Last 1
  if (-not $proc) { Start-Sleep -Milliseconds 200 }
}
if (-not $proc) { throw "Browser window not found for process $ProcessName" }

$hwnd = [IntPtr]$proc.MainWindowHandle
[QbaToolbarNative]::ShowWindow($hwnd,3) | Out-Null
[QbaToolbarNative]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 700
Write-Host ("Chrome PID: " + $proc.Id + " / HWND: " + $proc.MainWindowHandle)
Save-UiaSnapshot -Stage "before-menu" -BrowserPid $proc.Id


function Get-ToolbarButtons {
  $window=[System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $all=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  foreach($e in $all){
    try {
      if($e.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button -or $e.Current.IsOffscreen -or -not $e.Current.IsEnabled){continue}
      $parent=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($e)
      $inToolbar=$false
      while($parent -and $parent -ne $window){
        if($parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document){break}
        if($parent.Current.ControlType -eq [System.Windows.Automation.ControlType]::ToolBar){$inToolbar=$true;break}
        $parent=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($parent)
      }
      if($inToolbar){Write-Output $e}
    } catch {}
  }
}
function Get-Action {
  foreach($e in @(Get-ToolbarButtons)){
    if($e.Current.Name -match [regex]::Escape($ExtensionName) -or ($ActionTitle -and $e.Current.Name -eq $ActionTitle)){return $e}
  }
}
$target=$null
$deadline=(Get-Date).AddSeconds(10)
while((Get-Date) -lt $deadline -and -not $target){
  $target=Get-Action
  if($target){break}
  $launcher=@(Get-ToolbarButtons | Where-Object { $_.Current.Name -match '^(Extensions|Extensions menu)$' }) | Select-Object -First 1
  if($launcher){break}
  Start-Sleep -Milliseconds 250
}
if(-not $target){
  if(-not $launcher){Save-UiaSnapshot -Stage 'toolbar-launcher-missing' -BrowserPid $proc.Id;throw 'Extensions Toolbar launcher not found; no main-menu fallback allowed'}
  Click-UiaElement -Element $launcher -Label 'Extensions Toolbar launcher'
  Start-Sleep -Milliseconds 500
  Save-UiaSnapshot -Stage 'toolbar-launcher-open' -BrowserPid $proc.Id
  # Pin only the control in the row that identifies QuickBuy, never a generic first Pin.
  $all=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  $pin=$null
  foreach($e in $all){
    if($e.Current.IsOffscreen -or $e.Current.Name -notmatch [regex]::Escape($ExtensionName)){continue}
    $parent=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($e)
    for($level=0;$level -lt 3 -and $parent;$level++){
      $children=$parent.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
      $pins=@($children | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -match '^Pin( |$)' })
      if($pins.Count -eq 1){$pin=$pins[0];break}
      $parent=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($parent)
    }
    if($pin){break}
  }
  if(-not $pin){Save-UiaSnapshot -Stage 'pin-missing' -BrowserPid $proc.Id;throw 'QuickBuy row Pin control not uniquely identifiable'}
  Click-UiaElement -Element $pin -Label 'Pin QuickBuy action'
  Start-Sleep -Milliseconds 300
  Save-UiaSnapshot -Stage 'pinned-menu' -BrowserPid $proc.Id
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  Start-Sleep -Milliseconds 300
  $target=Get-Action
}
if(-not $target){Save-UiaSnapshot -Stage 'action-missing' -BrowserPid $proc.Id;throw 'QuickBuy action not present in real Toolbar after pin'}
Save-UiaSnapshot -Stage 'toolbar-action-ready' -BrowserPid $proc.Id
# Reacquire after diagnostics: never click a stale menu node.
$target=Get-Action
Click-UiaElement -Element $target -Label 'QuickBuy Toolbar action'
Start-Sleep -Milliseconds 700
Save-UiaSnapshot -Stage 'sidepanel-open' -BrowserPid $proc.Id
Write-Host 'Chrome QuickBuy native Toolbar action clicked'
