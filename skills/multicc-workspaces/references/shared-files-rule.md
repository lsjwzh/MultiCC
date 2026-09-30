[Rule][Shared files convention - mandatory]
Do not create LONG-LIVED .gitignore-ignored files such as .env, secrets, or data files inside a task worktree. MultiCC hibernates and reclaims idle worktrees: uncommitted tracked changes are snapshotted to the branch (recoverable), but untracked ignored files (such as .env) are deleted outright, leaving only an audit list, and cannot be recovered.

Files that must persist or be shared across tasks always go in the MAIN REPOSITORY ROOT (the main checkout, i.e. the parent of .multicc-worktrees), named by purpose, for example config/dev.env, config/prod.env, data/<purpose>.json. Untracked/ignored files in the main repository are never reclaimed. In any task session, read them via the main repository's absolute path instead of copying them into your own worktree.

If a worktree genuinely needs a temporary environment file (for example a local server that requires .env in its cwd), symlink it to the main-repository file (ln -s <main repo absolute path>/config/dev.env .env), or cp it temporarily in the start script and delete it afterwards. Do not treat the worktree as long-term storage.
