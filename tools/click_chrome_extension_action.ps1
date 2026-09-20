param(
  [string]$ExtensionName = "QuickBuy",
  [string]$ProcessName = "chrome"
)

$ErrorActionPreference = "Stop"
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
[QbaToolbarNative]::ShowWindow($hwnd,5) | Out-Null
[QbaToolbarNative]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 300

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
}

$launcher = $namedExtensions
$launcherLabel = "Chrome Extensions toolbar"
if (-not $launcher) {
  $launcher = $rightToolbarCandidate
  $launcherLabel = "Chrome right-toolbar candidate view_1007"
  Write-Host "Named Extensions button not exposed; using view_1007 between profile and Main menu"
}
if (-not $launcher) { throw "No Chrome extension launcher candidate found" }

Click-UiaElement -Element $launcher -Label $launcherLabel
Start-Sleep -Milliseconds 700

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
  throw "QuickBuy did not appear after opening Chrome extension launcher"
}

$target = $candidates |
  Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button } |
  Select-Object -First 1
if (-not $target) { $target = $candidates | Select-Object -First 1 }

Click-UiaElement -Element $target -Label $ExtensionName
Write-Host ("Chrome extension action activated: " + $ExtensionName)
