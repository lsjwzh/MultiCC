# 服务重启

普通服务的设置页按钮与手动命令共用 `./multicc restart`。

按钮先把脚本写入 `logs/restart-*/restart.sh`，以独立进程组启动，输入断开、输出写入同目录的 `restart.log`。脚本忽略 HUP，等待 2 秒，切换到安装目录，再执行 `./multicc restart`。安装包未保留执行权限时使用 `/bin/bash ./multicc restart`。父服务退出不影响脚本继续运行。

`multicc` 的 start/stop/restart 共用 `src/server-processes.js` 的进程识别：绝对入口路径匹配，或相对 `server.js` 加实际工作目录匹配。PID 文件不是进程所有权依据。停止时先发 SIGINT，最多等待 65 秒，然后终止匹配实例及其残留子进程；每次发信号前核验 PID、启动时间和命令，重启管理器自身的祖先进程链被排除。

`logs/restart.lock` 串行化并发重启；过期锁用进程指纹判定，避免 PID 被复用后一直误报正在重启。不会按端口或 Node 进程名全局杀进程，也不会清理其他安装目录的服务。

HTTP 202 只表示已安排重启。脚本执行失败会保留日志，活着的旧服务会释放请求标记以便重试。强制结束仍可能中断在途任务；界面不会在实际保存前声称消息已经保存。Electron 桌面包继续由原有 supervisor 管理生命周期。

验证：

```sh
node --test tests/test-server-restart.js tests/test-server-processes.js
```

覆盖：延迟脚本、含空格和引号的安装路径、无执行权限的管理器、错误 PID 文件、重复实例、残留子进程、父进程退出、并发重启和过期锁。集成用临时目录中的服务进行，不重启生产实例。
