param(
  [Parameter(Mandatory=$true)][string]$AppDirectory,
  [Parameter(Mandatory=$true)][string]$SourceDirectory,
  [Parameter(Mandatory=$true)][string]$ExpectedScriptId
)
# Prepare only. Deliberately does not push, migrate, or deploy.
$ErrorActionPreference = 'Stop'
$appPath = (Resolve-Path -LiteralPath $AppDirectory).Path
$sourcePath = (Resolve-Path -LiteralPath $SourceDirectory).Path
if ($appPath -eq $sourcePath) { throw 'Folder source rilis harus berbeda dari clone live.' }
$binding = Get-Content -LiteralPath (Join-Path $appPath '.clasp.json') -Raw | ConvertFrom-Json
if ($binding.scriptId -ne $ExpectedScriptId) { throw 'Script ID clone tidak sesuai target Central File.' }
if ($binding.rootDir -and $binding.rootDir -ne '.') { throw 'Gunakan clone clasp dengan rootDir kosong atau titik.' }
$utf8 = New-Object System.Text.UTF8Encoding($false)
function CanonicalSource([string]$text) { return ($text.TrimStart([char]0xFEFF).Replace("`r`n","`n").TrimEnd([char]10) + "`n") }
function HashSource([string]$text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes((CanonicalSource $text))))).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
$manifestPath = Join-Path (Split-Path -Parent $sourcePath) 'releases\central-file-3.31.0-manifest.json'
if (!(Test-Path -LiteralPath $manifestPath)) { $manifestPath = Join-Path $sourcePath 'SOURCE_MANIFEST.json' }
if (!(Test-Path -LiteralPath $manifestPath)) { throw 'Manifest rilis tidak tersedia. Gunakan source repository lengkap atau paket resmi.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.release -ne '3.31.0' -or $manifest.schema -ne 11) { throw 'Manifest bukan rilis 3.31.0/schema 11.' }
$existing = @('Client.html','Code.js','Config.js','Index.html','ReliabilityService.js')
$newFiles = @('ContentDocumentService.js','ContentSearch.html','ContentSearchService.js','DocxTextService.js')
$baseRef = 'e30c96eefb27159e8703e3e9f9cf5c765c08323e'
$rawBase = "https://raw.githubusercontent.com/fathonydnm-byte/SRIKANDI/$baseRef/central-file"
$operations = @()
foreach ($name in ($existing + $newFiles)) {
  $sourceFile = Join-Path $sourcePath $name
  if (!(Test-Path -LiteralPath $sourceFile)) { throw "Source rilis tidak lengkap: $name" }
  $expectedHash = $manifest.canonicalFiles.PSObject.Properties[$name].Value
  if (!$expectedHash -or (HashSource ([IO.File]::ReadAllText($sourceFile))) -ne $expectedHash) { throw "Hash source rilis tidak cocok: $name" }
  $target = Join-Path $appPath $name
  if ($name.EndsWith('.js')) {
    $gsTarget = Join-Path $appPath ($name -replace '\.js$','.gs')
    if ((Test-Path -LiteralPath $target) -and (Test-Path -LiteralPath $gsTarget)) { throw "Ada file JS dan GS ganda: $name" }
    if (Test-Path -LiteralPath $gsTarget) { $target = $gsTarget }
  }
  if ($existing -contains $name) {
    if (!(Test-Path -LiteralPath $target)) { throw "Source live tidak lengkap: $name" }
    $baseline = (Invoke-WebRequest -UseBasicParsing -Uri "$rawBase/$name").Content
    $live = [IO.File]::ReadAllText($target)
    if ((HashSource $live) -ne (HashSource $baseline)) { throw "Source live $name berbeda dari baseline 3.30.6. Berhenti agar perubahan lain tidak tertimpa." }
  } elseif (Test-Path -LiteralPath $target) { throw "File baru sudah ada: $name. Periksa apakah rilis ini sudah dipasang." }
  $operations += @{source=$sourceFile; target=$target}
}
$config = [IO.File]::ReadAllText((Join-Path $sourcePath 'Config.js'))
if ($config -notmatch "VERSION: '3\.31\.0'" -or $config -notmatch 'SCHEMA_VERSION: 11') { throw 'Source bukan paket 3.31.0/schema 11.' }
$backup = $appPath + '-before-content-search-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
Copy-Item -LiteralPath $appPath -Destination $backup -Recurse
foreach ($operation in $operations) { [IO.File]::WriteAllText($operation.target,[IO.File]::ReadAllText($operation.source),$utf8) }
Write-Host "Sembilan file disiapkan. Backup: $backup"
Write-Host 'Belum ada perubahan pada Apps Script. Periksa diff/source, lalu jalankan clasp push dari folder clone ini.'
Write-Host 'Setelah push, backup metadata dan jalankan migrasi REL-013 melalui spreadsheet sebelum New version deployment.'
