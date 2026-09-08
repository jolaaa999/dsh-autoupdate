# dsh-autoupdate

[English](README.md) | 简体中文

DSH（DeepSeek Harness）插件：为本地 deepseek-harness git 仓库提供**安全的自动更新状态面板与手动触发**。

## 这是什么

一个"伴随式"插件。真正的更新工具是一份独立的 PowerShell 脚本（`tools/sync-dsh.ps1`），它对本地 harness 克隆做**安全模式的 git merge**（快进或合并提交，绝不是文件覆盖/重新克隆）。本插件把这份工具接入 DSH 网页界面：

- **设置 → 通用** 页面新增"自动更新"面板：状态徽章、上次检查时间、落后提交数
- 面板内可直接 **"立即检查更新"**（调用同步脚本）
- 独立状态页 `http://127.0.0.1:3080/dsh-autoupdate`（详情、被阻塞文件清单、错误详情、60 秒自动刷新）
- 数据接口 `GET /dsh-autoupdate/report`、手动触发 `POST /dsh-autoupdate/run`

## 安全性

同步工具的安全保证（全部经过实测）：

- 有并发锁：已有同步在运行时直接退出，不会叠加
- merge/rebase 进行中不启动
- 上游无新提交时零改动
- **本地未提交改动与上游将要修改的文件重叠时 → 中止，工作区一个字节不动**（退出码 3）
- 合并遇到真实冲突 → `git merge --abort`，恢复到合并前状态
- 任何 git/环境失败 → 退出码 2，无改动
- 插件的报告读取失败/文件缺失时优雅降级，绝不会导致 DSH 启动失败
- 手动触发带 10 分钟超时和进程内互斥

## 安装

```sh
dsh plugin add dsh-autoupdate
```

### 前置条件

1. 本地有 deepseek-harness 的 git 克隆（默认假定 `~/deepseek-harness`）
2. 安装同步工具（本仓库 `tools/` 目录）到仓库元数据旁：

```sh
# Windows
mkdir <你的harness克隆>\.git\dsh-autoupdate 2>$null
copy tools\sync-dsh.ps1 <你的harness克隆>\.git\dsh-autoupdate\
copy tools\test-sync.ps1 <你的harness克隆>\.git\dsh-autoupdate\
```

3. 告诉插件你的仓库位置（二选一）：
   - 设置环境变量 `DSH_AUTOUPDATE_REPO` 指向你的 harness 克隆；
   - 或者你的克隆就在默认位置 `~/deepseek-harness`，无需配置。

### 可选：每日自动同步（Windows 计划任务）

```powershell
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File "<harness克隆>\.git\dsh-autoupdate\sync-dsh.ps1" -RepoPath "<harness克隆>"'
$trigger = New-ScheduledTaskTrigger -Daily -At 00:00
Register-ScheduledTask -TaskName "DSH AutoUpdate Sync" -Action $action -Trigger $trigger
```

## 使用

装好后重启 DSH，打开 **设置 → 通用**，最底部即"自动更新"面板；或直接访问 `/dsh-autoupdate`。

状态含义：同步成功 / 已是最新 / 网络失败 / **安全中止（本地有未提交改动与上游重叠）** / 冲突中止 / 出错。

## 工作原理

```
┌──────────────┐   spawn(带超时/互斥)   ┌──────────────────────────────┐
│ DSH web 界面  │ ────────────────────▶ │ .git/dsh-autoupdate/          │
│  设置页面板    │ ◀──────────────────── │   sync-dsh.ps1 (安全merge)    │
└──────────────┘   report JSON         │   last-report.json (机器可读) │
       │                               └──────────────────────────────┘
       │ 每日 00:00（可选计划任务）                │
       ▼                                        ▼
   同样的脚本                          你的 harness 工作区（永不因失败被破坏）
```

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `DSH_AUTOUPDATE_REPO` | harness 克隆的绝对路径 | `~/deepseek-harness` |

## License

MIT
