# Copot custom Pixel HQ dari Herdr dan Claude Code di Windows (versi Windows dari uninstall.sh).
#   uninstall.cmd                 copot mod, layout, tema, hook, dan statusLine Pixel HQ (data kanban & usage disimpan)
#   uninstall.cmd --purge         sekalian hapus data kanban dan riwayat usage
#   uninstall.cmd --restore       bukan copot: kembalikan kondisi dari backup terbaru yang dibuat install.ps1
#   uninstall.cmd --restore FILE  sama, tapi dari backup tertentu (lihat daftar: dir %USERPROFILE%\backups\herdr)
# Sebelum mengubah apa pun, kondisi sekarang di-backup ke %USERPROFILE%\backups\herdr\sebelum-uninstall-pixelhq-<waktu>.zip
# File ini sengaja ASCII saja: Windows PowerShell 5.1 membaca skrip tanpa BOM sebagai ANSI.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false

function Fail([string]$msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

$Mode = 'copot'; $From = ''
for ($i = 0; $i -lt $args.Count; $i++) {
  $a = [string]$args[$i]
  switch -Regex ($a) {
    '^--purge$' { $Mode = 'purge'; continue }
    '^--restore$' { $Mode = 'restore'; continue }
    '^(-h|--help|/\?)$' { Get-Content -LiteralPath $PSCommandPath -TotalCount 7 | Select-Object -Skip 1 | ForEach-Object { $_ -replace '^# ?', '' }; exit 0 }
    default {
      if ($Mode -eq 'restore' -and -not $From -and (Test-Path -LiteralPath $a -PathType Leaf)) { $From = (Resolve-Path -LiteralPath $a).ProviderPath; continue }
      Fail "Opsi gak dikenal: $a (pakai --purge, --restore, atau --help)"
    }
  }
}

if (-not $env:USERPROFILE) { Fail 'Ini uninstaller Windows. Di Linux/macOS pakai: sh uninstall.sh' }
$UserHome = $env:USERPROFILE
$Cfg = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $UserHome '.config\herdr-app' }
$Cfg = $Cfg.TrimEnd('\', '/')
if (-not (Test-Path -LiteralPath $Cfg -PathType Container)) { Fail "Folder $Cfg gak ada, gak ada yang dicopot." }
$Cfg = (Resolve-Path -LiteralPath $Cfg).ProviderPath
$claudeSettings = Join-Path $UserHome '.claude\settings.json'
$State = Join-Path $UserHome '.local\state\pixel-hq'

function Get-BackupFiles([string]$dir) {
  # semua file, kecuali reparse point (socket herdr-app.sock, junction, symlink)
  foreach ($i in @(Get-ChildItem -LiteralPath $dir -Force)) {
    if ($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
    if ($i.PSIsContainer) { Get-BackupFiles $i.FullName } else { $i }
  }
}

# pindah dari layout pixel-hq dulu kalau Herdr lagi jalan, biar gak error waktu mod-nya hilang
function Leave-Layout {
  $h = Get-Command herdr-app -ErrorAction SilentlyContinue
  if (-not $h) { return }
  foreach ($l in 'main', 'terminals') {
    if (Test-Path -LiteralPath (Join-Path $Cfg "layouts\$l.json") -PathType Leaf) {
      try {
        & $h.Source do layout.switch ('{"name":"' + $l + '"}') *> $null
        if ($LASTEXITCODE -eq 0) { Write-Host "Layout dipindah ke $l"; return }
      } catch {}
    }
  }
}

# backup kondisi sekarang (.zip, sama seperti install.ps1)
$BkDir = Join-Path $UserHome 'backups\herdr'
[void][System.IO.Directory]::CreateDirectory($BkDir)
$Bk = Join-Path $BkDir ('sebelum-uninstall-pixelhq-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
$homePrefix = $UserHome.TrimEnd('\') + '\'
if ($Cfg.StartsWith($homePrefix, [System.StringComparison]::OrdinalIgnoreCase)) { $base = $homePrefix } else { $base = (Split-Path -Parent $Cfg).TrimEnd('\') + '\' }

$LastBk = ''
if ($Mode -eq 'restore') {
  $LastBk = $From
  if (-not $LastBk) {
    $f = @(Get-ChildItem -LiteralPath $BkDir -Filter 'sebelum-custom-pixelhq-*.zip' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending) | Select-Object -First 1
    if ($f) { $LastBk = $f.FullName }
  }
  if (-not $LastBk) { Fail "Gak ada backup dari install.ps1 di $BkDir." }
}

$todo = @(Get-BackupFiles $Cfg | ForEach-Object { , @($_.FullName, $_.FullName.Substring($base.Length)) })
if (Test-Path -LiteralPath $claudeSettings -PathType Leaf) { $todo += , @($claudeSettings, '.claude\settings.json') }
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$skipped = @()
$zip = [System.IO.Compression.ZipFile]::Open($Bk, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($t in $todo) {
    try { $src = [System.IO.File]::Open($t[0], 'Open', 'Read', 'ReadWrite, Delete') } catch { $skipped += $t[1]; continue }
    try {
      $entry = $zip.CreateEntry(($t[1] -replace '\\', '/'), [System.IO.Compression.CompressionLevel]::Optimal)
      $entry.LastWriteTime = [System.IO.File]::GetLastWriteTime($t[0])
      $dst = $entry.Open()
      try { $src.CopyTo($dst) } finally { $dst.Dispose() }
    } finally { $src.Dispose() }
  }
} finally { $zip.Dispose() }
Write-Host "Backup kondisi sekarang: $Bk"
if ($skipped.Count) { Write-Host ("  (gak kebaca, lagi dikunci program lain: " + ($skipped -join ', ') + ")") -ForegroundColor Yellow }

if ($Mode -eq 'restore') {
  Leave-Layout
  # buang mod company-* dulu, biar mod yang gak ada di backup (mis. company-kanban) gak tertinggal
  foreach ($m in @(Get-ChildItem -LiteralPath (Join-Path $Cfg 'mods') -Directory -Filter 'company-*' -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $m.FullName -Recurse -Force
  }
  $root = [System.IO.Path]::GetFullPath($base)
  $z = [System.IO.Compression.ZipFile]::OpenRead($LastBk)
  try {
    foreach ($e in $z.Entries) {
      if (-not $e.Name) { continue }  # folder
      $dest = [System.IO.Path]::GetFullPath((Join-Path $base ($e.FullName -replace '/', '\')))
      if (-not $dest.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { continue }  # bukan dari folder ini
      [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($dest))
      try { [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true) }
      catch { Write-Host "  gak bisa menimpa $($e.FullName): $($_.Exception.Message)" -ForegroundColor Yellow }
    }
  } finally { $z.Dispose() }
  Write-Host "Dipulihkan dari $LastBk"
  Write-Host 'Restart Herdr biar semuanya kepake.'
  exit 0
}

# 1. Claude Code: hook aktivitas dan statusLine (hanya yang punya Pixel HQ)
if (Test-Path -LiteralPath $claudeSettings -PathType Leaf) {
  $act = Join-Path $Cfg 'mods\company-agents\claude-activity.ps1'
  if (-not (Test-Path -LiteralPath $act -PathType Leaf)) { $act = Join-Path $PSScriptRoot 'mods\company-agents\claude-activity.ps1' }
  if (Test-Path -LiteralPath $act -PathType Leaf) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $act uninstall
    $global:LASTEXITCODE = 0
  } else { Write-Host 'claude-activity.ps1 gak ketemu: hook dilewati' }

  function Format-JsonString([string]$s) {
    $s = $s.Replace('\', '\\').Replace('"', '\"').Replace("`n", '\n').Replace("`r", '\r').Replace("`t", '\t')
    $s = [regex]::Replace($s, '[\x00-\x1f]', [System.Text.RegularExpressions.MatchEvaluator] { param($m) '\u{0:x4}' -f [int][char]$m.Value })
    return '"' + $s + '"'
  }
  function Format-Json($v, [string]$pad = '') {
    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    if ($null -eq $v) { return 'null' }
    if ($v -is [string]) { return Format-JsonString $v }
    if ($v -is [bool]) { if ($v) { return 'true' } else { return 'false' } }
    if ($v -is [double] -or $v -is [single]) { return $v.ToString('R', $inv) }
    if ($v -is [datetime] -or $v -is [datetimeoffset]) { return Format-JsonString $v.ToString('o', $inv) }
    if ($v -is [ValueType]) { return [System.Convert]::ToString($v, $inv) }
    $in = $pad + '  '
    if ($v -is [System.Collections.IDictionary]) {
      $items = @(foreach ($k in $v.Keys) { $in + (Format-JsonString ([string]$k)) + ': ' + (Format-Json $v[$k] $in) })
      if (-not $items.Count) { return '{}' }
      return "{`n" + ($items -join ",`n") + "`n$pad}"
    }
    if ($v -is [System.Management.Automation.PSCustomObject]) {
      $items = @(foreach ($p in $v.PSObject.Properties) { $in + (Format-JsonString $p.Name) + ': ' + (Format-Json $p.Value $in) })
      if (-not $items.Count) { return '{}' }
      return "{`n" + ($items -join ",`n") + "`n$pad}"
    }
    if ($v -is [System.Collections.IEnumerable]) {
      $items = @(foreach ($x in $v) { $in + (Format-Json $x $in) })
      if (-not $items.Count) { return '[]' }
      return "[`n" + ($items -join ",`n") + "`n$pad]"
    }
    return Format-JsonString ([string]$v)
  }

  $obj = $null
  try {
    $raw = [System.IO.File]::ReadAllText($claudeSettings, $utf8)
    $obj = if ($raw.Trim()) { $raw | ConvertFrom-Json } else { $null }
  } catch { $obj = $null }
  if ($obj -isnot [System.Management.Automation.PSCustomObject]) {
    Write-Host "$claudeSettings bukan JSON yang valid, statusLine gak diubah." -ForegroundColor Yellow
  } else {
    $curSl = $obj.PSObject.Properties['statusLine']
    $cur = if ($curSl -and $curSl.Value -is [System.Management.Automation.PSCustomObject]) { [string]$curSl.Value.command } elseif ($curSl) { [string]$curSl.Value } else { '' }
    if ($cur -match 'pixel-hq|claude-statusline') {
      [void]$obj.PSObject.Properties.Remove('statusLine')
      $tmp = "$claudeSettings.tmp.$PID"
      [System.IO.File]::WriteAllText($tmp, (Format-Json $obj) + "`n", $utf8)
      try { [System.IO.File]::Replace($tmp, $claudeSettings, [NullString]::Value) }
      catch { Move-Item -LiteralPath $tmp -Destination $claudeSettings -Force }
      Write-Host 'statusLine Pixel HQ dicabut'
    } else {
      Write-Host 'statusLine bukan punya Pixel HQ, gak diubah'
    }
  }
}
foreach ($n in 'pixel-hq-statusline.ps1', 'pixel-hq-statusline.sh') {
  Remove-Item -LiteralPath (Join-Path $UserHome ".claude\$n") -Force -ErrorAction SilentlyContinue
}

# 2. Herdr: mod, layout, tema
Leave-Layout
foreach ($m in @(Get-ChildItem -LiteralPath (Join-Path $Cfg 'mods') -Directory -Filter 'company-*' -ErrorAction SilentlyContinue)) {
  Remove-Item -LiteralPath $m.FullName -Recurse -Force
}
Remove-Item -LiteralPath (Join-Path $Cfg 'layouts\pixel-hq.json'), (Join-Path $Cfg 'themes\pixel-hq.json') -Force -ErrorAction SilentlyContinue
Write-Host 'Mod company-*, layout, dan tema pixel-hq dihapus'

# 3. data
if ($Mode -eq 'purge') {
  Remove-Item -LiteralPath (Join-Path $Cfg 'pixel-hq-kanban.json') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $State -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'Data kanban dan riwayat usage dihapus'
} else {
  Write-Host "Data disimpan: $Cfg\pixel-hq-kanban.json dan $State (hapus pakai --purge)"
}

Write-Host ''
Write-Host 'Selesai. Restart Herdr. Pasang lagi kapan aja pakai: install.cmd'
exit 0
