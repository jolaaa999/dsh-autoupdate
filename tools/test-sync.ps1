# Test harness for sync-dsh.ps1 (safe-mode upstream merge)
# Creates throwaway bare/local/upstream repos under %TEMP% and asserts each
# scenario's exit code + report fields + working-tree outcome.
$ErrorActionPreference = 'Stop'

$syncScript = 'E:\deepseek-harness\.git\dsh-autoupdate\sync-dsh.ps1'
$psExe = (Get-Process -Id $PID).Path
$git = (Get-Command git.exe).Source

$root = Join-Path $env:TEMP ('dsh-sync-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
Write-Host "test root: $root"

$pass = 0
$fail = 0
$failures = @()

function Check {
    param([string]$Name, [bool]$Ok, [string]$Why)
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" }
    else {
        $script:fail++
        Write-Host "  FAIL  $Name  -> $Why"
        $script:failures += "$Name : $Why"
    }
}

function G {
    param([string]$Dir, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    $o = @(& $git -C $Dir @Args 2>&1)
    return [pscustomobject]@{ Code = $LASTEXITCODE; Out = $o }
}

function New-Clone {
    param([string]$Bare, [string]$Dir)
    & $git clone -q -b master $Bare $Dir
    if ($LASTEXITCODE -ne 0) { throw "clone failed: $Dir" }
    & $git -C $Dir config user.name 'tester' | Out-Null
    & $git -C $Dir config user.email 't@example.com' | Out-Null
    return $Dir
}

function Set-File {
    param([string]$Dir, [string]$Name, [string]$Content)
    [System.IO.File]::WriteAllText((Join-Path $Dir $Name), $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Read-File {
    param([string]$Dir, [string]$Name)
    if (-not (Test-Path -LiteralPath (Join-Path $Dir $Name))) { return '<missing>' }
    return [System.IO.File]::ReadAllText((Join-Path $Dir $Name))
}

function Commit-All {
    param([string]$Dir, [string]$Msg)
    & $git -C $Dir add -A | Out-Null
    & $git -C $Dir commit -q -m $Msg
    if ($LASTEXITCODE -ne 0) { throw "commit failed: $Msg" }
}

function Run-Sync {
    param([string]$Repo)
    $o = @(& $psExe -NoProfile -ExecutionPolicy Bypass -File $syncScript -RepoPath $Repo 2>&1)
    $code = $LASTEXITCODE
    $report = $null
    $rpath = Join-Path $Repo '.git\dsh-autoupdate\last-report.json'
    if (Test-Path -LiteralPath $rpath) {
        $report = Get-Content -LiteralPath $rpath -Raw | ConvertFrom-Json
    }
    return [pscustomobject]@{ Code = $code; Report = $report; Out = $o }
}

# ============================================================================
# fixture: bare origin; upstream work clone U; base commit A
# ============================================================================
$bare = Join-Path $root 'origin.git'
& $git init -q --bare -b master $bare
if ($LASTEXITCODE -ne 0) { throw 'bare init failed' }
$seed = Join-Path $root 'seed'
New-Item -ItemType Directory -Path $seed | Out-Null
& $git init -q -b master $seed
& $git -C $seed config user.name 'tester' | Out-Null
& $git -C $seed config user.email 't@example.com' | Out-Null
& $git -C $seed remote add origin $bare
Set-File $seed 'base.txt' "base line one`n"
Set-File $seed 'y.txt' "y line`n"
Set-File $seed 'mod.txt' "mod line`n"
Commit-All $seed 'base A'
& $git -C $seed push -q -u origin master
if ($LASTEXITCODE -ne 0) { throw 'seed push failed' }

# local clones start at A; upstream work clone U drives the bare repo
$local1 = New-Clone -Bare $bare -Dir (Join-Path $root 'local1')   # up-to-date
$local2 = New-Clone -Bare $bare -Dir (Join-Path $root 'local2')   # clean FF
$up     = New-Clone -Bare $bare -Dir (Join-Path $root 'up')

Write-Host '== S1 up-to-date =='
$r = Run-Sync -Repo $local1
Check 'S1 exit 0' ($r.Code -eq 0) ("code=$($r.Code)")
Check 'S1 status no-update' ($r.Report.status -eq 'no-update') ("status=$($r.Report.status)")

Write-Host '== S2 clean fast-forward =='
Set-File $up 'base.txt' "base line one`nupstream change`n"
Set-File $up 'up.txt' "added upstream`n"
Commit-All $up 'upstream B'
& $git -C $up push -q origin master
if ($LASTEXITCODE -ne 0) { throw 'push B failed' }
$r = Run-Sync -Repo $local2
Check 'S2 exit 0' ($r.Code -eq 0) ("code=$($r.Code)")
Check 'S2 status updated' ($r.Report.status -eq 'updated') ("status=$($r.Report.status)")
Check 'S2 fast-forward' ($r.Report.mode -eq 'fast-forward') ("mode=$($r.Report.mode)")
Check 'S2 base.txt merged' ((Read-File $local2 'base.txt') -like '*upstream change*') 'content missing'
Check 'S2 up.txt added' ((Read-File $local2 'up.txt') -like '*added upstream*') 'content missing'
Check 'S2 changed lists base+up' (($r.Report.changed -contains 'base.txt') -and ($r.Report.changed -contains 'up.txt')) ("changed=$($r.Report.changed -join ',')")
Check 'S2 tree clean' (( (& $git -C $local2 status --porcelain | Out-String) -eq '') ) 'dirty'

$local3 = New-Clone -Bare $bare -Dir (Join-Path $root 'local3')   # at B
$local4 = New-Clone -Bare $bare -Dir (Join-Path $root 'local4')   # at B
Set-File $local3 'base.txt' "base line one`nlocal uncommitted`n"

Write-Host '== S3 dirty overlapping file -> abort =='
Set-File $up 'base.txt' "base line one`nupstream change`nmore upstream`n"
Commit-All $up 'upstream C touches base.txt'
& $git -C $up push -q origin master
if ($LASTEXITCODE -ne 0) { throw 'push C failed' }
$r = Run-Sync -Repo $local3
Check 'S3 exit 3' ($r.Code -eq 3) ("code=$($r.Code)")
Check 'S3 status aborted-overlap' ($r.Report.status -eq 'aborted-overlap') ("status=$($r.Report.status)")
Check 'S3 blockedBy base.txt' ($r.Report.blockedBy -contains 'base.txt') ("blocked=$($r.Report.blockedBy -join ',')")
Check 'S3 local edit kept' ((Read-File $local3 'base.txt') -like '*local uncommitted*') 'overwritten!'
Check 'S3 no ff happened' ((& $git -C $local3 rev-list --count 'HEAD..origin/master') -eq 1) 'head moved'

Write-Host '== S4 dirty non-overlapping file -> merge ok =='
Set-File $local4 'mod.txt' "mod line`nlocal tweak uncommitted`n"
$r = Run-Sync -Repo $local4
Check 'S4 exit 0' ($r.Code -eq 0) ("code=$($r.Code)")
Check 'S4 updated' ($r.Report.status -eq 'updated') ("status=$($r.Report.status)")
Check 'S4 local tweak kept' ((Read-File $local4 'mod.txt') -like '*local tweak uncommitted*') 'overwritten!'
Check 'S4 base.txt updated' ((Read-File $local4 'base.txt') -like '*more upstream*') 'merge missing'

Write-Host '== S5 diverged + real conflict -> abort + restore =='
$local5 = New-Clone -Bare $bare -Dir (Join-Path $root 'local5')   # at C
Set-File $local5 'y.txt' "y line local commit`n"
Commit-All $local5 'local commit on y.txt'
Set-File $up 'y.txt' "y line remote commit`n"
Commit-All $up 'upstream D touches y.txt'
& $git -C $up push -q origin master
if ($LASTEXITCODE -ne 0) { throw 'push D failed' }
$preHead = ((& $git -C $local5 rev-parse HEAD).Trim())
$r = Run-Sync -Repo $local5
Check 'S5 exit 3' ($r.Code -eq 3) ("code=$($r.Code)")
Check 'S5 status aborted-conflict' ($r.Report.status -eq 'aborted-conflict') ("status=$($r.Report.status)")
Check 'S5 conflictFiles y.txt' ($r.Report.conflictFiles -contains 'y.txt') ("conflict=$($r.Report.conflictFiles -join ',')")
Check 'S5 restored reported' ($r.Report.restored -eq $true) ("restored=$($r.Report.restored)")
$headAfter = ((& $git -C $local5 rev-parse HEAD).Trim())
Check 'S5 HEAD unchanged' ($headAfter -eq $preHead) "head moved $preHead -> $headAfter"
Check 'S5 no MERGE_HEAD' (-not (Test-Path -LiteralPath (Join-Path $local5 '.git\MERGE_HEAD'))) 'merge state left behind'
Check 'S5 local content kept' ((Read-File $local5 'y.txt') -like '*y line local commit*') 'file clobbered'
Check 'S5 porcelain clean' (( (& $git -C $local5 status --porcelain | Out-String) -eq '') ) 'tree dirty after abort'

Write-Host '== S6 lock busy =='
$lockDir = Join-Path $local5 '.git\dsh-autoupdate\sync.lock'
New-Item -ItemType Directory -Path $lockDir -Force | Out-Null
$r = Run-Sync -Repo $local5
Check 'S6 exit 4' ($r.Code -eq 4) ("code=$($r.Code)")
Remove-Item -LiteralPath $lockDir -Recurse -Force

Write-Host '== S7 merge already in progress =='
$mh = Join-Path $local5 '.git\MERGE_HEAD'
[System.IO.File]::WriteAllText($mh, (New-Object System.Guid).ToString(), (New-Object System.Text.UTF8Encoding($false)))
$r = Run-Sync -Repo $local5
Check 'S7 exit 5' ($r.Code -eq 5) ("code=$($r.Code)")
Check 'S7 report in-progress' ($r.Report.status -eq 'in-progress') ("status=$($r.Report.status)")
Remove-Item -LiteralPath $mh -Force

Write-Host ''
Write-Host "RESULT: pass=$pass fail=$fail  (root: $root)"
if ($fail -gt 0) {
    Write-Host 'Failures:'
    $failures | ForEach-Object { Write-Host "  - $_" }
    exit 1
}
exit 0
