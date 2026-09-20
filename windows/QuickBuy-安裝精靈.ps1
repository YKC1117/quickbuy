$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Ext = Join-Path $Root 'QuickBuy-Extension'
$Manifest = Join-Path $Ext 'manifest.json'

function Find-Browser([string]$Name) {
  $paths = if ($Name -eq 'Chrome') {
    @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe","${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe","$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
  } else {
    @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe","$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe","$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe")
  }
  foreach ($p in $paths) { if ($p -and (Test-Path -LiteralPath $p)) { return $p } }
  return $null
}

function Assert-Package {
  if (!(Test-Path -LiteralPath $Manifest)) { throw 'QuickBuy-Extension 資料夾不完整，找不到 manifest.json。請重新解壓縮完整下載檔。' }
  $m = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($m.name -ne 'QuickBuy' -or $m.version -ne '1.0.0' -or $m.manifest_version -ne 3) {
    throw "安裝包版本不正確：$($m.name) $($m.version)。"
  }
}

function Open-Install([string]$Browser) {
  $exe = Find-Browser $Browser
  if (!$exe) { Write-Host "找不到 $Browser，略過。" -ForegroundColor Yellow; return }
  $url = if ($Browser -eq 'Chrome') { 'chrome://extensions/' } else { 'edge://extensions/' }
  try { Set-Clipboard -Value $Ext } catch {}
  Start-Process explorer.exe -ArgumentList @($Ext)
  Start-Process $exe -ArgumentList @($url)
  Write-Host ''
  Write-Host "[$Browser] 已打開擴充功能頁與 QuickBuy 資料夾" -ForegroundColor Green
  Write-Host '  1. 開啟「開發人員模式」' -ForegroundColor Cyan
  Write-Host '  2. 按「載入未封裝項目」' -ForegroundColor Cyan
  Write-Host '  3. 選剛剛打開的 QuickBuy-Extension 資料夾' -ForegroundColor Cyan
  Write-Host '  4. 把 QuickBuy 釘選到工具列即可使用' -ForegroundColor Cyan
}

Clear-Host
Write-Host '=============================================' -ForegroundColor DarkCyan
Write-Host '              QuickBuy 1.0' -ForegroundColor Cyan
Write-Host '          免費 Windows 安裝精靈' -ForegroundColor Cyan
Write-Host '=============================================' -ForegroundColor DarkCyan

try { Assert-Package } catch {
  Write-Host "安裝包檢查失敗：$($_.Exception.Message)" -ForegroundColor Red
  Read-Host '按 Enter 關閉' | Out-Null
  exit 1
}

$chrome = Find-Browser 'Chrome'
$edge = Find-Browser 'Edge'
if (!$chrome -and !$edge) {
  Write-Host '找不到 Google Chrome 或 Microsoft Edge。請先安裝其中一個瀏覽器。' -ForegroundColor Yellow
  Read-Host '按 Enter 關閉' | Out-Null
  exit 1
}

Write-Host ''
Write-Host 'QuickBuy 不需要 額外常駐程式、帳號或付費服務。' -ForegroundColor Green
Write-Host '因 Chrome / Edge 的安全限制，免費離線安裝需要在擴充功能頁按一次「載入未封裝項目」。' -ForegroundColor DarkGray
Write-Host ''

if ($chrome -and $edge) {
  Write-Host '請選擇要安裝的瀏覽器：'
  Write-Host '  [1] Google Chrome（建議）'
  Write-Host '  [2] Microsoft Edge'
  Write-Host '  [3] Chrome + Edge 都打開'
  $choice = Read-Host '輸入 1 / 2 / 3'
  switch ($choice) {
    '2' { Open-Install 'Edge' }
    '3' { Open-Install 'Chrome'; Open-Install 'Edge' }
    default { Open-Install 'Chrome' }
  }
} elseif ($chrome) {
  Open-Install 'Chrome'
} else {
  Open-Install 'Edge'
}

Write-Host ''
Write-Host '完成後，點瀏覽器工具列的 QuickBuy 即可開始。' -ForegroundColor Green
Write-Host '登入、驗證碼、排隊、付款與最後確認會保留給你操作。' -ForegroundColor DarkGray
Write-Host ''
Read-Host '按 Enter 關閉安裝精靈' | Out-Null
