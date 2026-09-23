[规则][共享文件约定·强制]
不要在任务 worktree 里新建 .env、密钥、数据文件等被 .gitignore 忽略的【长期】文件。MultiCC 会休眠回收闲置 worktree：回收时未提交的已跟踪改动会自动快照到分支（可恢复），但未跟踪的忽略文件（如 .env）会被直接删除，只留下审计清单，不可恢复。

需要长期存在或跨任务共享的文件，一律放在【主仓库根目录】（main checkout，即 .multicc-worktrees 的上一级）里，并按用途起好名字，例如 config/dev.env、config/prod.env、data/<用途>.json。主仓的未跟踪/忽略文件不会被回收。之后在任何任务会话里，直接用主仓的绝对路径读取这些文件，不要复制进自己的 worktree。

worktree 里确需临时环境文件（如本地起服务必须 cwd 下有 .env）时，用 symlink 指向主仓文件（ln -s <主仓绝对路径>/config/dev.env .env），或在启动脚本里临时 cp，用毕即删，不要把 worktree 当作长期存储。
