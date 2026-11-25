# pixel-hq-task versi Windows (PowerShell 5.1): tambah task ke papan kanban Pixel HQ dari terminal, skrip, atau agent.
#   pixel-hq-task "Judul task"                                   masuk Antrean
#   pixel-hq-task -Kerjakan "Judul" -Detail "detail"             langsung Sedang dikerjakan (dikirim ke staf yang nganggur)
#   pixel-hq-task -Space api -Model sonnet -Effort high -Prioritas tinggi -Batas 30 -Hentikan "Judul"
#   git diff | pixel-hq-task -Kerjakan -Detail - "Review perubahan ini"   detail dibaca dari stdin
# Nama pilihan boleh disingkat: -K, -D, -S, -M, -E, -P, -B, -H. Singkatannya alias tetap: tanpa itu -D, -E, dan -P
# bentrok dengan -Debug, -ErrorAction, dan -PipelineVariable bawaan PowerShell.
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
  [Alias('H')][switch]$Hentikan
)
$ErrorActionPreference = 'Stop'

function Show-Usage {
  Write-Host 'pakai: pixel-hq-task [-Kerjakan] [-Detail TEKS|-] [-Space NAMA] [-Model opus|sonnet|haiku|fable]'
  Write-Host '                     [-Effort low|medium|high|xhigh|max] [-Prioritas tinggi|normal|rendah]'
  Write-Host '                     [-Batas MENIT [-Hentikan]] "Judul task"'
  Write-Host 'Tanpa -Space: space terminal Herdr tempat perintah ini jalan, kalau bukan di Herdr: space yang lagi dibuka.'
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
if ($Hentikan -and -not $PSBoundParameters.ContainsKey('Batas')) { Stop-Usage '-Hentikan butuh -Batas' }
# stdin dibaca sebagai UTF-8 langsung dari aliran mentahnya, sama dengan statusLine dan hook: mengubah
# [Console]::InputEncoding lalu membaca [Console]::In bikin PowerShell 5.1 keluar diam-diam (kode 5) kalau gak ada konsol
if ($Detail -eq '-') {
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
if ($PSBoundParameters.ContainsKey('Batas')) { $entry['limitMin'] = $Batas; if ($Hentikan) { $entry['limitStop'] = $true } }

$inbox = Join-Path $Cfg 'pixel-hq-kanban-inbox.json'
# kunci biar dua perintah barengan gak saling timpa
$lock = [System.Threading.Mutex]::new($false, 'Local\PixelHqKanbanInbox')
$held = $false
try {
  # pemegang sebelumnya mati tanpa melepas kunci (AbandonedMutexException) = kuncinya tetap jadi milik kita
  try { $held = $lock.WaitOne(10000) } catch { $held = ($_.Exception -is [System.Threading.AbandonedMutexException]) -or ($_.Exception.InnerException -is [System.Threading.AbandonedMutexException]) }
  if (-not $held) { Write-Host 'Inbox kanban lagi dipakai perintah lain, coba lagi.' -ForegroundColor Red; exit 1 }
  # @(...) biar daftar 1 isi tetap daftar, di PowerShell 5.1 maupun 7 (ConvertFrom-Json-nya beda soal ini)
  $raw = Read-Text $inbox
  $list = [System.Collections.ArrayList]::new()
  if ($raw.TrimStart().StartsWith('[')) { try { foreach ($e in @(ConvertFrom-Json -InputObject $raw)) { [void]$list.Add($e) } } catch {} }
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
Write-Host "Task masuk ${where}: $title"
Write-Host 'Herdr mengambilnya dalam beberapa detik (kalau Herdr lagi tutup, waktu dibuka lagi).'
exit 0
