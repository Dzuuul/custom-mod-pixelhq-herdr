# Agent status line for Pixel HQ on Windows (Claude Code, Antigravity, other compatible agents).
# PowerShell 5.1+ port of claude-statusline.sh, so Windows needs neither sh nor Python.
# The agent hands this script a JSON blob on stdin after every turn or status change;
# it tells Herdr how full the context is (labels agent.context / claude.context, 0-100),
# how much of the quota window is left (agent.quota / claude.quota, 0-100) and effort level (agent.effort / claude.effort)
# so the desk can show HP/SP bars, writes the Claude usage file the status bar reads
# (~/.local/state/pixel-hq/claude-usage.json) and prints a short status.
# Also clears the labels when the agent stops reporting them, so a stale number never outlives its source.
# Outside a Herdr terminal it only prints the status.
# Run as: powershell -NoProfile -ExecutionPolicy Bypass -File "<path>/pixel-hq-statusline.ps1"
# Uses .NET only (no cmdlets from modules that would have to load first), to start fast.
# Keep this file ASCII: Windows PowerShell 5.1 reads a script without a BOM as ANSI.
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$inv = [System.Globalization.CultureInfo]::InvariantCulture
$dot = [string][char]0x00B7

function IsObj($v) { return ($v -is [System.Collections.IDictionary] -or $v -is [System.Management.Automation.PSCustomObject]) }
function P($o, [string]$n) {
  # a property of a JSON object, or $null
  if ($o -is [System.Collections.IDictionary]) { return $o[$n] }
  if ($o -is [System.Management.Automation.PSCustomObject]) {
    $p = $o.PSObject.Properties[$n]
    if ($p) { return $p.Value }
  }
  return $null
}
function Parse-Json([string]$s) {
  # JavaScriptSerializer: no module to load, unlike ConvertFrom-Json (about 100 ms)
  if ($null -eq $script:js) {
    try {
      [void][System.Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
      $script:js = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
      $script:js.MaxJsonLength = [int]::MaxValue
    } catch { $script:js = $false }
  }
  if ($script:js) { return , $script:js.DeserializeObject($s) }
  return , ($s | ConvertFrom-Json)
}
function IsNum($v) { return ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal] -or $v -is [single]) }
function First { foreach ($a in $args) { if ($a) { return , $a } }; return $null }
function Clean($v) {
  if ($null -eq $v) { return '' }
  $s = [regex]::Replace([string]$v, '[\x00-\x1f\x7f]', '')
  return $s.Replace('|', $dot)
}
function J($v) {
  # one JSON value
  if ($null -eq $v) { return 'null' }
  if ($v -is [bool]) { if ($v) { return 'true' } else { return 'false' } }
  if ($v -is [double] -or $v -is [single]) { return $v.ToString('R', $inv) }
  if (IsNum $v) { return [System.Convert]::ToString($v, $inv) }
  $s = ([string]$v).Replace('\', '\\').Replace('"', '\"')
  $s = [regex]::Replace($s, '[\x00-\x1f]', [System.Text.RegularExpressions.MatchEvaluator] { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  return '"' + $s + '"'
}
function Pct($v) { return [string][int][math]::Max(0, [math]::Min(100, [math]::Round([double]$v))) }
function Each-Line([string]$path, [scriptblock]$fn) {
  # reads a file the agent may still be writing
  $r = [System.IO.StreamReader]::new([System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite, Delete'), $utf8)
  try { while ($null -ne ($line = $r.ReadLine())) { & $fn $line } } finally { $r.Dispose() }
}
function Write-TextAtomic([string]$dst, [string]$text) {
  $tmp = "$dst.tmp.$PID"
  [System.IO.File]::WriteAllText($tmp, $text, $utf8)
  try {
    if (-not [System.IO.File]::Exists($dst)) { [System.IO.File]::Move($tmp, $dst) }
    else {
      try { [System.IO.File]::Replace($tmp, $dst, [NullString]::Value) }  # atomic on NTFS
      catch { [System.IO.File]::Delete($dst); [System.IO.File]::Move($tmp, $dst) }  # where ReplaceFile is not supported
    }
  } catch { try { [System.IO.File]::Delete($tmp) } catch {} }
}
function Quote-Arg([string]$a) {
  if ($a -eq '') { return '""' }
  if ($a -notmatch '[\s"]') { return $a }
  $a = [regex]::Replace($a, '(\\*)"', '$1$1\"')
  $a = [regex]::Replace($a, '(\\+)$', '$1$1')
  return '"' + $a + '"'
}
function Find-Hc {
  foreach ($dir in @(([string]$env:PATH).Split(';') + "$env:LOCALAPPDATA\Programs\herdr-core" + "$env:USERPROFILE\.local\bin")) {
    if (-not $dir) { continue }
    foreach ($n in 'hc.exe', 'hc.cmd', 'hc.bat') {
      try { $f = [System.IO.Path]::Combine($dir.Trim('"'), $n); if ([System.IO.File]::Exists($f)) { return $f } } catch {}
    }
  }
  return $null
}

$d = $null
try {
  $raw = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8).ReadToEnd()
  if ($raw.Trim()) { $d = Parse-Json $raw }
} catch {}
if (-not (IsObj $d)) { $d = $null }
$hasData = $d -is [System.Collections.ICollection] -and $d.Count -gt 0
if ($d -is [System.Management.Automation.PSCustomObject]) { $hasData = @($d.PSObject.Properties).Count -gt 0 }

$model = ''
$pct = ''
$quota = ''
$effort = ''
$cost = ''
$tokens = ''
try {
  $m = P $d 'model'
  if (IsObj $m) { $model = Clean (First (P $m 'display_name') (P $m 'name') (P $m 'id') (P $m 'title')) }
  elseif ($m -is [string]) { $model = Clean $m }
  if (-not $model) { $model = Clean (First (P $d 'model_name') (P $d 'model_id') (P $d 'current_model')) }

  $tp = Clean (P $d 'transcript_path')
  $hasTp = $false
  try { $hasTp = $tp -and [System.IO.File]::Exists($tp) } catch {}
  if (-not $model -and $hasTp) {
    try {
      Each-Line $tp {
        param($line)
        if ($line.Contains('"model":')) {
          $x = [regex]::Match($line, '"model"\s*:\s*"([^"\\]+)"')
          if ($x.Success) { $script:model = Clean $x.Groups[1].Value }
        }
      }
    } catch {}
  }
  if (-not $model -and $hasData) {
    foreach ($sp in @("$env:USERPROFILE\.claude\settings.json", "$env:USERPROFILE\.gemini\antigravity-cli\settings.json")) {
      try {
        if ([System.IO.File]::Exists($sp)) {
          $model = Clean (P (Parse-Json ([System.IO.File]::ReadAllText($sp, $utf8))) 'model')
          if ($model) { break }
        }
      } catch {}
    }
  }

  $c = P $d 'context_window'
  $p = P $c 'used_percentage'
  if ($null -eq $p) {
    $usedIn = P $c 'total_input_tokens'
    $usedOut = P $c 'total_output_tokens'
    $size = P $c 'context_window_size'
    if ((IsNum $usedIn) -and (IsNum $size) -and $size -gt 0) {
      $p = ([double]$usedIn + $(if (IsNum $usedOut) { [double]$usedOut } else { 0 })) * 100.0 / $size
    }
  }
  if ($null -eq $p -and $hasTp) {
    # older Claude Code: estimate from the last assistant message in the transcript
    try {
      $tail = [System.Collections.Generic.Queue[string]]::new()
      Each-Line $tp { param($line) if ($line.Contains('"usage"')) { $tail.Enqueue($line); if ($tail.Count -gt 20) { [void]$tail.Dequeue() } } }
      $lines = $tail.ToArray()
      for ($i = $lines.Length - 1; $i -ge 0; $i--) {
        $u = $null
        try { $u = P (P (Parse-Json $lines[$i]) 'message') 'usage' } catch {}
        if (IsObj $u) {
          $used = 0.0
          foreach ($k in 'input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens') { $v = P $u $k; if (IsNum $v) { $used += $v } }
          $id = if (IsObj $m) { [string](P $m 'id') } else { '' }
          $size = if ($id.ToLower().Contains('1m')) { 1000000 } else { 200000 }
          $p = $used * 100.0 / $size
          break
        }
      }
    } catch {}
  }
  if (IsNum $p) { $pct = Pct $p }

  # Quota: Claude Code rate_limits or Antigravity quota
  $rl = P $d 'rate_limits'
  $five = P $rl 'five_hour'
  $fiveUsed = P $five 'used_percentage'
  if ((IsNum $fiveUsed) -and $fiveUsed -ge 0 -and $fiveUsed -le 100) { $quota = Pct (100 - [double]$fiveUsed) }
  else {
    $q = P $d 'quota'
    $g5h = First (P $q 'gemini-5h') (P $q '3p-5h')
    $rf = P $g5h 'remaining_fraction'
    if (IsNum $rf) { $quota = Pct ([double]$rf * 100) }
  }

  $eff = P $d 'effort'
  $effort = Clean (First (P $eff 'level') (P $m 'effort'))

  # Usage for the status bar: 5-hour session and weekly window (percent used, reset time in epoch seconds)
  try {
    $sev = P $rl 'seven_day'
    $sevUsed = P $sev 'used_percentage'
    if ((IsNum $fiveUsed) -or (IsNum $sevUsed)) {
      $ud = [System.IO.Path]::Combine($env:USERPROFILE, '.local', 'state', 'pixel-hq')
      [void][System.IO.Directory]::CreateDirectory($ud)
      $at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
      $o = '{"at": ' + $at + ', "session": {"used": ' + (J $fiveUsed) + ', "resets": ' + (J (P $five 'resets_at')) + '}, "week": {"used": ' + (J $sevUsed) + ', "resets": ' + (J (P $sev 'resets_at')) + '}}'
      Write-TextAtomic ([System.IO.Path]::Combine($ud, 'claude-usage.json')) $o
      # History for the chart in the usage dialog: [time, session %, week %], at most every 5 minutes
      # (or when the numbers change), kept for 14 days.
      try {
        $hp = [System.IO.Path]::Combine($ud, 'claude-usage-history.json')
        $rows = New-Object System.Collections.ArrayList
        try {
          if ([System.IO.File]::Exists($hp)) {
            $old = Parse-Json ([System.IO.File]::ReadAllText($hp, $utf8))
            foreach ($r in @($old)) {
              $r = @($r)
              if ($r.Count -eq 3 -and (IsNum $r[0]) -and ($at - $r[0] -lt 14 * 86400)) { [void]$rows.Add($r) }
            }
          }
        } catch { $rows.Clear() }
        $row = @($at, $fiveUsed, $sevUsed)
        $lastRow = if ($rows.Count) { $rows[$rows.Count - 1] } else { $null }
        $changed = $true
        if ($lastRow) { $changed = ((J $lastRow[1]) -ne (J $fiveUsed)) -or ((J $lastRow[2]) -ne (J $sevUsed)) }
        if (-not $lastRow -or ($at - $lastRow[0]) -ge 300 -or $changed) {
          if ($lastRow -and ($at - $lastRow[0]) -lt 60) { $rows[$rows.Count - 1] = $row } else { [void]$rows.Add($row) }
          $hj = '[' + (@(foreach ($r in $rows) { '[' + (J $r[0]) + ',' + (J $r[1]) + ',' + (J $r[2]) + ']' }) -join ',') + ']'
          Write-TextAtomic $hp $hj
        }
      } catch {}
    }
  } catch {}

  # Session cost and tokens, for the per-staff table in the usage dialog
  try {
    $cs = P $d 'cost'
    $tc = P $cs 'total_cost_usd'
    if (IsNum $tc) { $cost = ([double]$tc).ToString('0.0000', $inv) }
    $ti = P $c 'total_input_tokens'
    $to = P $c 'total_output_tokens'
    if ((IsNum $ti) -or (IsNum $to)) {
      $sum = $(if (IsNum $ti) { [double]$ti } else { 0 }) + $(if (IsNum $to) { [double]$to } else { 0 })
      $tokens = [string][long][math]::Truncate($sum)
    }
  } catch {}
} catch {}

$term = [string]$env:HC_TERMINAL_ID
if ($term) {
  try {
    $hc = Find-Hc
    if ($hc) {
      $argv = @('label', $term)
      foreach ($k in 'context', 'model', 'quota', 'effort') {
        $v = switch ($k) { 'context' { $pct } 'model' { $model } 'quota' { $quota } 'effort' { $effort } }
        foreach ($ns in 'agent', 'claude', 'agy') { $argv += "$ns.$k=$v" }
      }
      $argv += "agent.cost=$cost"
      $argv += "agent.tokens=$tokens"
      # like `hc ... >/dev/null 2>&1`, but waits the few ms hc takes (at most 3 s): sharing this console
      # (no CreateNoWindow) avoids starting a new hidden console, which would cost far more than the wait
      $psi = [System.Diagnostics.ProcessStartInfo]::new($hc, ((@($argv) | ForEach-Object { Quote-Arg $_ }) -join ' '))
      $psi.UseShellExecute = $false
      $psi.RedirectStandardOutput = $true
      $psi.RedirectStandardError = $true
      [void][System.Diagnostics.Process]::Start($psi).WaitForExit(3000)
    }
  } catch {}
}

if ($pct) {
  if ($quota) { $text = "$model $dot $pct% context $dot $quota% 5h left" } else { $text = "$model $dot $pct% context" }
} else { $text = $model }
$out = [Console]::OpenStandardOutput()
$bytes = $utf8.GetBytes($text)
$out.Write($bytes, 0, $bytes.Length)
$out.Flush()
