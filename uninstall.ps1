# Copot custom Pixel HQ dari Herdr dan Claude Code di Windows (versi Windows dari uninstall.sh).
#   uninstall.cmd                    copot mod, layout, tema, hook, statusLine, hotkey, dan pixel-hq-task (data kanban & usage disimpan)
#   uninstall.cmd -Purge             sekalian hapus data kanban dan riwayat usage
#   uninstall.cmd -Restore           bukan copot: kembalikan kondisi dari backup terbaru yang dibuat install.ps1
#   uninstall.cmd -Restore FILE.zip  sama, tapi dari backup tertentu (lihat daftar: dir %USERPROFILE%\backups\herdr)
# Sebelum mengubah apa pun, kondisi sekarang di-backup ke %USERPROFILE%\backups\herdr\sebelum-uninstall-pixelhq-<waktu>.zip
# Langsung dari terminal: powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 [-Purge | -Restore [FILE]]
# Folder konfigurasi lain: set dulu $env:HERDR_APP_HOME (sama seperti waktu install).
# File ini sengaja ASCII saja: Windows PowerShell 5.1 membaca skrip tanpa BOM sebagai ANSI.
param(
  [switch]$Purge,
  [switch]$Restore,
  [Parameter(Position = 0)][string]$From = '',
  [switch]$Help
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false

function Fail([string]$msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

if ($Help) { Get-Content -LiteralPath $PSCommandPath -TotalCount 8 | ForEach-Object { $_ -replace '^# ?', '' }; exit 0 }
if (-not $env:USERPROFILE) { Fail 'Ini uninstaller Windows. Di Linux/macOS pakai: sh uninstall.sh' }
if ($From -and -not $Restore) { Fail "Opsi gak dikenal: $From (pakai -Purge, -Restore [FILE], atau -Help)" }
if ($Purge -and $Restore) { Fail 'Pilih salah satu: -Purge atau -Restore.' }
$Here = $PSScriptRoot
$UserHome = $env:USERPROFILE
$Cfg = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $UserHome '.config\herdr-app' }
$Cfg = $Cfg.TrimEnd('\', '/')
if (-not (Test-Path -LiteralPath $Cfg -PathType Container)) { Fail "Folder $Cfg gak ada, gak ada yang dicopot." }
$Cfg = (Resolve-Path -LiteralPath $Cfg).ProviderPath
$homePrefix = $UserHome.TrimEnd('\') + '\'
# Sama dengan install.ps1: isi folder konfigurasi disimpan relatif ke home (atau ke folder induknya kalau di luar home),
# settings.json Claude Code selalu relatif ke home.
if ($Cfg.StartsWith($homePrefix, [System.StringComparison]::OrdinalIgnoreCase)) { $base = $homePrefix } else { $base = (Split-Path -Parent $Cfg).TrimEnd('\') + '\' }
$BkDir = Join-Path $UserHome 'backups\herdr'
$claudeSettings = Join-Path $UserHome '.claude\settings.json'

function Format-JsonString([string]$s) {
  $s = $s.Replace('\', '\\').Replace('"', '\"').Replace("`n", '\n').Replace("`r", '\r').Replace("`t", '\t')
  $s = [regex]::Replace($s, '[\x00-\x1f]', [System.Text.RegularExpressions.MatchEvaluator] { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  return '"' + $s + '"'
}
function Format-Json($v, [string]$pad = '') {
  # JSON.stringify(v, null, 2), sama dengan di install.ps1 dan mods/company-agents/claude-activity.ps1
  $inv = [System.Globalization.CultureInfo]::InvariantCulture
  if ($null -eq $v) { return 'null' }
  if ($v -is [string]) { return Format-JsonString $v }
  if ($v -is [bool]) { if ($v) { return 'true' } else { return 'false' } }
  if ($v -is [double] -or $v -is [single]) { return $v.ToString('R', $inv) }
  if ($v -is [datetime] -or $v -is [datetimeoffset]) { return Format-JsonString $v.ToString('o', $inv) }  # PowerShell 7 turns date strings into dates
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
function Read-JsonObject([string]$path) {
  # isi file JSON sebagai objek, atau $null kalau gak ada / gak valid / bukan objek
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  try { $o = [System.IO.File]::ReadAllText($path, $utf8) | ConvertFrom-Json } catch { return $null }
  if ($o -is [System.Management.Automation.PSCustomObject]) { return $o }
  return $null
}
function Write-JsonAtomic([string]$path, $obj) {
  $tmp = "$path.tmp.$PID"
  [System.IO.File]::WriteAllText($tmp, (Format-Json $obj) + "`n", $utf8)
  try {
    try { [System.IO.File]::Replace($tmp, $path, [NullString]::Value) }  # atomik di NTFS
    catch { Move-Item -LiteralPath $tmp -Destination $path -Force }  # kalau ReplaceFile gak didukung (share jaringan)
  } catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; throw }
}

# backup kondisi sekarang (.zip, sama seperti install.ps1)
function Get-BackupFiles([string]$dir) {
  # semua file, kecuali reparse point (socket herdr-app.sock, junction, symlink)
  foreach ($i in @(Get-ChildItem -LiteralPath $dir -Force)) {
    if ($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
    if ($i.PSIsContainer) { Get-BackupFiles $i.FullName } else { $i }
  }
}
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
function New-Backup {
  [void][System.IO.Directory]::CreateDirectory($BkDir)
  $bk = Join-Path $BkDir ('sebelum-uninstall-pixelhq-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
  $todo = @(Get-BackupFiles $Cfg | ForEach-Object { , @($_.FullName, $_.FullName.Substring($base.Length)) })
  if (Test-Path -LiteralPath $claudeSettings -PathType Leaf) { $todo += , @($claudeSettings, '.claude\settings.json') }
  $skipped = @()
  $zip = [System.IO.Compression.ZipFile]::Open($bk, [System.IO.Compression.ZipArchiveMode]::Create)
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
  Write-Host "Backup kondisi sekarang: $bk"
  if ($skipped.Count) { Write-Host ("  (gak kebaca, lagi dikunci program lain: " + ($skipped -join ', ') + ")") -ForegroundColor Yellow }
}

# perintah terminal pixel-hq-task dari install.ps1 (bukan bagian backup, jadi dicopot juga waktu -Restore)
function Remove-TaskCommand {
  if (-not $env:LOCALAPPDATA) { return }
  $shim = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pixel-hq-task.cmd'
  if ((Test-Path -LiteralPath $shim -PathType Leaf) -and ((Get-Content -LiteralPath $shim -Raw) -match 'dipasang custom Pixel HQ')) {
    Remove-Item -LiteralPath $shim -Force
    Write-Host 'Perintah pixel-hq-task dicopot'
  }
}

# pindah dari layout pixel-hq dulu kalau Herdr lagi jalan, biar gak error waktu mod-nya hilang
function Leave-Layout {
  $exe = Get-Command herdr-app -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $exe) { return }
  foreach ($l in 'main', 'terminals') {
    if (-not (Test-Path -LiteralPath (Join-Path $Cfg "layouts\$l.json") -PathType Leaf)) { continue }
    $code = 1
    $prev = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'  # di PowerShell 5.1, stderr program + 'Stop' = error yang menghentikan skrip
      & $exe.Path do layout.switch --name $l 2>&1 | Out-Null
      $code = $LASTEXITCODE
    } catch { $code = 1 } finally { $ErrorActionPreference = $prev }
    if ($code -eq 0) { Write-Host "Layout dipindah ke $l"; break }
  }
  $global:LASTEXITCODE = 0
}

function Remove-PixelMods {
  $left = @()
  foreach ($d in @(Get-ChildItem -LiteralPath (Join-Path $Cfg 'mods') -Directory -Filter 'company-*' -ErrorAction SilentlyContinue)) {
    try { Remove-Item -LiteralPath $d.FullName -Recurse -Force } catch { $left += $d.Name }
  }
  if ($left.Count) { Write-Host ("Gak kehapus (lagi dipakai? tutup Herdr lalu ulangi): " + ($left -join ', ')) -ForegroundColor Yellow }
}

if ($Restore) {
  $last = $From
  if (-not $last) {
    $found = @(Get-ChildItem -LiteralPath $BkDir -Filter 'sebelum-custom-pixelhq-*.zip' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    if ($found.Count) { $last = $found[0].FullName }
  }
  if (-not $last) { Fail "Gak ada backup dari install.ps1 di $BkDir." }
  if (-not (Test-Path -LiteralPath $last -PathType Leaf)) { Fail "File backup $last gak ada." }
  $last = (Resolve-Path -LiteralPath $last).ProviderPath
  New-Backup
  Leave-Layout
  # buang mod company-* dulu, biar mod yang gak ada di backup (mis. company-kanban) gak tertinggal
  Remove-PixelMods
  $failed = @()
  $zip = [System.IO.Compression.ZipFile]::OpenRead($last)
  try {
    foreach ($e in $zip.Entries) {
      if (-not $e.Name) { continue }  # entri folder
      $rel = $e.FullName -replace '/', '\'
      $root = if ($rel -like '.claude\*') { $homePrefix } else { $base }
      $dest = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
      if (-not $dest.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { $failed += "$rel (di luar $root)"; continue }
      try {
        [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $dest))
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
      } catch { $failed += $rel }
    }
  } finally { $zip.Dispose() }
  Remove-TaskCommand
  Write-Host "Dipulihkan dari $last"
  if ($failed.Count) { Write-Host ("Gak bisa dipulihkan (lagi dikunci? tutup Herdr lalu ulangi): " + ($failed -join ', ')) -ForegroundColor Yellow }
  Write-Host 'Restart Herdr biar semuanya kepake.'
  exit 0
}

New-Backup

# 1. Claude Code: hook aktivitas dan statusLine (hanya yang punya Pixel HQ)
if (Test-Path -LiteralPath $claudeSettings -PathType Leaf) {
  $act = Join-Path $Cfg 'mods\company-agents\claude-activity.ps1'
  if (-not (Test-Path -LiteralPath $act -PathType Leaf)) { $act = Join-Path $Here 'mods\company-agents\claude-activity.ps1' }
  if (Test-Path -LiteralPath $act -PathType Leaf) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $act uninstall
    if ($LASTEXITCODE -ne 0) { Write-Host 'Hook aktivitas gagal dicabut (lihat pesan di atas).' -ForegroundColor Yellow }
    $global:LASTEXITCODE = 0
  } else { Write-Host 'claude-activity.ps1 gak ketemu: hook dilewati' }
  $obj = Read-JsonObject $claudeSettings
  if ($null -eq $obj) {
    Write-Host "$claudeSettings bukan JSON yang valid, statusLine gak diubah." -ForegroundColor Yellow
  } else {
    $sl = $obj.PSObject.Properties['statusLine']
    $cur = if ($sl -and $sl.Value -is [System.Management.Automation.PSCustomObject]) { [string]$sl.Value.command } elseif ($sl) { [string]$sl.Value } else { '' }
    if ($cur -match 'pixel-hq|claude-statusline') {
      [void]$obj.PSObject.Properties.Remove('statusLine')
      Write-JsonAtomic $claudeSettings $obj
      Write-Host 'statusLine Pixel HQ dicabut'
    } else {
      Write-Host 'statusLine bukan punya Pixel HQ, gak diubah'
    }
  }
}
foreach ($f in 'pixel-hq-statusline.ps1', 'pixel-hq-statusline.sh') {
  $p = Join-Path $UserHome ".claude\$f"
  if (Test-Path -LiteralPath $p -PathType Leaf) { Remove-Item -LiteralPath $p -Force }
}

# 2. Herdr: mod, layout, tema, hotkey
Leave-Layout
Remove-PixelMods
foreach ($f in 'layouts\pixel-hq.json', 'themes\pixel-hq.json') {
  $p = Join-Path $Cfg $f
  if (Test-Path -LiteralPath $p -PathType Leaf) { Remove-Item -LiteralPath $p -Force }
}
Write-Host 'Mod company-*, layout, dan tema pixel-hq dihapus'
Remove-TaskCommand
# hotkey Kanban/Usage yang dipasang install.ps1, cuma yang masih menunjuk ke mod Pixel HQ
$PixelKeys = [ordered]@{ 'ctrl-shift-j' = 'mod.open:company-kanban'; 'ctrl-shift-m' = 'mod.open:company-usage' }
$keysFile = Join-Path $Cfg 'keys.json'
$k = Read-JsonObject $keysFile
if ($null -ne $k) {
  $secProp = $k.PSObject.Properties['layout:pixel-hq']
  if ($secProp -and $secProp.Value -is [System.Management.Automation.PSCustomObject]) {
    $sec = $secProp.Value
    $removed = 0
    foreach ($key in $PixelKeys.Keys) {
      $b = $sec.PSObject.Properties[$key]
      if ($b -and $b.Value -is [string] -and $b.Value -eq $PixelKeys[$key]) { [void]$sec.PSObject.Properties.Remove($key); $removed++ }
    }
    if ($removed) {
      if (-not @($sec.PSObject.Properties).Count) { [void]$k.PSObject.Properties.Remove('layout:pixel-hq') }
      Write-JsonAtomic $keysFile $k
      Write-Host 'Hotkey Kanban/Usage dicabut dari keys.json'
    }
  }
}

# 3. data
$state = Join-Path $UserHome '.local\state\pixel-hq'
if ($Purge) {
  foreach ($f in 'pixel-hq-kanban.json', 'pixel-hq-kanban-inbox.json', 'pixel-hq-kanban-inbox.json.lock') {
    $kb = Join-Path $Cfg $f
    if (Test-Path -LiteralPath $kb -PathType Leaf) { Remove-Item -LiteralPath $kb -Force }
  }
  if (Test-Path -LiteralPath $state) { Remove-Item -LiteralPath $state -Recurse -Force }
  Write-Host 'Data kanban dan riwayat usage dihapus'
} else {
  Write-Host "Data disimpan: $(Join-Path $Cfg 'pixel-hq-kanban.json') dan $state (hapus pakai -Purge)"
}

Write-Host ''
Write-Host 'Selesai. Restart Herdr. Pasang lagi kapan aja pakai: install.cmd'
exit 0
