param([ValidateSet('chromium','chrome','msedge')][string]$Browser='chromium')
$ErrorActionPreference='Stop'
$env:QBA_BROWSER=$Browser
node tools/windows_extension_runtime.cjs
if ($LASTEXITCODE -ne 0) { throw "QuickBuy $Browser runtime FAILED; see runtime-results/$Browser/report.json" }
