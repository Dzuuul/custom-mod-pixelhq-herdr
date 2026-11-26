# Uji skrip Windows di folder home tiruan (Herdr dan Claude Code asli gak disentuh), di Windows PowerShell 5.1:
# sintaks semua .ps1, ASCII/CRLF, install.ps1, statusLine, hook Stop, pixel-hq-task, doctor, -Restore, uninstall.cmd -Purge.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\windows.ps1
# Dijalankan otomatis oleh GitHub Actions (.github/workflows/tes.yml) di runner Windows.
# File ini sengaja ASCII saja: Windows PowerShell 5.1 membaca skrip tanpa BOM sebagai ANSI.
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$Root = Split-Path -Parent $PSScriptRoot
$script:fails = 0

function Check([string]$name, [bool]$cond, $detail = $null) {
  if ($cond) { Write-Host "ok    $name"; return }
  Write-Host "GAGAL $name" -ForegroundColor Red
  $script:fails++
  if ($null -ne $detail) {
    if ($detail -is [System.Collections.IDictionary]) { Write-Host "      exit $($detail.code)"; Write-Host $detail.out; Write-Host $detail.err }
    else { Write-Host ([string]$detail) }
  }
}
function Quote-Arg([string]$a) {
  if ($a -eq '') { return '""' }
  if ($a -notmatch '[\s"]') { return $a }
  $a = [regex]::Replace($a, '(\\*)"', '$1$1\"')
  $a = [regex]::Replace($a, '(\\+)$', '$1$1')
  return '"' + $a + '"'
}
# Jalankan program, kirim $stdin (byte) ke masukannya, tunggu (maks $ms). Hasil: @{ code; out; err }.
function Invoke-Tool([string]$exe, [string[]]$argv = @(), [byte[]]$stdin = $null, [int]$ms = 180000) {
  $psi = [System.Diagnostics.ProcessStartInfo]::new($exe, ((@($argv) | ForEach-Object { Quote-Arg $_ }) -join ' '))
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardInput = $true
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = $utf8
  $p = [System.Diagnostics.Process]::Start($psi)
  $o = $p.StandardOutput.ReadToEndAsync()
  $e = $p.StandardError.ReadToEndAsync()
  if ($stdin) { $p.StandardInput.BaseStream.Write($stdin, 0, $stdin.Length) }
  $p.StandardInput.Close()
  if (-not $p.WaitForExit($ms)) { try { $p.Kill() } catch {}; return @{ code = -1; out = ''; err = 'timeout' } }
  $p.WaitForExit()
  return @{ code = $p.ExitCode; out = [string]$o.Result; err = [string]$e.Result }
}
function Invoke-Ps([string]$file, [string[]]$argv = @(), [byte[]]$stdin = $null) {
  return Invoke-Tool 'powershell.exe' (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $file) + $argv) $stdin
}
function Read-Json([string]$path) { return ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($path, $utf8)) }
function Hook-Commands($settings, [string]$ev) {
  $out = @()
  $hooks = $settings.PSObject.Properties['hooks']
  if (-not $hooks) { return $out }
  $list = $hooks.Value.PSObject.Properties[$ev]
  if (-not $list) { return $out }
  foreach ($g in @($list.Value)) { foreach ($h in @($g.hooks)) { $out += [string]$h.command } }
  return $out
}
function Has-Prop($o, [string]$n) { return [bool]($o -is [System.Management.Automation.PSCustomObject] -and $o.PSObject.Properties[$n]) }

Write-Host '== sintaks dan encoding skrip Windows'
$tracked = @(& git -C $Root ls-files '*.ps1' '*.cmd')
Check 'skrip Windows ketemu' ($tracked.Count -ge 8) ($tracked -join ', ')
foreach ($f in $tracked) {
  $path = Join-Path $Root $f
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $lf = 0; $crlf = 0; $high = 0
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    if ($bytes[$i] -gt 127) { $high++ }
    if ($bytes[$i] -eq 10) { $lf++; if ($i -gt 0 -and $bytes[$i - 1] -eq 13) { $crlf++ } }
  }
  Check "${f}: ASCII dan CRLF" ($high -eq 0 -and $lf -eq $crlf) "non-ASCII $high, LF $lf, CRLF $crlf"
  if ($f -like '*.ps1') {
    $tokens = $null; $errs = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errs)
    Check "${f}: sintaks PowerShell" (@($errs).Count -eq 0) ((@($errs) | ForEach-Object { "baris $($_.Extent.StartLineNumber): $($_.Message)" }) -join "`n")
  }
}

# home tiruan: USERPROFILE, LOCALAPPDATA (WindowsApps buat pixel-hq-task), PATH-nya
# RUNNER_TEMP di GitHub Actions: TEMP biasa di sana pakai nama pendek 8.3 (RUNNER~1), beda dari jalur yang dilihat skrip
$tmpRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$F = Join-Path $tmpRoot ('pixelhq-tes-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$Cfg = Join-Path $F '.config\herdr-app'
$Apps = Join-Path $F 'AppData\Local\Microsoft\WindowsApps'
foreach ($d in $Cfg, (Join-Path $F '.claude'), $Apps) { [void][System.IO.Directory]::CreateDirectory($d) }
$Keys0 = '{"global":{"ctrl-shift-m":"app.palette"}}' + "`n"
$Set0 = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo punyaku"}]}]}}' + "`n"
[System.IO.File]::WriteAllText((Join-Path $Cfg 'keys.json'), $Keys0, $utf8)
[System.IO.File]::WriteAllText((Join-Path $F '.claude\settings.json'), $Set0, $utf8)
$env:USERPROFILE = $F
$env:LOCALAPPDATA = Join-Path $F 'AppData\Local'
$env:Path = "$Apps;" + $env:Path
Remove-Item Env:HERDR_APP_HOME -ErrorAction SilentlyContinue
Remove-Item Env:HC_TERMINAL_ID -ErrorAction SilentlyContinue
$Settings = Join-Path $F '.claude\settings.json'
$StateDir = Join-Path $F '.local\state\pixel-hq'

try {
  Write-Host '== install.ps1'
  $r = Invoke-Ps (Join-Path $Root 'install.ps1')
  Check 'install.ps1 keluar 0' ($r.code -eq 0) $r
  Check 'backup dibuat' (@(Get-ChildItem (Join-Path $F 'backups\herdr') -Filter 'sebelum-custom-pixelhq-*.zip' -ErrorAction SilentlyContinue).Count -eq 1) $r
  Check 'mod, layout, tema disalin' ((Test-Path (Join-Path $Cfg 'mods\company-kanban\main.js')) -and (Test-Path (Join-Path $Cfg 'layouts\pixel-hq.json')) -and (Test-Path (Join-Path $Cfg 'themes\pixel-hq.json')))
  $s = Read-Json $Settings
  Check 'statusLine dipasang' ((Has-Prop $s 'statusLine') -and [string]$s.statusLine.command -match 'pixel-hq-statusline\.ps1') ([System.IO.File]::ReadAllText($Settings))
  $stop = Hook-Commands $s 'Stop'
  Check 'hook aktivitas dipasang, hook punyamu tetap' ((@($stop | Where-Object { $_ -match 'claude-activity\.ps1"? stop$' }).Count -eq 1) -and ($stop -contains 'echo punyaku')) ($stop -join "`n")
  $events = @('PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd')
  $once = @($events | Where-Object { $ev = $_; @(Hook-Commands $s $ev | Where-Object { $_ -match 'claude-activity\.ps1' }).Count -eq 1 })
  Check 'hook dipasang sekali di tiap 9 event' ($once.Count -eq 9) ($once -join ', ')
  $k = Read-Json (Join-Path $Cfg 'keys.json')
  Check 'hotkey Kanban dipasang, Usage dilewati (ctrl-shift-m udah kepake)' ((Has-Prop $k 'layout:pixel-hq') -and $k.'layout:pixel-hq'.'ctrl-shift-j' -eq 'mod.open:company-kanban' -and -not (Has-Prop $k.'layout:pixel-hq' 'ctrl-shift-m') -and $k.global.'ctrl-shift-m' -eq 'app.palette') ([System.IO.File]::ReadAllText((Join-Path $Cfg 'keys.json')))
  $shim = Join-Path $Apps 'pixel-hq-task.cmd'
  Check 'pixel-hq-task dipasang ke WindowsApps' ((Test-Path $shim) -and ([System.IO.File]::ReadAllText($shim) -match 'dipasang custom Pixel HQ')) $r

  Start-Sleep -Seconds 2
  $r = Invoke-Ps (Join-Path $Root 'install.ps1')
  Check 'install.ps1 kedua kali keluar 0' ($r.code -eq 0) $r
  Check 'install kedua kali gak mendobel hook' (@(Hook-Commands (Read-Json $Settings) 'Stop' | Where-Object { $_ -match 'claude-activity\.ps1' }).Count -eq 1)

  Write-Host '== statusLine dan hook'
  $status = '{"model":{"display_name":"Opus 5.5"},"context_window":{"used_percentage":12},"rate_limits":{"five_hour":{"used_percentage":42,"resets_at":1999999999},"seven_day":{"used_percentage":7,"resets_at":1999999999}},"cost":{"total_cost_usd":0.25},"workspace":{"current_dir":"C:\\proyek\\api"}}'
  $r = Invoke-Ps (Join-Path $F '.claude\pixel-hq-statusline.ps1') @() $utf8.GetBytes($status)
  Check 'statusLine keluar 0 dan mencetak model' ($r.code -eq 0 -and $r.out -match 'Opus 5\.5') $r
  $usage = Join-Path $StateDir 'claude-usage.json'
  Check 'claude-usage.json ditulis' ((Test-Path $usage) -and (Read-Json $usage).session.used -eq 42 -and (Read-Json $usage).week.used -eq 7) $r
  $hist = Join-Path $StateDir 'claude-usage-history.json'
  Check 'riwayat usage ditulis' ((Test-Path $hist) -and [System.IO.File]::ReadAllText($hist).Trim() -match '^\[\[\d+,42,7\]\]$') $(if (Test-Path $hist) { [System.IO.File]::ReadAllText($hist) })
  $check = [string][char]0x2713
  $env:HC_TERMINAL_ID = 't1'
  $payload = '{"hook_event_name":"Stop","last_assistant_message":"Udah beres ' + $check + '. Mau lanjut?"}'
  $r = Invoke-Ps (Join-Path $Cfg 'mods\company-agents\claude-activity.ps1') @('stop') $utf8.GetBytes($payload)
  $last = Join-Path $StateDir 'last\t1.json'
  Check 'hook Stop menyimpan balasan terakhir (dengan huruf non-ASCII)' ($r.code -eq 0 -and (Test-Path $last) -and (Read-Json $last).text -eq "Udah beres $check. Mau lanjut?") $r
  # hook Stop yang dipasang versi lama (aksi turn-end) tetap menyimpan balasan
  $env:HC_TERMINAL_ID = 't2'
  $r = Invoke-Ps (Join-Path $Cfg 'mods\company-agents\claude-activity.ps1') @('turn-end') $utf8.GetBytes('{"hook_event_name":"Stop","last_assistant_message":"Kelar."}')
  Check 'hook Stop versi lama tetap menyimpan balasan' ($r.code -eq 0 -and (Test-Path (Join-Path $StateDir 'last\t2.json'))) $r
  Remove-Item Env:HC_TERMINAL_ID

  Write-Host '== pixel-hq-task'
  $inbox = Join-Path $Cfg 'pixel-hq-kanban-inbox.json'
  $r = Invoke-Tool $shim @('-Kerjakan', '-Model', 'sonnet', '-Batas', '30', '-Hentikan', 'Tes dari CI')
  Check 'pixel-hq-task lewat pemanggil di WindowsApps' ($r.code -eq 0 -and (Test-Path $inbox)) $r
  # -E, -P: singkatan yang bentrok dengan -ErrorAction, -PipelineVariable kalau gak ada alias
  $r = Invoke-Tool $shim @('-Stdin', '-E', 'high', '-P', 'tinggi', 'Kedua') $utf8.GetBytes("isi detail $check")
  Check 'pixel-hq-task -Stdin dan singkatan -E -P' ($r.code -eq 0) $r
  # "-" sendirian ditolak powershell.exe -File (kode 5 tanpa pesan): kedua pemanggil .cmd menjelaskannya
  foreach ($cmdFile in @($shim, (Join-Path $Cfg 'mods\company-kanban\pixel-hq-task.cmd'))) {
    $r = Invoke-Tool $cmdFile @('-D', '-', 'x') $utf8.GetBytes('x')
    Check ((Split-Path -Leaf (Split-Path -Parent $cmdFile)) + '\pixel-hq-task.cmd: "-D -" dijelaskan, gak gagal diam-diam') ($r.code -eq 5 -and ($r.out + $r.err) -match '-Stdin') $r
  }
  $r = Invoke-Tool $shim @('-D', 'teks', '-Stdin', 'x')
  Check '-Detail TEKS bareng -Stdin ditolak (exit 2)' ($r.code -eq 2) $r
  $raw = [System.IO.File]::ReadAllText($inbox, $utf8)
  $list = @(ConvertFrom-Json -InputObject $raw | ForEach-Object { $_ })
  Check 'dua task masuk inbox, yang pertama gak hilang' ($list.Count -eq 2 -and $list[0].title -eq 'Tes dari CI' -and $list[0].column -eq 'doing' -and $list[0].model -eq 'sonnet' -and $list[0].limitMin -eq 30 -and $list[0].limitStop -eq $true -and $list[1].detail -eq "isi detail $check" -and $list[1].effort -eq 'high' -and $list[1].priority -eq 'tinggi') $raw
  # yang udah diambil Herdr (tercatat di papan) dibuang dari inbox; pakai PATH (cmd.exe mencari pixel-hq-task.cmd)
  [System.IO.File]::WriteAllText((Join-Path $Cfg 'pixel-hq-kanban.json'), ('{"tasks":[],"imported":["' + $list[0].id + '"]}'), $utf8)
  $r = Invoke-Tool 'cmd.exe' @('/c', 'pixel-hq-task', 'Ketiga')
  $raw = [System.IO.File]::ReadAllText($inbox, $utf8)
  $list = @(ConvertFrom-Json -InputObject $raw | ForEach-Object { $_ })
  Check 'pixel-hq-task dari PATH, yang udah diambil dibuang' ($r.code -eq 0 -and $list.Count -eq 2 -and $list[0].title -eq 'Kedua' -and $list[1].title -eq 'Ketiga') "$($r.out)`n$($r.err)`n$raw"
  $r = Invoke-Tool $shim @('-Model', 'gpt', 'x')
  Check 'model salah ditolak (exit 2)' ($r.code -eq 2) $r
  # pilihan 2.3: cek, batas biaya, worktree, jadwal
  $r = Invoke-Tool $shim @('-Cek', 'npm test', '-Biaya', '1.5', '-Hentikan', '-Worktree', '-Jam', '7:30', '-Ulang', 'kerja', 'Keempat')
  $raw = [System.IO.File]::ReadAllText($inbox, $utf8)
  $list = @(ConvertFrom-Json -InputObject $raw | ForEach-Object { $_ })
  $last = $list[$list.Count - 1]
  Check 'pixel-hq-task -Cek -Biaya -Hentikan -Worktree -Jam -Ulang' ($r.code -eq 0 -and $last.title -eq 'Keempat' -and $last.check -eq 'npm test' -and $last.costMax -eq 1.5 -and $last.limitStop -eq $true -and $last.worktree -eq $true -and $last.atTime -eq '07:30' -and $last.repeat -eq 'kerja' -and $last.column -eq 'todo') "$($r.out)`n$($r.err)`n$raw"
  $r = Invoke-Tool $shim @('-Kerjakan', '-Jam', '09:00', 'x')
  Check '-Kerjakan bareng -Jam ditolak (exit 2)' ($r.code -eq 2) $r
  $r = Invoke-Tool $shim @('-Hentikan', 'x')
  Check '-Hentikan tanpa -Batas/-Biaya ditolak (exit 2)' ($r.code -eq 2) $r
  $r = Invoke-Tool $shim @('-Jam', '25:00', 'x')
  Check '-Jam salah ditolak (exit 2)' ($r.code -eq 2) $r

  Write-Host '== doctor'
  $r = Invoke-Ps (Join-Path $Cfg 'mods\company-agents\pixel-hq-doctor.ps1')
  Check 'doctor keluar 0' ($r.code -eq 0) $r
  Check 'doctor: 0 masalah' ($r.out -match 'Ringkasan: 0 masalah') $r
  Check 'doctor menyimpan laporan' (@(Get-ChildItem $F -Filter 'pixel-hq-doctor-*.txt').Count -ge 1)
  Check 'doctor menyembunyikan folder home' (-not $r.out.Contains($F)) $r
  Check 'doctor melihat hook dan statusLine' ($r.out -match 'hook aktivitas terpasang \(9 event\)' -and $r.out -match 'statusLine: ') $r
  $r = Invoke-Tool (Join-Path $Root 'doctor.cmd') @() $utf8.GetBytes("`r`n")
  Check 'doctor.cmd di folder repo jalan' ($r.code -eq 0 -and $r.out -match 'Ringkasan: ') $r

  Write-Host '== uninstall.ps1 -Restore (ke kondisi sebelum install pertama)'
  $first = Get-ChildItem (Join-Path $F 'backups\herdr') -Filter 'sebelum-custom-pixelhq-*.zip' | Sort-Object Name | Select-Object -First 1
  $r = Invoke-Ps (Join-Path $Root 'uninstall.ps1') @('-Restore', $first.FullName)
  Check 'restore keluar 0' ($r.code -eq 0) $r
  Check 'keys.json kembali persis' ([System.IO.File]::ReadAllText((Join-Path $Cfg 'keys.json'), $utf8) -eq $Keys0)
  Check 'settings.json kembali persis' ([System.IO.File]::ReadAllText($Settings, $utf8) -eq $Set0) ([System.IO.File]::ReadAllText($Settings, $utf8))
  Check 'mod Pixel HQ hilang' (@(Get-ChildItem (Join-Path $Cfg 'mods') -Directory -Filter 'company-*' -ErrorAction SilentlyContinue).Count -eq 0)
  Check 'pixel-hq-task dicopot' (-not (Test-Path $shim))

  Write-Host '== uninstall.cmd -Purge'
  $r = Invoke-Ps (Join-Path $Root 'install.ps1')
  Check 'pasang lagi keluar 0' ($r.code -eq 0) $r
  [System.IO.File]::WriteAllText((Join-Path $Cfg 'pixel-hq-kanban-history.json'), '{"v":1,"runs":[]}', $utf8)
  [System.IO.File]::WriteAllText((Join-Path $Cfg 'pixel-hq-kanban-templates.json'), '{"templates":[]}', $utf8)
  $r = Invoke-Tool (Join-Path $Root 'uninstall.cmd') @('-Purge') $utf8.GetBytes("`r`n")
  Check 'uninstall.cmd -Purge keluar 0' ($r.code -eq 0) $r
  Check 'mod, layout, tema dihapus' ((@(Get-ChildItem (Join-Path $Cfg 'mods') -Directory -Filter 'company-*' -ErrorAction SilentlyContinue).Count -eq 0) -and -not (Test-Path (Join-Path $Cfg 'layouts\pixel-hq.json')) -and -not (Test-Path (Join-Path $Cfg 'themes\pixel-hq.json')))
  $s = Read-Json $Settings
  Check 'statusLine dan hook Pixel HQ dicabut, hook punyamu tetap' (-not (Has-Prop $s 'statusLine') -and ((Hook-Commands $s 'Stop') -join '|') -eq 'echo punyaku') ([System.IO.File]::ReadAllText($Settings))
  Check 'hotkey dicabut' (-not (Has-Prop (Read-Json (Join-Path $Cfg 'keys.json')) 'layout:pixel-hq'))
  Check 'data dihapus (termasuk rekap dan template)' (-not (Test-Path $inbox) -and -not (Test-Path (Join-Path $Cfg 'pixel-hq-kanban.json')) -and -not (Test-Path $StateDir) -and -not (Test-Path (Join-Path $Cfg 'pixel-hq-kanban-history.json')) -and -not (Test-Path (Join-Path $Cfg 'pixel-hq-kanban-templates.json')))
  Check 'pixel-hq-task dicopot' (-not (Test-Path $shim))
  Check 'backup sebelum copot dibuat' (@(Get-ChildItem (Join-Path $F 'backups\herdr') -Filter 'sebelum-uninstall-pixelhq-*.zip').Count -ge 1)
} catch {
  Write-Host ('GAGAL tes berhenti: ' + $_.Exception.Message + ' (baris ' + $_.InvocationInfo.ScriptLineNumber + ')') -ForegroundColor Red
  $script:fails++
} finally {
  Remove-Item -LiteralPath $F -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($script:fails) { Write-Host "$($script:fails) gagal." -ForegroundColor Red; exit 1 }
Write-Host 'Semua lolos.'
exit 0
