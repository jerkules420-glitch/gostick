param(
    [int]$Port = 9222
)

$chromePaths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) {
    throw "Google Chrome was not found. Install Chrome or edit the paths in this script."
}

$profile = Join-Path $PSScriptRoot ".chrome-scraper-profile"
$url = "https://csgoskins.gg/categories/sticker?page=233"
$arguments = @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=$profile",
    $url
)

Start-Process -FilePath $chrome -ArgumentList $arguments
Write-Host "Chrome opened with its scraper profile."
Write-Host "Complete any security check, confirm the sticker grid is visible, then run:"
Write-Host "python scrape_stickers.py --start-page 233 --end-page 233 --output output --cdp-url http://127.0.0.1:$Port"