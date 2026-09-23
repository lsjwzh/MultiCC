---
name: multicc-workspaces
description: MultiCC 工作区约定：worktree 会被休眠回收，被 .gitignore 忽略的文件不可长期存放；共享文件放主仓根目录按用途命名并跨任务读取。
---

# MultiCC 工作区与共享文件约定

每个 chat 会话在自己的 git worktree（`<主仓>/.multicc-worktrees/task-<id>`）里工作。系统会对闲置会话做休眠回收以控制磁盘与 worktree 数量：

- 回收前，未提交的已跟踪改动会自动快照提交到该会话的分支（分支保留，可随时解冻恢复）；
- 但**未跟踪且被 .gitignore 忽略的文件**（典型如 `.env`）git 无法跟踪，回收时会被直接删除，只留审计清单（路径/大小/条数），**不可恢复**。

## 共享文件约定

需要长期存在或跨任务共享的文件：

1. 放在**主仓库根目录**（main checkout，即 `.multicc-worktrees` 的上一级）；
2. 按用途起好名字：`config/dev.env`、`config/prod.env`、`data/<用途>.json` 等；
3. 任何任务会话里直接用主仓绝对路径读取，不复制进 worktree。

worktree 里确需临时环境文件时，用 `ln -s` 指向主仓文件，或启动脚本临时 `cp`，用毕即删。

详见 [references/shared-files-rule.md](references/shared-files-rule.md)。
