# pixel-hq-task versi Windows (PowerShell 5.1): tambah task ke papan kanban Pixel HQ dari terminal, skrip, atau agent.
#   pixel-hq-task "Judul task"                                   masuk Antrean
#   pixel-hq-task -Kerjakan "Judul" -Detail "detail"             langsung Sedang dikerjakan (dikirim ke staf yang nganggur)
#   pixel-hq-task -Space api -Model sonnet -Effort high -Prioritas tinggi -Batas 30 -Hentikan "Judul"
#   git diff | pixel-hq-task -Kerjakan -Stdin "Review perubahan ini"     detail dibaca dari stdin
#   pixel-hq-task -Kerjakan -Cek "npm test" -Biaya 2 -Worktree "Judul"   cek setelah kelar, batas biaya, worktree sendiri
#   pixel-hq-task -Jam 09:00 -Ulang kerja "Cek dependensi"              jadwal tiap hari kerja jam 09:00
# Bukan "-Detail -" seperti versi Linux: powershell.exe -File (yang dipakai pixel-hq-task.cmd) gak bisa menerima
# argumen "-" sendirian, prosesnya langsung keluar dengan kode 5 tanpa pesan sebelum skrip ini jalan.
# Kalau skrip ini dipanggil langsung dari PowerShell, "-Detail -" tetap diterima.
# Nama pilihan boleh disingkat: -K, -D, -S, -M, -E, -P, -B, -H. Singkatannya alias tetap: tanpa itu -D, -E, dan -P
# bentrok dengan -Debug, -ErrorAction, dan -PipelineVariable bawaan PowerShell.
# Pilihan 2.3 (-Cek, -Biaya, -Worktree, -Jam, -Ulang) ditulis lengkap: -W bentrok dengan -WarningAction.
# Sama dengan pixel-hq-task.py: cuma menulis pixel-hq-kanban-inbox.json di folder Herdr; mesin kanban (status bar
# Pixel HQ) mengambilnya dalam beberapa detik, atau waktu Herdr dibuka lagi. Papan kanban sendiri gak disentuh.
# File ini sengaja ASCII saja: Windows PowerShell 5.1 membaca skrip tanpa BOM sebagai ANSI.
param(
  [Parameter(Position = 0)][string]$Judul = '',
  [Alias('D')][string]$Detail = '',
  [Alias('S')][string]$Space = '',
  [Alias('K')][switch]$Kerjakan,
  [Alias('M')][string]$Model = '',
  [Alias('E')][string]$Effort = '',
  [Alias('P')][string]$Prioritas = 'normal',
  [Alias('B')][int]$Batas = 0,
  [Alias('H')][switch]$Hentikan,
  [switch]$Stdin,
  [string]$Cek = '',
  [double]$Biaya = 0,
  [switch]$Worktree,
  [string]$Jam = '',
  [string]$Ulang = ''
)
$ErrorActionPreference = 'Stop'

function Show-Usage {
  Write-Host 'pakai: pixel-hq-task [-Kerjakan] [-Detail TEKS | -Stdin] [-Space NAMA] [-Model opus|sonnet|haiku|fable]'
  Write-Host '                     [-Effort low|medium|high|xhigh|max] [-Prioritas tinggi|normal|rendah]'
  Write-Host '                     [-Batas MENIT] [-Biaya USD] [-Hentikan] [-Cek PERINTAH] [-Worktree]'
  Write-Host '                     [-Jam HH:MM [-Ulang harian|kerja]] "Judul task"'
  Write-Host 'Tanpa -Space: space terminal Herdr tempat perintah ini jalan, kalau bukan di Herdr: space yang lagi dibuka.'
  Write-Host '-Cek: dijalankan di folder agent setelah dia berhenti (mis. "npm test"); gagal = agent disuruh benerin, sampai 3x.'
  Write-Host '-Hentikan: lewat batas waktu/biaya = agent dihentikan. -Worktree: agent baru di git worktree dan branch sendiri.'
}
function Stop-Usage([string]$msg) { Write-Host "pixel-hq-task: $msg" -ForegroundColor Red; Show-Usage; exit 2 }

$Models = @('opus', 'sonnet', 'haiku', 'fable')
$Efforts = @('low', 'medium', 'high', 'xhigh', 'max')
$title = $Judul.Trim()
if (-not $title -or $title -in @('-h', '--help', '/?', '-?')) { Show-Usage; exit $(if ($title) { 0 } else { 2 }) }
if ($Model -and $Model -notin $Models) { Stop-Usage "model '$Model' gak dikenal (pilih: $($Models -join ', '))" }
if ($Effort -and $Effort -notin $Efforts) { Stop-Usage "effort '$Effort' gak dikenal (pilih: $($Efforts -join ', '))" }
if ($Prioritas -notin @('tinggi', 'normal', 'rendah')) { Stop-Usage "prioritas '$Prioritas' gak dikenal (pilih: tinggi, normal, rendah)" }
if ($PSBoundParameters.ContainsKey('Batas') -and ($Batas -lt 1 -or $Batas -gt 1440)) { Stop-Usage '-Batas harus 1 sampai 1440 menit' }
if ($PSBoundParameters.ContainsKey('Biaya') -and ($Biaya -lt 0.01 -or $Biaya -gt 1000)) { Stop-Usage '-Biaya harus 0.01 sampai 1000 dolar' }
if ($Hentikan -and -not $PSBoundParameters.ContainsKey('Batas') -and -not $PSBoundParameters.ContainsKey('Biaya')) { Stop-Usage '-Hentikan butuh -Batas atau -Biaya' }
$clock = ''
if ($Jam) {
  if ($Jam -notmatch '^\s*(\d{1,2})[:.](\d{2})\s*$' -or [int]$Matches[1] -gt 23 -or [int]$Matches[2] -gt 59) { Stop-Usage '-Jam pakai format HH:MM, mis. 22:00' }
  $clock = ('{0:D2}:{1}' -f [int]$Matches[1], $Matches[2])
}
if ($Ulang -and $Ulang -notin @('harian', 'kerja')) { Stop-Usage "ulang '$Ulang' gak dikenal (pilih: harian, kerja)" }
if ($Ulang -and -not $clock) { Stop-Usage '-Ulang butuh -Jam' }
if ($clock -and $Kerjakan) { Stop-Usage '-Kerjakan gak bisa bareng -Jam (task berjadwal nunggu di Antrean sampai jamnya)' }
if ($Stdin -and $Detail -and $Detail -ne '-') { Stop-Usage 'pilih salah satu: -Detail TEKS atau -Stdin' }
# stdin dibaca sebagai UTF-8 dari aliran mentahnya (gak tergantung code page konsol), sama dengan statusLine dan hook
if ($Stdin -or $Detail -eq '-') {
  $Detail = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false)).ReadToEnd()
}

$Cfg = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $env:USERPROFILE '.config\herdr-app' }
if (-not (Test-Path -LiteralPath $Cfg -PathType Container)) {
  Write-Host "Folder Herdr $Cfg gak ada. Jalanin Herdr sekali dulu (atau set HERDR_APP_HOME)." -ForegroundColor Red
  exit 1
}
$utf8 = [System.Text.UTF8Encoding]::new($false)
function Read-Text([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return '' }
  try { return [System.IO.File]::ReadAllText($path, $utf8) } catch { return '' }
}

$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$digits = '0123456789abcdefghijklmnopqrstuvwxyz'
$n = [long]$nowMs; $id = ''
while ($n -gt 0) { $id = [string]$digits[[int]($n % 36)] + $id; $n = [long][Math]::Floor($n / 36) }
$rnd = [System.Random]::new()
$id = 'c' + $id + (-join (1..3 | ForEach-Object { $digits[$rnd.Next(36)] }))

$entry = [ordered]@{ id = $id; title = $(if ($title.Length -gt 2000) { $title.Substring(0, 2000) } else { $title }); created = $nowMs; column = $(if ($Kerjakan) { 'doing' } else { 'todo' }) }
$d = $Detail.Trim()
if ($d) { $entry['detail'] = $(if ($d.Length -gt 8000) { $d.Substring(0, 8000) } else { $d }) }
if ($Space.Trim()) { $entry['spaceName'] = $Space.Trim() }
if ($env:HC_TERMINAL_ID) { $entry['fromTerminal'] = $env:HC_TERMINAL_ID }
if ($Model) { $entry['model'] = $Model }
if ($Effort) { $entry['effort'] = $Effort }
if ($Prioritas -ne 'normal') { $entry['priority'] = $Prioritas }
if ($PSBoundParameters.ContainsKey('Batas')) { $entry['limitMin'] = $Batas }
if ($PSBoundParameters.ContainsKey('Biaya')) { $entry['costMax'] = [Math]::Round($Biaya, 2) }
if ($Hentikan) { $entry['limitStop'] = $true }
$c = $Cek.Trim()
if ($c) { $entry['check'] = $(if ($c.Length -gt 500) { $c.Substring(0, 500) } else { $c }) }
if ($Worktree) { $entry['worktree'] = $true }
if ($clock) { $entry['atTime'] = $clock; if ($Ulang) { $entry['repeat'] = $Ulang } }

$inbox = Join-Path $Cfg 'pixel-hq-kanban-inbox.json'
# kunci biar dua perintah barengan gak saling timpa
$lock = [System.Threading.Mutex]::new($false, 'Local\PixelHqKanbanInbox')
$held = $false
try {
  # pemegang sebelumnya mati tanpa melepas kunci (AbandonedMutexException) = kuncinya tetap jadi milik kita
  try { $held = $lock.WaitOne(10000) } catch { $held = ($_.Exception -is [System.Threading.AbandonedMutexException]) -or ($_.Exception.InnerException -is [System.Threading.AbandonedMutexException]) }
  if (-not $held) { Write-Host 'Inbox kanban lagi dipakai perintah lain, coba lagi.' -ForegroundColor Red; exit 1 }
  # PowerShell 5.1 mengeluarkan array JSON sebagai SATU objek, jadi @(ConvertFrom-Json ...) berisi satu array dan
  # semua task yang belum diambil ikut terbuang. Lewat pipe ke ForEach-Object isinya dibuka, di 5.1 maupun 7.
  $raw = Read-Text $inbox
  $list = [System.Collections.ArrayList]::new()
  if ($raw.TrimStart().StartsWith('[')) { try { foreach ($e in @(ConvertFrom-Json -InputObject $raw | ForEach-Object { $_ })) { [void]$list.Add($e) } } catch {} }
  # buang yang udah diambil Herdr (tercatat di papan) dan yang udah seminggu gak diambil
  $taken = [System.Collections.Generic.HashSet[string]]::new()
  $board = $null
  try { $board = ConvertFrom-Json -InputObject (Read-Text (Join-Path $Cfg 'pixel-hq-kanban.json')) } catch {}
  if ($board -is [System.Management.Automation.PSCustomObject]) {
    foreach ($x in @($board.imported)) { if ($x -is [string]) { [void]$taken.Add($x) } }
    foreach ($t in @($board.tasks)) { if ($t -and $t.id -is [string]) { [void]$taken.Add($t.id) } }
  }
  $keep = [System.Collections.ArrayList]::new()
  foreach ($e in $list) {
    if ($e -isnot [System.Management.Automation.PSCustomObject] -or $e.id -isnot [string]) { continue }
    if ($taken.Contains($e.id)) { continue }
    $age = $nowMs - $(if ($e.created -is [ValueType]) { [long]$e.created } else { 0 })
    if ($age -ge 7 * 86400 * 1000) { continue }
    [void]$keep.Add($e)
  }
  [void]$keep.Add([pscustomobject]$entry)
  $json = ConvertTo-Json -InputObject $keep.ToArray() -Depth 6
  $tmp = "$inbox.tmp.$PID"
  [System.IO.File]::WriteAllText($tmp, $json + "`n", $utf8)
  # [NullString]::Value, bukan $null: PowerShell mengubah $null jadi "" dan File.Replace menolak jalur kosong
  try {
    if (Test-Path -LiteralPath $inbox -PathType Leaf) { [System.IO.File]::Replace($tmp, $inbox, [NullString]::Value) } else { [System.IO.File]::Move($tmp, $inbox) }
  } catch {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    throw
  }
} finally {
  if ($held) { $lock.ReleaseMutex() }
  $lock.Dispose()
}
$where = if ($Kerjakan) { 'Sedang dikerjakan' } else { 'Antrean' }
if ($clock) {
  $when = if ($Ulang -eq 'harian') { 'tiap hari' } elseif ($Ulang -eq 'kerja') { 'tiap hari kerja' } else { 'sekali' }
  Write-Host "Task dijadwalkan jam $clock (${when}): $title"
} else {
  Write-Host "Task masuk ${where}: $title"
}
Write-Host 'Herdr mengambilnya dalam beberapa detik (kalau Herdr lagi tutup, waktu dibuka lagi).'
exit 0
