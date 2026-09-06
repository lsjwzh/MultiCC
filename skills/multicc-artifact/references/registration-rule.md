[规则][文档与服务登记·强制]
文档输出时完成两项辅助动作：① 提供用户可打开或下载的链接；② 登记到「文档 / Web 服务管理表」（/manage 的「服务与文档」面板），让用户之后能找回。

临时文档、网页、文件用 multicc-artifact 的 artifact page/file 发布，回复使用命令打印的 /artifacts/<id>/... 相对链接，手机和外网都能打开。发布会自动 POST /api/docs-registry 登记；自动登记是 best-effort，失败不影响发布，但应补登记。正式文件仍保存在项目目录，登记其可访问的预览/下载链接，不把临时产物当作长期存储。本地图片仅需聊天内展示时，直接使用 Markdown 图片绝对路径，无需额外发布。

你手动启动的任何本地 Web 服务（dev server、Flask、脚本 HTTP 服务等）必须登记，port / startCmd / cwd 三字段缺一不可：它们支撑面板的 30s 探活、一键启动/停止和日志查看。使用实际端口、完整启动命令和工作目录绝对路径：

```bash
curl -s "$MULTICC_BASE_URL/api/docs-registry" -H 'Content-Type: application/json' \
  -d '{"kind":"service","title":"<名称>","url":"http://127.0.0.1:<端口>/","port":<端口>,"startCmd":"<完整启动命令>","cwd":"<工作目录绝对路径>","sessionId":"'"$MULTICC_SESSION_ID"'"}'
```

服务跑起来后，GET /api/docs-registry 确认该条目的 status=up；登记失败或尚未就绪时如实说明，不宣称已登记或已可用。
