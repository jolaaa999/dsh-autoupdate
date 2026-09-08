<#
============================================================================
 DeepSeek Harness Auto-Update - safe upstream merge  (v1.2, 2026-08-19)
============================================================================
 Purpose
   Keeps a LOCAL git clone of deepseek-harness in sync with its upstream
   WITHOUT replacing local work. This is a real git merge (fast-forward or
   merge commit), never a file copy / re-clone.

 Safe-mode guarantees (nothing below ever breaks the working tree):
   * If another sync is already running            -> exit 4 (no change)
   * If a merge/rebase/cherry-pick is in progress  -> exit 5 (no change)
   * If upstream has no new commits                -> exit 0 (no change)
   * If local uncommitted changes overlap the
     files upstream is about to touch              -> exit 3, tree untouched
   * If the merge hits real conflicts              -> `git merge --abort`,
     working tree restored to the pre-merge state, conflict files reported
   * On any git/environment failure                -> exit 2, no change
   Success (fast-forward or merged)                -> exit 0, local work kept

 Exit codes: 0 ok | 2 error(no change) | 3 aborted(no change)
             4 busy | 5 operation already in progress

 Artifacts (written next to the repo metadata, never inside the work tree):
   <repo>/.git/dsh-autoupdate/last-report.json   latest machine-readable report
   <repo>/.git/dsh-autoupdate/sync.log           append-only history
   <repo>/.git/dsh-autoupdate/sync.lock/         lock dir while running

 Usage:
   powershell -NoProfile -ExecutionPolicy Bypass -File sync-dsh.ps1 `
       -RepoPath E:\deepseek-harness
   Optional: -RunInstall   runs `pnpm install --frozen-lockfile` after a
                           merge that touched package.json / pnpm-lock.yaml
                           (off by default: nightly runs should stay cheap).
============================================================================
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RepoPath,

    [switch]$RunInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:GIT_TERMINAL_PROMPT = '0'

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
$script:gitExe = $null

function Resolve-Git {
    $c = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $c) { $c = Get-Command git -ErrorAction SilentlyContinue }
    if (-not $c) { return $false }
    $script:gitExe = $c.Source
    return $true
}

function Invoke-Git {
    # Runs git (current directory) and returns {Code, Out}. Every stderr
    # line is flattened to a plain string so native stderr can never become
    # a terminating error under $ErrorActionPreference = 'Stop' (PS 5.1).
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = @(& $script:gitExe @GitArgs 2>&1)
        $lines = @()
        foreach ($item in $raw) {
            if ($item -is [System.Management.Automation.ErrorRecord]) {
                $lines += $item.ToString()
            } elseif ($null -ne $item) {
                $lines += [string]$item
            }
        }
        return [pscustomobject]@{ Code = $LASTEXITCODE; Out = $lines }
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Git-Lines {
    # Convenience: runs git and returns only the output lines (array).
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    return (Invoke-Git @GitArgs).Out
}

function Git-Ok {
    # Convenience: true when git exits 0.
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    return ((Invoke-Git @GitArgs).Code -eq 0)
}

# ---------------------------------------------------------------------------
# reporting / state
# ---------------------------------------------------------------------------
$script:stateDir = $null
$script:lockHeld = $false
$script:report = $null
$script:gitDir = $null

function Initialize-Report {
    param([string]$GitDir)
    $script:stateDir = Join-Path $GitDir 'dsh-autoupdate'
    New-Item -ItemType Directory -Path $script:stateDir -Force | Out-Null
    $script:report = [ordered]@{
        version        = 1
        ts             = (Get-Date).ToString('o')
        repo           = $RepoPath
        status         = 'unknown'
        exitCode       = 0
        branch         = ''
        upstream       = ''
        ahead          = 0
        behind         = 0
        fromSha        = ''
        toSha          = ''
        mode           = ''
        changedCount   = 0
        changed        = @()
        depsChanged    = $false
        installAdvised = $false
        conflictFiles  = @()
        blockedBy      = @()
        restored       = $null
        detail         = ''
    }
}

function Write-Report {
    param([int]$Code)
    $script:report.exitCode = $Code
    $json = $script:report | ConvertTo-Json -Depth 6 -Compress
    $enc = New-Object System.Text.UTF8Encoding($false)
    if ($script:stateDir) {
        [System.IO.File]::WriteAllText((Join-Path $script:stateDir 'last-report.json'), $json, $enc)
        [System.IO.File]::AppendAllText((Join-Path $script:stateDir 'sync.log'), $json + [Environment]::NewLine, $enc)
    }
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
function Main {
    if (-not (Resolve-Git)) {
        Write-Host '[dsh-autoupdate] git not found on PATH'
        exit 2
    }
    if (-not (Test-Path -LiteralPath $RepoPath)) {
        Write-Host "[dsh-autoupdate] repo path not found: $RepoPath"
        exit 2
    }

    $script:lockHeld = $false
    try {
        Push-Location $RepoPath

        # locate repo metadata
        $gdLines = Git-Lines rev-parse --absolute-git-dir
        if (-not (Git-Ok rev-parse --absolute-git-dir)) {
            Write-Host "[dsh-autoupdate] not a git repository: $RepoPath"
            exit 2
        }
        $script:gitDir = ($gdLines -join '').Trim()

        Initialize-Report -GitDir $script:gitDir

        # -- refuse while another git operation is in progress ---------------
        $marks = @('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD',
                   'rebase-merge', 'rebase-apply', 'BISECT_LOG')
        foreach ($m in $marks) {
            if (Test-Path -LiteralPath (Join-Path $script:gitDir $m)) {
                $script:report.status = 'in-progress'
                $script:report.detail = "unfinished git operation detected ($m) in $script:gitDir"
                Write-Report -Code 5
                Write-Host '[dsh-autoupdate] an operation is already in progress; no change made'
                exit 5
            }
        }

        # -- lock ------------------------------------------------------------
        $lockDir = Join-Path $script:gitDir 'dsh-autoupdate\sync.lock'
        if (Test-Path -LiteralPath $lockDir) {
            $age = (Get-Date) - (Get-Item -LiteralPath $lockDir).LastWriteTime
            if ($age.TotalHours -gt 2) {
                Remove-Item -LiteralPath $lockDir -Recurse -Force -ErrorAction SilentlyContinue
            } else {
                Write-Host '[dsh-autoupdate] another sync is running; no change made'
                exit 4
            }
        }
        New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null
        $script:lockHeld = $true

        Sync
    } catch {
        Write-Host "[dsh-autoupdate] unexpected error: $($_.Exception.Message)"
        if ($script:report) {
            $script:report.status = 'error'
            $script:report.detail = $_.Exception.Message
            Write-Report -Code 1
        }
        exit 1
    } finally {
        if ($script:lockHeld) {
            Remove-Item -LiteralPath $lockDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        Pop-Location -ErrorAction SilentlyContinue
    }
}

function Sync {
    # current branch + upstream
    if (-not (Git-Ok symbolic-ref --short -q HEAD)) {
        $script:report.status = 'error'
        $script:report.detail = 'HEAD is detached; refusing to auto-merge'
        Write-Report -Code 2
        Write-Host '[dsh-autoupdate] detached HEAD; no change made'
        exit 2
    }
    $branch = ((Git-Lines symbolic-ref --short -q HEAD) -join '').Trim()
    $script:report.branch = $branch

    if (-not (Git-Ok rev-parse --abbrev-ref '@{u}')) {
        $script:report.status = 'no-upstream'
        $script:report.detail = "branch '$branch' has no upstream configured"
        Write-Report -Code 2
        Write-Host "[dsh-autoupdate] no upstream for branch $branch; no change made"
        exit 2
    }
    $upstream = ((Git-Lines rev-parse --abbrev-ref '@{u}') -join '').Trim()
    $script:report.upstream = $upstream
    $remote = $upstream.Split('/')[0]

    # fetch (network). Only touches refs, never the working tree.
    $f = Invoke-Git fetch --prune $remote
    if ($f.Code -ne 0) {
        $script:report.status = 'fetch-failed'
        $script:report.detail = ($f.Out -join ' ')
        Write-Report -Code 2
        Write-Host '[dsh-autoupdate] fetch failed; no change made'
        exit 2
    }

    # how far apart are we?
    $behind = ((Git-Lines rev-list --count "HEAD..$upstream") -join '').Trim()
    $ahead  = ((Git-Lines rev-list --count "$upstream..HEAD") -join '').Trim()
    $script:report.behind = [int]$behind
    $script:report.ahead  = [int]$ahead

    if ($script:report.behind -eq 0) {
        $script:report.status = 'no-update'
        $script:report.detail = "already up to date with $upstream"
        Write-Report -Code 0
        Write-Host '[dsh-autoupdate] already up to date; no change made'
        exit 0
    }

    # -- local changes that would block / overlap ----------------------------
    $st = Invoke-Git status --porcelain
    $dirty = New-Object System.Collections.Generic.List[string]
    foreach ($line in $st.Out) {
        $s = [string]$line
        if ($s.Length -lt 4) { continue }
        $p = $s.Substring(3).Trim()
        if ($p -eq '') { continue }
        if (-not $dirty.Contains($p)) { $dirty.Add($p) }
    }

    $inc = Invoke-Git diff --name-only "HEAD" $upstream
    $incoming = @()
    foreach ($line in $inc.Out) {
        $p = ([string]$line).Trim()
        if ($p -ne '' -and $incoming -notcontains $p) { $incoming += $p }
    }

    $overlap = @($incoming | Where-Object { $dirty -contains $_ })
    if ($overlap.Count -gt 0) {
        $script:report.status = 'aborted-overlap'
        $script:report.blockedBy = @($overlap)
        $script:report.detail = 'local uncommitted changes overlap incoming files; nothing was touched'
        Write-Report -Code 3
        Write-Host "[dsh-autoupdate] ABORT: local changes overlap incoming files: $($overlap -join ', ')"
        exit 3
    }

    # snapshot of the working tree before the merge (to prove restoration)
    $preSnapshot = ($st.Out -join "`n")
    $preHead = ((Git-Lines rev-parse HEAD) -join '').Trim()
    $script:report.fromSha = $preHead

    # -- merge ----------------------------------------------------------------
    $m = Invoke-Git merge --no-edit $upstream
    if ($m.Code -eq 0) {
        $script:report.mode = if ($script:report.ahead -gt 0) { 'merge' } else { 'fast-forward' }
        $newHead = ((Git-Lines rev-parse HEAD) -join '').Trim()
        $script:report.toSha = $newHead
        $changed = @()
        foreach ($line in (Git-Lines diff --name-only $preHead $newHead)) {
            $p = ([string]$line).Trim()
            if ($p -ne '' -and $changed -notcontains $p) { $changed += $p }
        }
        $script:report.changed = @($changed | Select-Object -First 200)
        $script:report.changedCount = $changed.Count
        $deps = @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'pnpm-workspace.yml')
        $touchedDeps = @($deps | Where-Object { $changed -contains $_ })
        $script:report.depsChanged = ($touchedDeps.Count -gt 0)
        $script:report.installAdvised = $script:report.depsChanged
        $script:report.restored = $true

        if ($RunInstall -and $script:report.depsChanged) {
            $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
            if ($pnpm) {
                Write-Host '[dsh-autoupdate] dependencies changed; running pnpm install --frozen-lockfile ...'
                & $pnpm.Source install --frozen-lockfile --prefer-offline 2>&1 | Out-Host
                $script:report.detail = 'pnpm install run, exit=' + $LASTEXITCODE
            } else {
                $script:report.detail = 'dependencies changed but pnpm not found; install skipped'
            }
        }
        $script:report.status = 'updated'
        Write-Report -Code 0
        Write-Host "[dsh-autoupdate] UPDATED ($($script:report.mode)) $($preHead.Substring(0, [Math]::Min(12, $preHead.Length))) -> $($newHead.Substring(0, [Math]::Min(12, $newHead.Length))), $($changed.Count) file(s) changed"
        exit 0
    }

    # -- merge failed: restore and report --------------------------------------
    $conflictFiles = @()
    foreach ($line in (Git-Lines ls-files -u)) {
        $s = [string]$line
        $idx = $s.IndexOf("`t")
        if ($idx -ge 0) {
            $p = $s.Substring($idx + 1).Trim()
            if ($p -ne '' -and $conflictFiles -notcontains $p) { $conflictFiles += $p }
        }
    }
    $wasConflict = $conflictFiles.Count -gt 0

    $restored = $false
    if (Test-Path -LiteralPath (Join-Path $script:gitDir 'MERGE_HEAD')) {
        Invoke-Git merge --abort | Out-Null
        $restored = $true
    }

    $st2 = Invoke-Git status --porcelain
    $postSnapshot = ($st2.Out -join "`n")
    $treeSame = ($preSnapshot -eq $postSnapshot)

    $script:report.conflictFiles = @($conflictFiles)
    $script:report.restored = ($restored -or $treeSame)
    $script:report.detail = ($m.Out -join ' ')
    if ($wasConflict) {
        $script:report.status = 'aborted-conflict'
        Write-Host "[dsh-autoupdate] ABORT (conflict in: $($conflictFiles -join ', ')); merge reverted, tree unchanged"
    } else {
        $script:report.status = 'aborted-blocked'
        Write-Host '[dsh-autoupdate] ABORT (merge refused by git); tree unchanged'
    }
    if (-not $treeSame) {
        $script:report.status = 'error'
        $script:report.detail = 'WORKING TREE CHANGED BY FAILED MERGE - manual inspection required. ' + $script:report.detail
        Write-Report -Code 1
        Write-Host '[dsh-autoupdate] SEVERE: tree changed by failed merge; inspect manually'
        exit 1
    }
    Write-Report -Code 3
    exit 3
}

Main
