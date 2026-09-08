# dsh-autoupdate

English | [简体中文](README.zh.md)

DSH (DeepSeek Harness) plugin: a **safe auto-update status panel and manual trigger** for a local deepseek-harness git clone.

## What it is

A companion plugin. The actual updater is a standalone PowerShell script (`tools/sync-dsh.ps1`) that performs a **safe-mode git merge** (fast-forward or merge commit — never a file copy / re-clone) on your local harness checkout. This plugin wires that tool into the DSH web UI:

- An "Auto-update" panel in **Settings → General**: status badge, last check time, commits behind
- One-click **"Check for updates now"** from the panel (runs the sync script)
- Standalone status page at `http://127.0.0.1:3080/dsh-autoupdate` (details, blocked-files list, error detail, 60s auto-refresh)
- Data API `GET /dsh-autoupdate/report`, manual trigger `POST /dsh-autoupdate/run`

## Safety

Safety guarantees of the sync tool (all exercised in practice):

- Concurrency lock: a second sync exits immediately while one is running
- Never starts while a merge/rebase/cherry-pick is in progress
- Zero changes when upstream has no new commits
- **Local uncommitted changes overlapping incoming upstream files → abort, working tree untouched** (exit code 3)
- Real merge conflicts → `git merge --abort`, tree restored to the pre-merge state
- Any git/environment failure → exit code 2, no changes
- The plugin degrades gracefully when the report is missing or corrupt — it can never break DSH startup
- Manual trigger has a 10-minute timeout and an in-process mutex

## Install

```sh
dsh plugin add dsh-autoupdate
```

### Prerequisites

1. A local git clone of deepseek-harness (defaults to `~/deepseek-harness`)
2. Install the sync tool (from this repo's `tools/`) next to the repo metadata:

```sh
# Windows
mkdir <your-harness-clone>\.git\dsh-autoupdate 2>$null
copy tools\sync-dsh.ps1 <your-harness-clone>\.git\dsh-autoupdate\
copy tools\test-sync.ps1 <your-harness-clone>\.git\dsh-autoupdate\
```

3. Tell the plugin where your checkout lives (either):
   - Set the `DSH_AUTOUPDATE_REPO` environment variable to the checkout path; or
   - Keep the checkout at the default `~/deepseek-harness` (no configuration needed).

### Optional: daily scheduled sync (Windows Task Scheduler)

```powershell
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File "<harness-clone>\.git\dsh-autoupdate\sync-dsh.ps1" -RepoPath "<harness-clone>"'
$trigger = New-ScheduledTaskTrigger -Daily -At 00:00
Register-ScheduledTask -TaskName "DSH AutoUpdate Sync" -Action $action -Trigger $trigger
```

## Usage

Restart DSH after installing, open **Settings → General**, the "Auto-update" panel sits at the bottom; or visit `/dsh-autoupdate` directly.

Status meanings: synced / up to date / network failed / **aborted (local changes overlap upstream)** / conflict aborted / error.

## How it works

```
┌──────────────┐  spawn (timeout + mutex)  ┌──────────────────────────────┐
│ DSH web UI    │ ────────────────────────▶ │ .git/dsh-autoupdate/          │
│ settings panel│ ◀──────────────────────── │   sync-dsh.ps1 (safe merge)   │
└──────────────┘   report JSON             │   last-report.json (machine)  │
       │                                   └──────────────────────────────┘
       │ daily 00:00 (optional scheduled task)      │
       ▼                                            ▼
   same script                          your harness work tree (never
                                        broken by a failed sync)
```

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `DSH_AUTOUPDATE_REPO` | Absolute path to the harness checkout | `~/deepseek-harness` |

## License

MIT
