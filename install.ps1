# Pasang custom Pixel HQ ke Herdr di Windows (versi Windows dari install.sh).
# Syarat: Herdr sudah terpasang dan pernah dijalankan (folder konfigurasinya ada). Gak butuh Python, sh, atau Git Bash.
# Jalanin: klik dua kali install.cmd, atau dari terminal:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
# Folder konfigurasi lain: set dulu $env:HERDR_APP_HOME.
# File ini sengaja ASCII saja: Windows PowerShell 5.1 membaca skrip tanpa BOM sebagai ANSI.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false

function Fail([string]$msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

if (-not $env:USERPROFILE) { Fail 'Ini installer Windows. Di Linux/macOS pakai: sh install.sh' }
$Here = $PSScriptRoot
$UserHome = $env:USERPROFILE
$Cfg = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $UserHome '.config\herdr-app' }
$Cfg = $Cfg.TrimEnd('\', '/')
if (-not (Test-Path -LiteralPath (Join-Path $Here 'layouts\pixel-hq.json') -PathType Leaf)) { Fail "File repo gak lengkap di $Here (layouts\pixel-hq.json gak ada)." }
if (-not (Test-Path -LiteralPath $Cfg -PathType Container)) { Fail "Folder $Cfg gak ada. Jalanin Herdr sekali dulu." }
$Cfg = (Resolve-Path -LiteralPath $Cfg).ProviderPath

# 1. backup kondisi lama (.zip, isi folder konfigurasi Herdr dan ~/.claude/settings.json)
function Get-BackupFiles([string]$dir) {
  # semua file, kecuali reparse point (socket herdr-app.sock, junction, symlink)
  foreach ($i in @(Get-ChildItem -LiteralPath $dir -Force)) {
    if ($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
    if ($i.PSIsContainer) { Get-BackupFiles $i.FullName } else { $i }
  }
}
$BkDir = Join-Path $UserHome 'backups\herdr'
[void][System.IO.Directory]::CreateDirectory($BkDir)
$Bk = Join-Path $BkDir ('sebelum-custom-pixelhq-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
$homePrefix = $UserHome.TrimEnd('\') + '\'
if ($Cfg.StartsWith($homePrefix, [System.StringComparison]::OrdinalIgnoreCase)) { $base = $homePrefix } else { $base = (Split-Path -Parent $Cfg).TrimEnd('\') + '\' }
$todo = @(Get-BackupFiles $Cfg | ForEach-Object { , @($_.FullName, $_.FullName.Substring($base.Length)) })
$claudeSettings = Join-Path $UserHome '.claude\settings.json'
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
Write-Host "Backup kondisi lama: $Bk"
if ($skipped.Count) { Write-Host ("  (gak kebaca, lagi dikunci program lain: " + ($skipped -join ', ') + ")") -ForegroundColor Yellow }

# 2. layout, tema, mod (mod company-* ditimpa; file lain di konfigurasi kamu gak disentuh)
foreach ($d in 'layouts', 'themes', 'mods') { [void][System.IO.Directory]::CreateDirectory((Join-Path $Cfg $d)) }
Copy-Item -LiteralPath (Join-Path $Here 'layouts\pixel-hq.json') -Destination (Join-Path $Cfg 'layouts\pixel-hq.json') -Force
Copy-Item -LiteralPath (Join-Path $Here 'themes\pixel-hq.json') -Destination (Join-Path $Cfg 'themes\pixel-hq.json') -Force
foreach ($m in @(Get-ChildItem -LiteralPath (Join-Path $Here 'mods') -Directory -Filter 'company-*')) {
  # robocopy /MIR: isinya disamakan persis dengan repo, tanpa menghapus foldernya (Herdr bisa lagi mengawasi folder itu)
  & robocopy.exe $m.FullName (Join-Path $Cfg "mods\$($m.Name)") /MIR /IS /IT /R:3 /W:1 /XD __pycache__ /XF *.pyc /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Fail "Gagal menyalin mod $($m.Name) (robocopy exit $LASTEXITCODE)." }
}
$global:LASTEXITCODE = 0
$music = Join-Path $Cfg 'mods\company-music'
if (Test-Path -LiteralPath $music) { Remove-Item -LiteralPath $music -Recurse -Force }  # MusicBox sengaja dihilangin di versi ini
Write-Host "Layout, tema, dan mod company-* disalin ke $Cfg"

# 3. Claude Code: statusLine (buat chip usage) dan hook aktivitas, versi PowerShell
function Format-JsonString([string]$s) {
  $s = $s.Replace('\', '\\').Replace('"', '\"').Replace("`n", '\n').Replace("`r", '\r').Replace("`t", '\t')
  $s = [regex]::Replace($s, '[\x00-\x1f]', [System.Text.RegularExpressions.MatchEvaluator] { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  return '"' + $s + '"'
}
function Format-Json($v, [string]$pad = '') {
  # JSON.stringify(v, null, 2), sama dengan di mods/company-agents/claude-activity.ps1
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

$ClaudeDir = Join-Path $UserHome '.claude'
if (Test-Path -LiteralPath $ClaudeDir -PathType Container) {
  $sl = Join-Path $ClaudeDir 'pixel-hq-statusline.ps1'
  Copy-Item -LiteralPath (Join-Path $Cfg 'mods\company-agents\claude-statusline.ps1') -Destination $sl -Force
  # perintah yang sama persis dipakai mod company-agents saat Herdr start, jadi gak saling timpa
  $cmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + ($sl -replace '\\', '/') + '"'
  $obj = $null
  try {
    if (Test-Path -LiteralPath $claudeSettings -PathType Leaf) {
      $raw = [System.IO.File]::ReadAllText($claudeSettings, $utf8)
      $obj = if ($raw.Trim()) { $raw | ConvertFrom-Json } else { [pscustomobject]@{} }
    } else { $obj = [pscustomobject]@{} }
  } catch { $obj = $null }
  if ($obj -isnot [System.Management.Automation.PSCustomObject]) {
    Write-Host "$claudeSettings bukan JSON yang valid, statusLine gak dipasang." -ForegroundColor Yellow
  } else {
    $curSl = $obj.PSObject.Properties['statusLine']
    $cur = if ($curSl -and $curSl.Value -is [System.Management.Automation.PSCustomObject]) { [string]$curSl.Value.command } elseif ($curSl) { [string]$curSl.Value } else { '' }
    if ($cur -eq $cmd) {
      Write-Host 'statusLine sudah terpasang'
    } elseif (-not $cur -or $cur -match 'pixel-hq|claude-statusline') {
      # kosong, atau versi Pixel HQ yang lama (sh + python, gak jalan di Windows tanpa Python)
      $val = [pscustomobject]@{ type = 'command'; command = $cmd }
      if ($curSl) { $obj.statusLine = $val } else { $obj | Add-Member -NotePropertyName statusLine -NotePropertyValue $val }
      $tmp = "$claudeSettings.tmp.$PID"
      [System.IO.File]::WriteAllText($tmp, (Format-Json $obj) + "`n", $utf8)
      try {
        if (-not [System.IO.File]::Exists($claudeSettings)) { [System.IO.File]::Move($tmp, $claudeSettings) }
        else {
          try { [System.IO.File]::Replace($tmp, $claudeSettings, [NullString]::Value) }  # atomik di NTFS
          catch { Move-Item -LiteralPath $tmp -Destination $claudeSettings -Force }  # kalau ReplaceFile gak didukung (share jaringan)
        }
      } catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; throw }
      Write-Host 'statusLine dipasang'
    } else {
      Write-Host "statusLine sudah ada, gak diubah: $cur"
    }
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Cfg 'mods\company-agents\claude-activity.ps1') install
  if ($LASTEXITCODE -ne 0) { Write-Host 'Hook aktivitas gagal dipasang (lihat pesan di atas).' -ForegroundColor Yellow }
  $global:LASTEXITCODE = 0
} else {
  Write-Host '~/.claude gak ada: lewati statusLine dan hook Claude Code.'
}

# 4. hotkey Kanban dan Usage, cuma aktif di layout pixel-hq (bagian "layout:pixel-hq" di keys.json).
# Tombol yang udah kamu pakai buat hal lain gak ditimpa. Sama dengan langkah 2b di install.sh.
$PixelKeys = [ordered]@{ 'ctrl-shift-j' = 'mod.open:company-kanban'; 'ctrl-shift-m' = 'mod.open:company-usage' }
function Set-PixelHotkeys([string]$file) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Write-Host 'keys.json belum ada (jalanin Herdr sekali dulu): hotkey Kanban/Usage dilewati'; return }
  $k = $null
  try { $k = [System.IO.File]::ReadAllText($file, $utf8) | ConvertFrom-Json } catch { $k = $null }
  if ($k -isnot [System.Management.Automation.PSCustomObject]) { Write-Host 'keys.json gak kebaca sebagai objek JSON: hotkey Kanban/Usage dilewati' -ForegroundColor Yellow; return }
  $secProp = $k.PSObject.Properties['layout:pixel-hq']
  $sec = if ($secProp -and $secProp.Value -is [System.Management.Automation.PSCustomObject]) { $secProp.Value } else { [pscustomobject]@{} }
  $added = @()
  foreach ($key in $PixelKeys.Keys) {
    $act = $PixelKeys[$key]
    $have = $sec.PSObject.Properties[$key]
    if ($have -and $have.Value -is [string] -and $have.Value -eq $act) { continue }
    $used = $null
    foreach ($n in 'layout:pixel-hq', 'terminal', 'global') {
      $p = $k.PSObject.Properties[$n]
      if (-not $p -or $p.Value -isnot [System.Management.Automation.PSCustomObject]) { continue }
      $b = $p.Value.PSObject.Properties[$key]
      if ($b -and -not ($b.Value -is [string] -and $b.Value -eq $act)) { $used = $n; break }
    }
    if ($used) { Write-Host "Hotkey dilewati: $key (udah dipakai di $used)" -ForegroundColor Yellow; continue }
    $sec | Add-Member -NotePropertyName $key -NotePropertyValue $act -Force
    $added += "$key = $($act.Split(':')[1])"
  }
  if (-not $added.Count) { return }
  if ($secProp) { $secProp.Value = $sec } else { $k | Add-Member -NotePropertyName 'layout:pixel-hq' -NotePropertyValue $sec }
  $tmp = "$file.tmp.$PID"
  [System.IO.File]::WriteAllText($tmp, (Format-Json $k) + "`n", $utf8)
  try {
    try { [System.IO.File]::Replace($tmp, $file, [NullString]::Value) }  # atomik di NTFS
    catch { Move-Item -LiteralPath $tmp -Destination $file -Force }  # kalau ReplaceFile gak didukung (share jaringan)
  } catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; throw }
  Write-Host ('Hotkey dipasang: ' + ($added -join ', '))
}
Set-PixelHotkeys (Join-Path $Cfg 'keys.json')

# 5. perintah terminal pixel-hq-task (tambah task ke kanban dari terminal/skrip). Pemanggilnya ditaruh di folder
# WindowsApps milikmu (biasanya sudah ada di PATH); isinya cuma memanggil skrip di folder mod, jadi ikut terbarui.
function Set-TaskCommand {
  $direct = Join-Path $Cfg 'mods\company-kanban\pixel-hq-task.cmd'
  $dir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps' } else { '' }
  $onPath = $dir -and (@($env:Path -split ';' | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') }) -contains $dir.TrimEnd('\'))
  if (-not $onPath -or -not (Test-Path -LiteralPath $dir -PathType Container)) {
    Write-Host "Perintah terminal: `"$direct`" `"judul task`"  (folder WindowsApps gak ada di PATH, jadi pakai jalur lengkap)"
    return
  }
  $shim = Join-Path $dir 'pixel-hq-task.cmd'
  if ((Test-Path -LiteralPath $shim) -and -not ((Get-Content -LiteralPath $shim -Raw) -match 'dipasang custom Pixel HQ')) {
    Write-Host "$shim udah ada dan bukan punya Pixel HQ, gak ditimpa." -ForegroundColor Yellow
    return
  }
  $script = Join-Path $Cfg 'mods\company-kanban\pixel-hq-task.ps1'
  $lines = @('@echo off', 'rem pixel-hq-task: dipasang custom Pixel HQ (install.ps1), dicopot uninstall.ps1.', 'setlocal',
    "if not defined HERDR_APP_HOME set `"HERDR_APP_HOME=$Cfg`"",
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`" %*", 'exit /b %ERRORLEVEL%')
  # cmd.exe membaca file .cmd pakai code page OEM, jadi jalur dengan huruf non-ASCII ditulis pakai itu juga
  $oem = [System.Text.Encoding]::GetEncoding([System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
  [System.IO.File]::WriteAllText($shim, ($lines -join "`r`n") + "`r`n", $oem)
  Write-Host 'Perintah terminal dipasang: pixel-hq-task "judul task"   (bantuan: pixel-hq-task -h)'
}
Set-TaskCommand

Write-Host ''
Write-Host 'Selesai. Aktifkan layout-nya:'
Write-Host '  herdr-app do layout.switch --name pixel-hq'
Write-Host 'lalu cek: herdr-app status   (errors harus kosong)'
exit 0
