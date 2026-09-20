param(
  [string]$ExtensionName = "QuickBuy",
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

$window = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button
)
$buttons = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,$buttonCondition)

$namedExtensions = $null
$rightToolbarCandidate = $null
foreach ($button in $buttons) {
  $name = [string]$button.Current.Name
  $automationId = [string]$button.Current.AutomationId
  $rect = $button.Current.BoundingRectangle
  if ($name) {
    Write-Host ("Chrome button: " + $name + " / " + $automationId + " / " + $rect.Left + "," + $rect.Top + "," + $rect.Width + "," + $rect.Height)
  }
  if (-not $namedExtensions -and $name -match "^(Extensions|Extensions menu|Manage extensions)$") {
    $namedExtensions = $button
  }
  if (-not $rightToolbarCandidate -and $automationId -eq "view_1007") {
    $rightToolbarCandidate = $button
  }
  if (-not $directQuickBuyButton -and $name -match [regex]::Escape($ExtensionName)) {
    $directQuickBuyButton = $button
  }
}

if ($directQuickBuyButton) {
  Click-UiaElement -Element $directQuickBuyButton -Label ($ExtensionName + " pinned action")
  Write-Host ("Chrome extension action activated directly from toolbar: " + $ExtensionName)
  exit 0
}

$launcher = $namedExtensions
$launcherLabel = "Chrome Extensions toolbar"
$usedRightToolbarMenu = $false
if (-not $launcher) {
  $launcher = $rightToolbarCandidate
  $launcherLabel = "Chrome right-toolbar main menu view_1007"
  $usedRightToolbarMenu = $true
  Write-Host "Named Extensions button not exposed; using Chrome right-toolbar menu view_1007"
}
if (-not $launcher) { throw "No Chrome extension launcher candidate found" }

Click-UiaElement -Element $launcher -Label $launcherLabel
Start-Sleep -Milliseconds 700
Save-UiaSnapshot -Stage "launcher-open" -BrowserPid $proc.Id

if ($usedRightToolbarMenu) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $all = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $extensionsMenuItem = $null
  foreach ($element in $all) {
    $name = [string]$element.Current.Name
    $type = [string]$element.Current.ControlType.ProgrammaticName
    if ($type -eq "ControlType.MenuItem" -and $name) {
      Write-Host ("Chrome top menu item: " + $name + " / " + [string]$element.Current.AutomationId)
    }
    if (-not $extensionsMenuItem -and $element.Current.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem -and $name -eq "Extensions") {
      $extensionsMenuItem = $element
    }
  }
  if (-not $extensionsMenuItem) { throw "Chrome Extensions item not found in right-toolbar menu" }
  # The first "Extensions" entry in Chrome's main menu is a submenu launcher.
  # Run 35512554527 proves its child menu contains Manage Extensions / Extensions /
  # Visit Chrome Web Store.  Opening that submenu is not the extension action list.
  Click-UiaElement -Element $extensionsMenuItem -Label "Chrome Extensions submenu"
  Start-Sleep -Milliseconds 500
  Save-UiaSnapshot -Stage "extensions-submenu-open" -BrowserPid $proc.Id

  # Re-query the desktop after the submenu appears. Never reuse stale UIA handles.
  # Current official Chrome exposes only management/store commands in this
  # submenu on the runner.  Do not mistake the still-visible parent Extensions
  # item (ExpandCollapse) for an extension-action launcher.
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $all = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $submenuRows = @()
  foreach ($element in $all) {
    try {
      $name = [string]$element.Current.Name
      $type = [string]$element.Current.ControlType.ProgrammaticName
      $class = [string]$element.Current.ClassName
      $rect = $element.Current.BoundingRectangle
      if ($type -eq "ControlType.MenuItem" -and $element.Current.IsEnabled -and
          -not $element.Current.IsOffscreen -and $rect.Width -gt 0 -and $rect.Height -gt 0) {
        $patterns = Get-PatternNames $element
        if ($name -match "Extension|Chrome Web Store|QuickBuy") {
          Write-Host ("Extensions submenu candidate: " + $name + " | " + $class + " | " + $patterns + " | " +
            $rect.Left + "," + $rect.Top + "," + $rect.Width + "," + $rect.Height)
        }
        $submenuRows += [pscustomobject]@{ Element=$element; Name=$name; ClassName=$class; Patterns=$patterns; Left=$rect.Left }
      }
    } catch { Write-Host ("UIA submenu probe exception: " + $_.Exception.Message) }
  }
  $quickBuyMenu = $submenuRows |
    Where-Object { $_.Name -match [regex]::Escape($ExtensionName) -and $_.Patterns -match "Invoke" } |
    Select-Object -First 1
  if ($quickBuyMenu) {
    Click-UiaElement -Element $quickBuyMenu.Element -Label ($ExtensionName + " extension action")
    Write-Host ("Chrome extension action activated from Extensions submenu: " + $ExtensionName)
    exit 0
  }
  $actionLauncher = $submenuRows |
    Where-Object {
      $_.Name -eq "Extensions" -and $_.Patterns -match "Invoke" -and
      $_.ClassName -eq "MenuItemView"
    } |
    Sort-Object Left |
    Select-Object -First 1
  if (-not $actionLauncher) {
    Save-UiaSnapshot -Stage "action-launcher-missing" -BrowserPid $proc.Id
    throw "Chrome Extensions submenu has no native extension-action launcher; only management/store commands are exposed"
  }
  Click-UiaElement -Element $actionLauncher.Element -Label "Chrome Extensions action-list launcher"
  Start-Sleep -Milliseconds 700
  Save-UiaSnapshot -Stage "extensions-open" -BrowserPid $proc.Id
}

$candidates = @(Get-VisibleQuickBuyCandidates -Name $ExtensionName)
if ($candidates.Count -eq 0) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  foreach ($element in $all) {
    $label = [string]$element.Current.Name
    if ($label -and $label -match "extension|side panel|pin|manage") {
      Write-Host ("Post-launch UI: " + [string]$element.Current.ControlType.ProgrammaticName + " | " + $label + " | " + [string]$element.Current.AutomationId)
    }
  }
  Save-UiaSnapshot -Stage "action-missing" -BrowserPid $proc.Id
  throw "QuickBuy action did not appear after opening Chrome extension launcher"
}

$target = $candidates |
  Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button } |
  Select-Object -First 1
if (-not $target) { $target = $candidates | Select-Object -First 1 }

Click-UiaElement -Element $target -Label $ExtensionName
Write-Host ("Chrome extension action activated: " + $ExtensionName)
