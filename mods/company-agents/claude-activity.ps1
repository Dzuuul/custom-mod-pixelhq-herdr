# Report Claude Code's running shell commands and sub-agents to its Herdr desk, on Windows.
# PowerShell 5.1+ port of claude-activity.py (which needs Python and fcntl), with the same labels and state:
#   agent.jobs          Bash/PowerShell commands in flight
#   agent.jobs_started  their start times (ms since epoch, oldest first), so Pixel HQ can
#                       turn a job amber after a minute without this hook running again
#   agent.threads       sub-agents running
#
# Usage (from Claude Code hooks, JSON on stdin):
#   claude-activity.ps1 job-start | job-end | sub-start | sub-end | turn-end | stop | reset
# "stop" is turn-end plus: the agent's last reply goes to ~/.local/state/pixel-hq/last/<terminal>.json
# ({"at": epoch seconds, "text": ...}), which the Pixel HQ kanban shows on the finished task's card.
# A Stop hook installed by an older version still says "turn-end": it is recognised by the payload's
# hook_event_name, so the reply is saved without installing the hooks again.
# Does nothing outside a Herdr terminal (no HC_TERMINAL_ID) and never fails the hook.
# Starting PowerShell takes a few hundred ms, so the hooks that run around every command, sub-agent and turn are
# installed with "async": Claude Code does not wait for them. Their events may then arrive out of order, so an id
# that already ended is remembered ("ended") and its late start is ignored. Session start/end stay synchronous.
# The hook path uses .NET only (no cmdlets from modules that would have to load first).
#
# Setup (merges into ~/.claude/settings.json, keeps your other hooks, backs it up first):
#   powershell -NoProfile -ExecutionPolicy Bypass -File claude-activity.ps1 install     add the hooks (safe to run again)
#   powershell -NoProfile -ExecutionPolicy Bypass -File claude-activity.ps1 uninstall   remove only the hooks this script added
# Keep this file ASCII: Windows PowerShell 5.1 reads a script without a BOM as ANSI.
param([string]$Action = '')
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)

$STALE_JOB_MS = 2 * 3600 * 1000   # a command missing its end event is dropped after 2h
$STALE_SUB_MS = 6 * 3600 * 1000   # a sub-agent missing its stop event after 6h
$MAX_STARTED = 20
$ENDED_MS = 3600 * 1000           # how long an ended id is remembered against a late start
$MAX_ENDED = 200

$HookSpecs = @(  # (event, matcher, action, async); Claude Code on Windows runs commands with its Bash (Git Bash) or PowerShell tool
  @('PreToolUse', 'Bash|PowerShell', 'job-start', $true),
  @('PostToolUse', 'Bash|PowerShell', 'job-end', $true),
  @('PostToolUseFailure', 'Bash|PowerShell', 'job-end', $true),
  @('SubagentStart', $null, 'sub-start', $true),
  @('SubagentStop', $null, 'sub-end', $true),
  @('UserPromptSubmit', $null, 'turn-end', $true),
  @('Stop', $null, 'stop', $true),
  @('SessionStart', '^(startup|resume|clear)$', 'reset', $false),
  @('SessionEnd', $null, 'reset', $false)
)
$MARK = 'claude-activity\.(ps1|py)'  # our entries, also an earlier Python one (which cannot run on Windows)

function IsObj($v) { return ($v -is [System.Collections.IDictionary] -or $v -is [System.Management.Automation.PSCustomObject]) }
function P($o, [string]$n) {
  # a property of a JSON object (from JavaScriptSerializer or ConvertFrom-Json), or $null
  if ($o -is [System.Collections.IDictionary]) { return $o[$n] }  # $null when missing, also for Dictionary
  if ($o -is [System.Management.Automation.PSCustomObject]) {
    $p = $o.PSObject.Properties[$n]
    if ($p) { return $p.Value }
  }
  return $null
}
function Parse-Json([string]$s) {
  # JavaScriptSerializer: no module to load, unlike ConvertFrom-Json (about 100 ms on every hook)
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
function Items($v) {
  # a JSON list as an array, without the $null that @($null) would give for a missing one
  return , @(@($v) | Where-Object { $null -ne $_ })
}
function Set-Prop($o, [string]$n, $v) {
  if ($o.PSObject.Properties[$n]) { $o.$n = $v } else { $o | Add-Member -NotePropertyName $n -NotePropertyValue $v }
}
function Format-JsonString([string]$s) {
  $s = $s.Replace('\', '\\').Replace('"', '\"').Replace("`n", '\n').Replace("`r", '\r').Replace("`t", '\t')
  $s = [regex]::Replace($s, '[\x00-\x1f]', [System.Text.RegularExpressions.MatchEvaluator] { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  return '"' + $s + '"'
}
function Format-Json($v, [string]$pad = '') {
  # JSON.stringify(v, null, 2), for what ConvertFrom-Json gives back
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
function Write-TextAtomic([string]$path, [string]$text) {
  $tmp = "$path.tmp.$PID"
  [System.IO.File]::WriteAllText($tmp, $text, $utf8)
  try {
    if (-not [System.IO.File]::Exists($path)) { [System.IO.File]::Move($tmp, $path); return }
    try { [System.IO.File]::Replace($tmp, $path, [NullString]::Value) }  # atomic on NTFS
    catch { [System.IO.File]::Delete($path); [System.IO.File]::Move($tmp, $path) }  # where ReplaceFile is not supported (some network shares)
  } catch {
    try { [System.IO.File]::Delete($tmp) } catch {}
    throw
  }
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
function Run-Hc([string]$hc, [string[]]$argv) {
  # like `hc ... >/dev/null 2>&1`, but waits the few ms hc takes (at most 3 s): sharing this console
  # (no CreateNoWindow) avoids starting a new hidden console, which would cost far more than the wait
  $psi = [System.Diagnostics.ProcessStartInfo]::new($hc, ((@($argv) | ForEach-Object { Quote-Arg $_ }) -join ' '))
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  [void][System.Diagnostics.Process]::Start($psi).WaitForExit(3000)
}

function Setup([bool]$remove) {
  $path = Join-Path $env:USERPROFILE '.claude\settings.json'
  $cfg = [pscustomobject]@{}
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    $raw = [System.IO.File]::ReadAllText($path, $utf8)
    if ($raw.Trim()) {
      try { $cfg = $raw | ConvertFrom-Json } catch { Write-Host "$path is not valid JSON; left untouched"; exit 1 }
    }
  }
  if ($cfg -isnot [System.Management.Automation.PSCustomObject]) { Write-Host "$path is not a JSON object; left untouched"; exit 1 }
  $hooks = P $cfg 'hooks'
  if ($null -ne $hooks -and $hooks -isnot [System.Management.Automation.PSCustomObject]) { Write-Host "$path has a 'hooks' that is not an object; left untouched"; exit 1 }
  if ((Test-Path -LiteralPath $path -PathType Leaf) -and -not (Test-Path -LiteralPath "$path.pixel-hq.bak")) {
    Copy-Item -LiteralPath $path -Destination "$path.pixel-hq.bak"  # keeps the very first original
  }
  if ($null -eq $hooks) { $hooks = [pscustomobject]@{}; Set-Prop $cfg 'hooks' $hooks }
  $me = $PSCommandPath -replace '\\', '/'
  foreach ($h in $HookSpecs) {
    $name = $h[0]; $matcher = $h[1]; $act = $h[2]; $async = $h[3]
    $groups = New-Object System.Collections.ArrayList
    foreach ($g in (Items (P $hooks $name))) {  # drop our earlier entries (also makes install idempotent)
      $before = Items (P $g 'hooks')
      $after = @($before | Where-Object { -not ([string](P $_ 'command') -match $MARK) })
      if ($after.Count -eq $before.Count) { [void]$groups.Add($g); continue }
      if ($after.Count) { Set-Prop $g 'hooks' $after; [void]$groups.Add($g) }
    }
    if (-not $remove) {
      $group = [ordered]@{}
      if ($matcher) { $group['matcher'] = $matcher }
      $hook = [ordered]@{ type = 'command'; command = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$me`" $act" }
      if ($async) { $hook['async'] = $true }
      $group['hooks'] = @(New-Object PSObject -Property $hook)
      [void]$groups.Add((New-Object PSObject -Property $group))
    }
    if ($groups.Count) { Set-Prop $hooks $name $groups.ToArray() } else { [void]$hooks.PSObject.Properties.Remove($name) }
  }
  if (-not @($hooks.PSObject.Properties).Count) { [void]$cfg.PSObject.Properties.Remove('hooks') }
  [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $path))
  Write-TextAtomic $path ((Format-Json $cfg) + "`n")
  Write-Host ($(if ($remove) { 'Removed' } else { 'Installed' }) + " Pixel HQ hooks in $path (backup: $path.pixel-hq.bak)")
}

function Last-Reply($payload) {
  # The agent's last reply: from the hook payload when Claude Code sends it, else from the transcript's tail.
  $text = P $payload 'last_assistant_message'
  if ($text -is [string] -and $text.Trim()) { return $text.Trim() }
  $path = [string](P $payload 'transcript_path')
  if (-not $path) { return '' }
  try { if (-not [System.IO.File]::Exists($path)) { return '' } } catch { return '' }
  $tail = [System.Collections.Generic.List[string]]::new()
  $fs = $null
  $r = $null
  try {
    $fs = [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite, Delete')
    if ($fs.Length -gt 2000000) { [void]$fs.Seek($fs.Length - 2000000, 'Begin') }  # only the tail: transcripts grow large
    $r = [System.IO.StreamReader]::new($fs, $utf8)
    while ($null -ne ($line = $r.ReadLine())) {
      if ($line -match '"role"\s*:\s*"assistant"') {
        $tail.Add($line)
        if ($tail.Count -gt 50) { $tail.RemoveAt(0) }
      }
    }
  } catch { return '' } finally { if ($r) { $r.Dispose() } elseif ($fs) { $fs.Dispose() } }
  for ($i = $tail.Count - 1; $i -ge 0; $i--) {
    $ev = $null
    try { $ev = Parse-Json $tail[$i] } catch { continue }
    $msg = P $ev 'message'
    if ([string](P $msg 'role') -ne 'assistant') { continue }
    $content = P $msg 'content'
    $parts = [System.Collections.Generic.List[string]]::new()
    if ($content -is [string]) { $parts.Add($content) }
    elseif ($content -is [System.Collections.IEnumerable]) {
      foreach ($c in $content) { if ([string](P $c 'type') -eq 'text' -and [string](P $c 'text')) { $parts.Add([string](P $c 'text')) } }
    }
    $joined = ($parts -join "`n").Trim()
    if ($joined) { return $joined }
  }
  return ''
}
function Save-Reply([string]$term, $payload) {
  $text = Last-Reply $payload
  if (-not $text) { return }
  if ($text.Length -gt 4000) {
    $start = $text.Length - 4000
    if ([char]::IsLowSurrogate($text[$start])) { $start++ }  # don't cut a character in half
    $text = $text.Substring($start)
  }
  $folder = [System.IO.Path]::Combine($env:USERPROFILE, '.local', 'state', 'pixel-hq', 'last')
  [void][System.IO.Directory]::CreateDirectory($folder)
  $at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  Write-TextAtomic ([System.IO.Path]::Combine($folder, "$term.json")) ('{"at": ' + $at + ', "text": ' + (Format-JsonString $text) + '}')
}

function Read-Times($o) {
  # {id: ms since epoch} from the state file
  $t = [System.Collections.Generic.Dictionary[string, long]]::new()
  if ($o -is [System.Collections.IDictionary]) { foreach ($k in $o.Keys) { try { $t[[string]$k] = [long]$o[$k] } catch {} } }
  elseif ($o -is [System.Management.Automation.PSCustomObject]) { foreach ($p in $o.PSObject.Properties) { try { $t[$p.Name] = [long]$p.Value } catch {} } }
  return , $t
}
function Drop-Stale($t, [long]$before) {
  foreach ($k in @($t.Keys)) { if ($t[$k] -le $before) { [void]$t.Remove($k) } }
}
function Oldest($t, [string]$like) {
  # the key with the earliest time among those matching $like, or $null
  $o = $null
  foreach ($kv in $t.GetEnumerator()) { if ($kv.Key -like $like -and ($null -eq $o -or $kv.Value -lt $t[$o])) { $o = $kv.Key } }
  return $o
}
function Format-Times($t) {
  return '{' + (@(foreach ($kv in $t.GetEnumerator()) { (Format-JsonString $kv.Key) + ': ' + $kv.Value }) -join ', ') + '}'
}

function Report {
  $term = [string]$env:HC_TERMINAL_ID
  if (-not $Action -or -not $term -or ($term -replace '-', '') -notmatch '^[A-Za-z0-9]+$') { return }
  $payload = $null
  try {
    $raw = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8).ReadToEnd()
    if ($raw.Trim()) { $payload = Parse-Json $raw }
  } catch {}
  $act = $Action
  if ($act -eq 'stop' -or ($act -eq 'turn-end' -and [string](P $payload 'hook_event_name') -eq 'Stop')) {
    try { Save-Reply $term $payload } catch {}
    $act = 'turn-end'
  }
  $hc = Find-Hc
  if (-not $hc) { return }

  $base = if ($env:XDG_RUNTIME_DIR) { $env:XDG_RUNTIME_DIR } else { [System.IO.Path]::Combine($env:USERPROFILE, '.cache') }
  $folder = [System.IO.Path]::Combine($base, 'hc-desk-activity')
  [void][System.IO.Directory]::CreateDirectory($folder)
  $path = [System.IO.Path]::Combine($folder, "$term.json")
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

  $fs = $null
  for ($i = 0; $i -lt 100 -and -not $fs; $i++) {  # the lock: other hooks of this terminal wait here
    try { $fs = [System.IO.File]::Open($path, 'OpenOrCreate', 'ReadWrite', 'None') } catch { [System.Threading.Thread]::Sleep(20) }
  }
  if (-not $fs) { return }
  try {
    $len = [int]$fs.Length
    $buf = [byte[]]::new($len)
    $off = 0
    while ($off -lt $len) { $n = $fs.Read($buf, $off, $len - $off); if ($n -le 0) { break }; $off += $n }
    $state = $null
    try { $text = $utf8.GetString($buf, 0, $off); if ($text.Trim()) { $state = Parse-Json $text } } catch {}
    $jobs = Read-Times (P $state 'jobs')
    $subs = Read-Times (P $state 'subs')
    $ended = Read-Times (P $state 'ended')
    $last = P $state 'last'

    $toolId = [string](P $payload 'tool_use_id')
    $agentId = [string](P $payload 'agent_id')
    switch ($act) {
      'job-start' { if ($toolId -and -not $ended.ContainsKey($toolId)) { $jobs[$toolId] = $now } }
      'job-end' { if ($toolId) { [void]$jobs.Remove($toolId); $ended[$toolId] = $now } }
      'sub-start' {
        if ($agentId) { if (-not $ended.ContainsKey($agentId)) { $subs[$agentId] = $now } }
        else { $subs["anon-$now"] = $now }
      }
      'sub-end' {
        if ($agentId) {
          $ended[$agentId] = $now
          if ($subs.ContainsKey($agentId)) { [void]$subs.Remove($agentId) }
          else {
            # its start comes later (async, then ignored) or came without an id: only an anonymous one may go
            $old = Oldest $subs 'anon-*'
            if ($old) { [void]$subs.Remove($old) }
          }
        } elseif ($subs.Count) { [void]$subs.Remove((Oldest $subs '*')) }  # no id given: retire the oldest
      }
      'turn-end' { $jobs.Clear() }  # foreground commands are all over when a turn ends; sub-agents may run on
      'reset' { $jobs.Clear(); $subs.Clear() }
    }

    Drop-Stale $jobs ($now - $STALE_JOB_MS)
    Drop-Stale $subs ($now - $STALE_SUB_MS)
    Drop-Stale $ended ($now - $ENDED_MS)
    while ($ended.Count -gt $MAX_ENDED) { [void]$ended.Remove((Oldest $ended '*')) }
    $started = [long[]]@($jobs.Values)
    [Array]::Sort($started)
    if ($started.Length -gt $MAX_STARTED) { $started = $started[0..($MAX_STARTED - 1)] }
    $labels = [ordered]@{
      'agent.jobs'         = [string]$jobs.Count
      'agent.jobs_started' = ($started -join ',')
      'agent.threads'      = [string]$subs.Count
    }
    $same = $last -is [System.Collections.IDictionary] -and $last.Count -eq $labels.Count
    if ($same) { foreach ($k in $labels.Keys) { if ([string](P $last $k) -cne $labels[$k]) { $same = $false } } }
    if (-not $same) {
      try {
        # a label lost to a slow Herdr is fixed by a later event
        Run-Hc $hc (@('label', $term) + @(foreach ($k in $labels.Keys) { "$k=$($labels[$k])" }))
        $last = $labels
      } catch {}
    }

    $lastJson = 'null'
    if ($last -is [System.Collections.IDictionary]) { $lastJson = '{' + (@(foreach ($k in $last.Keys) { (Format-JsonString ([string]$k)) + ': ' + (Format-JsonString ([string]$last[$k])) }) -join ', ') + '}' }
    $out = $utf8.GetBytes('{"jobs": ' + (Format-Times $jobs) + ', "subs": ' + (Format-Times $subs) + ', "ended": ' + (Format-Times $ended) + ', "last": ' + $lastJson + '}')
    $fs.SetLength(0)
    $fs.Position = 0
    $fs.Write($out, 0, $out.Length)
  } finally {
    $fs.Dispose()
  }
}

if ($Action -eq 'install' -or $Action -eq 'uninstall') {
  Setup ($Action -eq 'uninstall')
  exit 0
}
try { Report } catch {}
exit 0
