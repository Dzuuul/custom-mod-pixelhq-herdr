# Diagnosa pemasangan custom Pixel HQ di Windows (versi Windows dari pixel-hq-doctor.py). Gak mengubah apa pun.
#   doctor.cmd di folder repo (klik dua kali), atau:
#   powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.config\herdr-app\mods\company-agents\pixel-hq-doctor.ps1"
# Hasilnya ditampilkan, disimpan ke %USERPROFILE%\pixel-hq-doctor-<waktu>.txt, dan disalin ke clipboard, buat ditempel
# waktu lapor masalah. Laporannya gak berisi isi task, balasan agent, atau isi settings.json selain bagian Pixel HQ,
# dan folder home ditulis "~". WSL cuma dicek dari distro yang lagi jalan (gak dinyalakan).
# File ini sengaja ASCII saja: Windows PowerShell 5.1 membaca skrip tanpa BOM sebagai ANSI.
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$UserHome = [string]$env:USERPROFILE
$Cfg = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $UserHome '.config\herdr-app' }
$Cfg = $Cfg.TrimEnd('\', '/')
$State = Join-Path $UserHome '.local\state\pixel-hq'
$Here = $PSScriptRoot
$HookEvents = @('PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd')
$Now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

$script:lines = [System.Collections.Generic.List[string]]::new()
$script:problems = 0
$script:warnings = 0
function Hide([string]$s) { if ($UserHome) { return $s.Replace($UserHome, '~') } else { return $s } }
function Say([string]$s = '') { $script:lines.Add((Hide $s)) }
function Section([string]$t) { Say; Say "== $t" }
function Mark([string]$kind, [string]$text, [string]$fix = '') {
  if ($kind -eq 'MASALAH') { $script:problems++ } elseif ($kind -eq 'AWAS') { $script:warnings++ }
  Say ('  ' + $kind.PadRight(8) + $text)
  if ($fix) { Say "          -> $fix" }
}
function Ok([string]$t) { Mark 'ok' $t }
function Info([string]$t) { Mark 'info' $t }
function Warn([string]$t, [string]$fix = '') { Mark 'AWAS' $t $fix }
function Bad([string]$t, [string]$fix = '') { Mark 'MASALAH' $t $fix }

# @{ ok = $true; value = ... } atau @{ ok = $false; err = 'gak ada' / pesan }
function Read-Json([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return @{ ok = $false; err = 'gak ada' } }
  try {
    $raw = [System.IO.File]::ReadAllText($path, $utf8)
    # daftar JSON bisa jadi satu objek array (PowerShell 5.1) atau elemen-elemennya (7): pakai Items buat membacanya
    return @{ ok = $true; value = (ConvertFrom-Json -InputObject $raw); raw = $raw }
  } catch { return @{ ok = $false; err = ('gak kebaca: ' + $_.Exception.Message) } }
}
function Prop($o, [string]$n) {
  if ($o -is [System.Management.Automation.PSCustomObject]) { $p = $o.PSObject.Properties[$n]; if ($p) { return , $p.Value } }
  return $null
}
# Isi daftar sebagai elemen-elemen terpisah (buat foreach, pipe, @(...)): $null = kosong, objek tunggal = satu elemen.
function Items($v) {
  if ($null -eq $v) { return }
  if ($v -is [System.Collections.IEnumerable] -and $v -isnot [string] -and $v -isnot [System.Management.Automation.PSCustomObject]) { foreach ($x in $v) { $x }; return }
  $v
}
function Ago([long]$sec) {
  $s = [math]::Max(0, $Now - $sec)
  if ($s -lt 90) { return "$s dtk lalu" }
  if ($s -lt 5400) { return ([string][math]::Floor($s / 60) + ' mnt lalu') }
  if ($s -lt 172800) { return ([string][math]::Floor($s / 3600) + ' jam lalu') }
  return ([string][math]::Floor($s / 86400) + ' hari lalu')
}
function Quote-Arg([string]$a) {
  if ($a -eq '') { return '""' }
  if ($a -notmatch '[\s"]') { return $a }
  $a = [regex]::Replace($a, '(\\*)"', '$1$1\"')
  $a = [regex]::Replace($a, '(\\+)$', '$1$1')
  return '"' + $a + '"'
}
# Jalankan program dengan batas waktu, tanpa jendela. $null kalau gak bisa dijalankan.
function Run-Tool([string]$exe, [string[]]$argv, [int]$ms = 10000, $enc = $null) {
  $psi = [System.Diagnostics.ProcessStartInfo]::new($exe, ((@($argv) | ForEach-Object { Quote-Arg $_ }) -join ' '))
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  if ($enc) { $psi.StandardOutputEncoding = $enc }
  try { $p = [System.Diagnostics.Process]::Start($psi) } catch { return $null }
  $o = $p.StandardOutput.ReadToEndAsync()
  $e = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($ms)) { try { $p.Kill() } catch {}; return @{ code = -1; out = ''; err = 'timeout' } }
  return @{ code = $p.ExitCode; out = [string]$o.Result; err = [string]$e.Result }
}
function Same-Text([string]$a, [string]$b) {
  try { return ([System.IO.File]::ReadAllText($a).Replace("`r`n", "`n") -eq [System.IO.File]::ReadAllText($b).Replace("`r`n", "`n")) } catch { return $false }
}
function Find-Exe([string]$name) {
  $c = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Path } else { return $null }
}
# Sama dengan SKIP di updater.js: file yang memang gak diunduh/dipasang.
function Skip-File([string]$p) { return ($p -match '(\.d\.ts|jsconfig\.json|\.png|README\.md)$' -or $p -like '*company-music/*') }

function Check-System {
  Section 'Sistem'
  $os = [System.Environment]::OSVersion.VersionString
  Info ("$os, Windows PowerShell " + $PSVersionTable.PSVersion.ToString())
  $note = if ($env:HERDR_APP_HOME) { ' (dari HERDR_APP_HOME)' } else { '' }
  Info "folder Herdr: $Cfg$note"
}

function Check-Herdr {
  Section 'Herdr'
  if (-not (Test-Path -LiteralPath $Cfg -PathType Container)) { Bad "folder $Cfg gak ada" 'jalankan Herdr sekali, lalu install.cmd'; return $false }
  $exe = Find-Exe 'herdr-app'
  if (-not $exe) { Warn 'herdr-app gak ada di PATH, status Herdr gak bisa dicek'; return $true }
  $r = Run-Tool $exe @('--version')
  if ($r -and $r.code -eq 0 -and $r.out.Trim()) { Info (($r.out.Trim() -split "`n")[0].Trim()) }
  $r = Run-Tool $exe @('status')
  $st = $null
  if ($r -and $r.code -eq 0) { try { $st = ConvertFrom-Json -InputObject $r.out } catch {} }
  if ($st -isnot [System.Management.Automation.PSCustomObject]) { Info 'Herdr lagi gak jalan (herdr-app status gak menjawab)'; return $true }
  $layout = [string](Prop $st 'layout')
  if ($layout -eq 'pixel-hq') { Ok 'layout aktif: pixel-hq' } else { Warn "layout aktif: $layout" 'herdr-app do layout.switch --name pixel-hq' }
  $errs = @(Items (Prop $st 'errors'))
  if ($errs.Count) {
    foreach ($e in ($errs | Select-Object -First 8)) {
      $t = ConvertTo-Json -InputObject $e -Compress -Depth 4
      if ($t.Length -gt 300) { $t = $t.Substring(0, 300) }
      Bad "error Herdr: $t"
    }
  } else { Ok 'Herdr gak melaporkan error' }
  return $true
}

function Check-PixelHq {
  Section 'Pixel HQ'
  $agentsDir = Join-Path $Cfg 'mods\company-agents'
  $mine = Read-Json (Join-Path $agentsDir 'version.json')
  $mineVer = $null
  if ($mine.ok) { $mineVer = [string](Prop $mine.value 'version'); Info ("terpasang: $mineVer (" + [string](Prop $mine.value 'base') + ')') }
  else { Bad ('version.json terpasang ' + $mine.err) 'pasang lagi: install.cmd' }
  $sameDir = $false
  try { $sameDir = [System.IO.Path]::GetFullPath($Here).TrimEnd('\') -ieq [System.IO.Path]::GetFullPath($agentsDir).TrimEnd('\') } catch {}
  if (-not $sameDir) {
    $repo = Read-Json (Join-Path $Here 'version.json')
    if ($repo.ok) {
      $repoVer = [string](Prop $repo.value 'version')
      if ($mineVer -and $repoVer -ne $mineVer) { Warn "repo ini versi $repoVer, yang terpasang $mineVer" 'install.cmd' } else { Info "repo ini versi $repoVer" }
    }
  }
  $upd = Join-Path $agentsDir 'updater.js'
  $files = $null
  if (Test-Path -LiteralPath $upd -PathType Leaf) {
    $m = [regex]::Match([System.IO.File]::ReadAllText($upd, $utf8), 'const PIXEL_HQ_FILES = \[(.*?)\];', 'Singleline')
    if ($m.Success) { $files = @([regex]::Matches($m.Groups[1].Value, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Where-Object { -not (Skip-File $_) }) }
  }
  if ($null -eq $files) { Bad 'daftar file Pixel HQ (updater.js) gak kebaca' 'pasang lagi: install.cmd' }
  else {
    $missing = @($files | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Cfg ($_ -replace '/', '\'))) })
    if ($missing.Count) {
      $more = if ($missing.Count -gt 10) { ' ...' } else { '' }
      Bad ("$($missing.Count) file Pixel HQ gak ada: " + (($missing | Select-Object -First 10) -join ', ') + $more) 'pasang lagi (install.cmd) atau update dari tombol update'
    } else { Ok "$($files.Count) file Pixel HQ lengkap" }
  }
  if (Test-Path -LiteralPath (Join-Path $Cfg 'mods\company-music')) { Warn 'mod company-music (MusicBox) masih ada' 'install.cmd menghapusnya' }
}

function Check-Keys {
  Section 'Hotkey'
  $k = Read-Json (Join-Path $Cfg 'keys.json')
  if (-not $k.ok -and $k.err -eq 'gak ada') { Info 'keys.json belum ada (dibuat Herdr)'; return }
  if (-not $k.ok -or $k.value -isnot [System.Management.Automation.PSCustomObject]) {
    $why = if ($k.ok) { 'bukan objek JSON' } else { $k.err }
    Bad "keys.json $why" 'perbaiki atau hapus keys.json, lalu install.cmd'
    return
  }
  $sec = Prop $k.value 'layout:pixel-hq'
  foreach ($pair in @(@('ctrl-shift-j', 'mod.open:company-kanban'), @('ctrl-shift-m', 'mod.open:company-usage'))) {
    $name = $pair[1].Split(':')[1]
    if ([string](Prop $sec $pair[0]) -eq $pair[1]) { Ok "$($pair[0]) = $name" }
    else { Info "$($pair[0]) buat $name gak dipasang (dilewati installer kalau tombolnya udah kepake)" }
  }
}

function Check-Claude {
  Section 'Claude Code'
  $cdir = Join-Path $UserHome '.claude'
  if (-not (Test-Path -LiteralPath $cdir -PathType Container)) { Info '~/.claude gak ada: statusLine dan hook gak dipasang'; return }
  $s = Read-Json (Join-Path $cdir 'settings.json')
  if (-not $s.ok -and $s.err -eq 'gak ada') { Warn '~/.claude/settings.json gak ada: statusLine dan hook Pixel HQ belum terpasang' 'install.cmd'; return }
  if (-not $s.ok -or $s.value -isnot [System.Management.Automation.PSCustomObject]) {
    $why = if ($s.ok) { 'bukan objek JSON' } else { $s.err }
    Bad "~/.claude/settings.json $why"
    return
  }
  $sl = Prop $s.value 'statusLine'
  $cmd = if ($sl -is [System.Management.Automation.PSCustomObject]) { [string](Prop $sl 'command') } else { [string]$sl }
  if ($cmd -match 'pixel-hq-statusline\.ps1') {
    Ok "statusLine: $cmd"
    $copy = Join-Path $cdir 'pixel-hq-statusline.ps1'
    if (-not (Test-Path -LiteralPath $copy -PathType Leaf)) { Bad '~/.claude/pixel-hq-statusline.ps1 gak ada' 'buka Herdr (menyalinnya waktu start) atau install.cmd' }
    elseif (-not (Same-Text $copy (Join-Path $Cfg 'mods\company-agents\claude-statusline.ps1'))) { Info 'pixel-hq-statusline.ps1 beda dari versi mod (Herdr menyalin yang baru waktu start)' }
  } elseif ($cmd -match 'pixel-hq-statusline') {
    Warn "statusLine versi lama ($cmd), butuh sh dan Python" 'install.cmd menggantinya ke versi PowerShell'
  } elseif (-not $cmd) {
    Warn 'statusLine kosong: chip usage dan biaya per task gak keisi' 'install.cmd'
  } else { Info "statusLine punyamu sendiri ($cmd): chip usage butuh statusLine Pixel HQ" }

  $hooks = Prop $s.value 'hooks'
  $have = @(); $broken = @(); $python = $false
  foreach ($ev in $HookEvents) {
    $found = $false
    foreach ($g in @(Items (Prop $hooks $ev))) {
      foreach ($h in @(Items (Prop $g 'hooks'))) {
        $c = [string](Prop $h 'command')
        if ($c -match 'claude-activity\.ps1') {
          $found = $true
          $m = [regex]::Match($c, '"([^"]+claude-activity\.ps1)"')
          if ($m.Success -and -not (Test-Path -LiteralPath $m.Groups[1].Value -PathType Leaf)) { $broken += $m.Groups[1].Value }
        } elseif ($c -match 'claude-activity\.py') { $python = $true }
      }
    }
    if ($found) { $have += $ev }
  }
  if ($have.Count -eq $HookEvents.Count) { Ok "hook aktivitas terpasang ($($have.Count) event)" }
  elseif ($have.Count) { Warn ('hook aktivitas cuma sebagian: ' + (($HookEvents | Where-Object { $have -notcontains $_ }) -join ', ') + ' gak ada') 'install.cmd' }
  else { Warn 'hook aktivitas gak terpasang: HASIL dan PERLU JAWABAN di kanban gak jalan' 'install.cmd' }
  if ($python) { Warn 'masih ada hook versi Python (claude-activity.py), gak jalan di Windows tanpa Python' 'install.cmd memasang versi PowerShell; hapus yang Python dari settings.json' }
  foreach ($b in ($broken | Sort-Object -Unique)) { Bad "hook menunjuk ke file yang gak ada: $b" 'install.cmd' }
}

function Check-Data {
  Section 'Data'
  $u = Read-Json (Join-Path $State 'claude-usage.json')
  if (-not $u.ok -and $u.err -eq 'gak ada') { Warn 'claude-usage.json belum ada di Windows: statusLine Pixel HQ belum pernah jalan di sini' 'pakai Claude Code sekali di Herdr (kalau Claude-nya di WSL, lihat bagian WSL)' }
  elseif (-not $u.ok -or $u.value -isnot [System.Management.Automation.PSCustomObject]) { $why = if ($u.ok) { 'bukan objek JSON' } else { $u.err }; Bad "claude-usage.json $why" }
  else {
    $part = @()
    foreach ($pair in @(@('sesi', 'session'), @('minggu', 'week'))) {
      $used = Prop (Prop $u.value $pair[1]) 'used'
      if ($used -is [ValueType]) { $part += ($pair[0] + ' ' + [string][math]::Round([double]$used) + '%') }
    }
    $at = Prop $u.value 'at'
    $when = if ($at -is [ValueType]) { Ago ([long]$at) } else { '?' }
    $txt = if ($part.Count) { $part -join ', ' } else { '-' }
    Info "usage: $txt (ditulis $when)"
  }
  $h = Read-Json (Join-Path $State 'claude-usage-history.json')
  if ($h.ok -and $h.raw.TrimStart().StartsWith('[')) { Info ('riwayat usage: ' + @(Items $h.value).Count + ' titik') }
  $last = Join-Path $State 'last'
  if (Test-Path -LiteralPath $last -PathType Container) {
    $names = @(Get-ChildItem -LiteralPath $last -Filter '*.json' -File)
    if ($names.Count) {
      $newest = ($names | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc
      Info ("hasil kerja tersimpan: $($names.Count) terminal, terbaru " + (Ago ([DateTimeOffset]::new($newest).ToUnixTimeSeconds())))
    }
  }
  $b = Read-Json (Join-Path $Cfg 'pixel-hq-kanban.json')
  $tasks = @()
  if (-not $b.ok -and $b.err -eq 'gak ada') { Info 'papan kanban belum ada' }
  elseif (-not $b.ok -or $b.value -isnot [System.Management.Automation.PSCustomObject] -or -not $b.raw.Contains('"tasks"')) {
    $why = if ($b.ok) { 'formatnya salah' } else { $b.err }
    Bad "pixel-hq-kanban.json ${why}: mesin kanban berhenti" 'ekspor dulu kalau bisa, lalu perbaiki/hapus file itu'
  } else {
    $tasks = @(Items (Prop $b.value 'tasks') | Where-Object { $_ -is [System.Management.Automation.PSCustomObject] })
    $n = { param($f) @($tasks | Where-Object $f).Count }
    Info ('kanban: ' + (& $n { $_.column -eq 'todo' }) + ' antrean, ' + (& $n { $_.column -eq 'doing' -and -not $_.failed }) + ' jalan, ' +
      (& $n { $_.column -eq 'done' }) + ' selesai, ' + (& $n { $_.failed -and -not $_.stopped }) + ' gagal, ' +
      (& $n { $_.asking -and -not $_.failed }) + ' nanya balik, ' + (& $n { $_.held -and -not $_.failed }) + ' ditahan')
  }
  $inboxPath = Join-Path $Cfg 'pixel-hq-kanban-inbox.json'
  $i = Read-Json $inboxPath
  if ($i.ok -and $i.raw.TrimStart().StartsWith('[')) {
    $taken = [System.Collections.Generic.HashSet[string]]::new()
    if ($b.ok) { foreach ($x in @(Items (Prop $b.value 'imported'))) { if ($x -is [string]) { [void]$taken.Add($x) } } }
    foreach ($t in $tasks) { if ($t.id -is [string]) { [void]$taken.Add($t.id) } }
    $waiting = @(Items $i.value | Where-Object { $_ -is [System.Management.Automation.PSCustomObject] -and -not $taken.Contains([string]$_.id) })
    if ($waiting.Count) { Info "$($waiting.Count) task dari pixel-hq-task belum diambil (Herdr mengambilnya waktu jalan)" }
  }
}

function Check-Terminal {
  Section 'Perintah terminal'
  $c = Get-Command 'pixel-hq-task' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { Ok ('pixel-hq-task: ' + $c.Source) } else { Info 'pixel-hq-task gak ada di PATH (install.cmd memasangnya ke WindowsApps)' }
  try { Info ('ExecutionPolicy: ' + (Get-ExecutionPolicy).ToString() + ' (skrip Pixel HQ jalan dengan -ExecutionPolicy Bypass)') } catch {}
}

function Check-Wsl {
  Section 'WSL'
  $wsl = Find-Exe 'wsl.exe'
  if (-not $wsl) { Info 'wsl.exe gak ada: WSL gak dipakai'; return }
  # --list gak menyalakan WSL; keluarannya UTF-16
  $all = Run-Tool $wsl @('--list', '--quiet') 8000 ([System.Text.Encoding]::Unicode)
  if (-not $all -or $all.code -ne 0) { Info 'WSL belum terpasang atau gak punya distro'; return }
  $names = @($all.out.Replace([string][char]0, '') -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[\w.-]+$' })
  if (-not $names.Count) { Info 'WSL gak punya distro'; return }
  $run = Run-Tool $wsl @('--list', '--running', '--quiet') 8000 ([System.Text.Encoding]::Unicode)
  $running = @()
  if ($run -and $run.code -eq 0) { $running = @($run.out.Replace([string][char]0, '') -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[\w.-]+$' }) }
  Info ('distro: ' + ($names -join ', ') + '; yang lagi jalan: ' + $(if ($running.Count) { $running -join ', ' } else { '-' }))
  foreach ($d in $running) {
    if ($d -match '^docker-desktop') { continue }
    $r = Run-Tool $wsl @('-d', $d, '-e', 'sh', '-c', 'stat -c %Y "$HOME/.local/state/pixel-hq/claude-usage.json" 2>/dev/null') 8000
    if ($r -and $r.code -eq 0 -and $r.out.Trim() -match '^\d+$') { Info "${d}: claude-usage.json ditulis $(Ago ([long]$r.out.Trim())) (Herdr membacanya dari sini juga)" }
    else { Info "${d}: belum ada claude-usage.json (Claude Code gak dipakai di distro ini, atau statusLine-nya bukan Pixel HQ)" }
  }
  if (-not $running.Count) { Info 'gak ada distro yang jalan: Herdr gak membaca WSL (dan gak menyalakannya)' }
}

Say ('Pixel HQ doctor (Windows) - ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Check-System
if (Check-Herdr) {
  Check-PixelHq
  Check-Keys
}
Check-Claude
Check-Data
Check-Terminal
Check-Wsl
Say
Say "Ringkasan: $($script:problems) masalah, $($script:warnings) peringatan"
Say 'Laporan ini gak berisi isi task, balasan agent, atau isi settings.json selain bagian Pixel HQ.'
$text = ($script:lines -join "`r`n") + "`r`n"
$path = Join-Path $UserHome ('pixel-hq-doctor-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
try { [System.IO.File]::WriteAllText($path, $text, $utf8); $saved = 'Disimpan ke ' + (Hide $path) } catch { $saved = 'Gagal menyimpan laporan: ' + $_.Exception.Message }
try { Set-Clipboard -Value $text; $saved += ' (juga disalin ke clipboard)' } catch {}
Write-Host $text
Write-Host $saved
exit 0
