//! Compose the directory repository, layout store and host over the same live tables.
use crate::{directory_layout::layout_store, host_methods::method, route_response::*};
use napi_derive::napi;

#[napi]
pub fn directory_module(
    env: Env,
    deps: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<sys::napi_value> {
    let d = L::new(&env, deps);
    let p = L::new(&env, ports);
    let repository = d.get(c"repository")?;
    let git = d.get(c"git")?;
    let sessions = d.get(c"sessions")?;
    let events = d.get(c"events")?;
    let fs_port = d.get(c"fsPort")?;
    let helpers = d.get(c"helpers")?;
    let tx = d.get(c"tx")?;
    let logger = d.get(c"logger")?;
    let options = fields(d, &[])?;
    options.spread_from(repository)?;
    options.set(c"realPathOf", helpers.get(c"realPathOf")?)?;
    let repo = p
        .get(c"createFsDirectoryRepository")?
        .call_plain(&[options])?;
    let mut file = repository.get(c"uiLayoutFile")?;
    if !file.truthy()? {
        let path = p.get(c"path")?;
        let dir = call(path, c"dirname", &[repository.get(c"file")?])?;
        file = call(path, c"join", &[dir, text(d, "ui-layout.json")?])?;
    }
    let dirs = method(&env, repo, "listDirIds", 0, 0, |r, _| {
        call(call(r, c"map", &[])?, c"keys", &[])
    })?;
    let list = fields(d, &[("sessions", sessions), ("id", p.get(c"sessionId")?)])?;
    let ids = method(&env, list, "listSessionIds", 1, 1, |owner, args| {
        let sessions = owner.get(c"sessions")?;
        let rows = if sessions.truthy()?
            && sessions.get(c"listByDir")?.kind()? == sys::ValueType::napi_function
        {
            call(sessions, c"listByDir", args)?
        } else {
            owner.from_value(&V::Array(Vec::new()))?
        };
        call(rows, c"map", &[owner.get(c"id")?])
    })?;
    let layout = layout_store(
        &env,
        fields(
            d,
            &[
                ("file", file),
                ("logger", logger),
                ("listDirIds", dirs),
                ("listSessionIds", ids),
            ],
        )?,
        p.get(c"stateStore")?,
    )?;
    let host_deps = fields(
        d,
        &[
            ("repo", repo),
            ("git", git),
            ("sessions", sessions),
            ("events", events),
            ("fsPort", fs_port),
            ("helpers", helpers),
            ("tx", tx),
            ("uiLayout", layout),
            ("logger", logger),
        ],
    )?;
    let host = p.get(c"createDirectoryHost")?.call_plain(&[host_deps])?;
    Ok(fields(d, &[("repo", repo), ("host", host)])?.raw())
}

const SAMPLE_FILES: &[(&str, &str)] = &[
    (
        "README.md",
        r##"# MultiCC 入门示例

这是一个可随时从 MultiCC 移除的安全练习项目，不是正在运行的 MultiCC 源码。

## 推荐的第一条任务

请先查看这个工作区，再由产品、开发和测试角色分工，让欢迎页更适合第一次访问的用户。

## 文件

- `index.html`：欢迎页结构
- `styles.css`：页面样式
- `TASKS.md`：待改进事项
"##,
    ),
    (
        "index.html",
        r##"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>欢迎来到示例工作区</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main class="welcome">
    <p class="eyebrow">MULTICC PLAYGROUND</p>
    <h1>把一个想法交给你的 Agent 团队</h1>
    <p>这是一个很小的欢迎页。请让团队分析它，并完成一次安全、可检查的改进。</p>
    <button type="button">开始探索</button>
  </main>
</body>
</html>
"##,
    ),
    (
        "styles.css",
        r##":root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0d1117; color: #f0f6fc; }
.welcome { width: min(680px, calc(100% - 48px)); }
.eyebrow { color: #3ad6c5; font: 700 12px ui-monospace, monospace; letter-spacing: .14em; }
h1 { margin: 12px 0; font-size: clamp(36px, 8vw, 68px); line-height: 1; }
p { color: #9da7b3; line-height: 1.7; }
button { margin-top: 16px; padding: 12px 18px; border: 0; border-radius: 10px; background: #3ad6c5; color: #07110f; font-weight: 700; }
"##,
    ),
    (
        "TASKS.md",
        r##"# 待改进事项

- 第一次访问的人还不知道点击按钮后会发生什么。
- 页面缺少清晰的完成标准和下一步说明。
- 需要检查键盘操作、颜色对比度和移动端布局。
"##,
    ),
];

#[napi]
pub fn directory_ensure_sample(
    env: Env,
    fs_port: Unknown<'_>,
    path: Unknown<'_>,
) -> Result<sys::napi_value> {
    let fs = L::new(&env, fs_port);
    let path = L::new(&env, path);
    let root = call(
        path,
        c"join",
        &[call(fs, c"sampleRoot", &[])?, text(fs, "getting-started")?],
    )?;
    call(fs, c"mkdirp", &[root])?;
    let created = fs.from_value(&V::Array(Vec::new()))?;
    for &(name, content) in SAMPLE_FILES {
        let write = fs.get(c"writeFileExclusive")?;
        let name = text(fs, name)?;
        let file = call(path, c"join", &[root, name])?;
        if write.call(fs, &[file, text(fs, content)?])?.truthy()? {
            call(created, c"push", &[name])?;
        }
    }
    Ok(fields(
        fs,
        &[
            ("name", text(fs, "MultiCC 入门示例")?),
            ("path", root),
            ("createdFiles", created),
        ],
    )?
    .raw())
}
