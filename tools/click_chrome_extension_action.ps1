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

  if (-not $Element) {
    throw "$Label element not found"
  }

  $pattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $pattern.Invoke()
    Write-Host ("Invoked " + $Label + " through InvokePattern")
    return
  }

  $rect = $Element.Current.BoundingRectangle
  if ($rect.Width -le 0 -or $rect.Height -le 0) {
    throw "$Label has no clickable bounds"
  }

  $x = [int]($rect.Left + ($rect.Width / 2))
  $y = [int]($rect.Top + ($rect.Height / 2))
  [QbaToolbarNative]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 100
  [QbaToolbarNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [QbaToolbarNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Write-Host ("Clicked " + $Label + " at " + $x + "," + $y)
}

$deadline = (Get-Date).AddSeconds(15)
$proc = $null

while ((Get-Date) -lt $deadline -and -not $proc) {
  $proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Sort-Object StartTime |
    Select-Object -Last 1

  if (-not $proc) {
    Start-Sleep -Milliseconds 200
  }
}

if (-not $proc) {
  throw "Browser window not found for process $ProcessName"
}

$hwnd = [IntPtr]$proc.MainWindowHandle
[QbaToolbarNative]::ShowWindow($hwnd, 5) | Out-Null
[QbaToolbarNative]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 300

$window = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)

$buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button
)

$buttons = $window.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  $buttonCondition
)

$extensionsButton = $null
$mainMenuButton = $null

foreach ($button in $buttons) {
  $name = [string]$button.Current.Name
  if ($name) {
    Write-Host ("Chrome button: " + $name + " / " + $button.Current.AutomationId)
  }

  if (-not $extensionsButton -and $name -match "^(Extensions|Extensions menu|Manage extensions)$") {
    $extensionsButton = $button
  }

  if (-not $mainMenuButton -and $name -eq "Main menu") {
    $mainMenuButton = $button
  }
}

if ($extensionsButton) {
  Click-UiaElement -Element $extensionsButton -Label "Chrome Extensions toolbar"
  Start-Sleep -Milliseconds 500
}
else {
  Write-Host "Chrome Extensions toolbar button not exposed; using Main menu fallback"

  if (-not $mainMenuButton) {
    throw "Chrome Main menu button not found"
  }

  Click-UiaElement -Element $mainMenuButton -Label "Chrome Main menu"
  Start-Sleep -Milliseconds 500

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $menuElements = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )

  $extensionsMenu = $null

  foreach ($element in $menuElements) {
    $name = [string]$element.Current.Name
    $controlType = [string]$element.Current.ControlType.ProgrammaticName

    if ($name) {
      Write-Host ("Chrome menu candidate: " + $controlType + " | " + $name + " | " + $element.Current.AutomationId)
    }

    if (-not $extensionsMenu -and $name -match "^(Extensions|Extensions and themes)$") {
      if ($element.Current.IsEnabled -and $element.Current.BoundingRectangle.Width -gt 0 -and $element.Current.BoundingRectangle.Height -gt 0) {
        $extensionsMenu = $element
      }
    }
  }

  if (-not $extensionsMenu) {
    throw "Chrome Extensions menu item not found in Main menu"
  }

  Click-UiaElement -Element $extensionsMenu -Label "Chrome Extensions menu"
  Start-Sleep -Milliseconds 500
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$allElements = $root.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition
)

$candidates = @()

foreach ($element in $allElements) {
  $name = [string]$element.Current.Name

  if ($name -and $name -match [regex]::Escape($ExtensionName)) {
    $controlType = [string]$element.Current.ControlType.ProgrammaticName
    Write-Host ("QuickBuy candidate: " + $controlType + " | " + $name + " | " + $element.Current.AutomationId)

    if ($element.Current.IsEnabled -and $element.Current.BoundingRectangle.Width -gt 0 -and $element.Current.BoundingRectangle.Height -gt 0) {
      $candidates += $element
    }
  }
}

if ($candidates.Count -eq 0) {
  throw "No visible $ExtensionName item found in Extensions UI"
}

$target = $candidates |
  Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button } |
  Select-Object -First 1

if (-not $target) {
  $target = $candidates | Select-Object -First 1
}

Click-UiaElement -Element $target -Label $ExtensionName
Write-Host ("Chrome extension action activated: " + $ExtensionName)
