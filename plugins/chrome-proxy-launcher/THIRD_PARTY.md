# 第三方组件

## meow（mihomo 的 Rust 重实现）

- 文件：`bin/<平台>-<架构>/meow.gz`（Windows 为 `meow.exe.gz`；gzip 压缩的单文件内核，解压后约 9MB）。仓库只提交 `darwin-arm64`，其余平台由发版流水线按 `bundled-binaries.json` 下载并校验后生成
- 版本：v0.26.1（2026-10-21 发布，`meow 0.26.1`）
- 来源：<https://github.com/meow-rs/meow-rs/releases/tag/v0.26.1>
- 各平台下载地址与 sha256（上游原包）以 `bundled-binaries.json` 为唯一来源；macOS arm64 为
  <https://github.com/meow-rs/meow-rs/releases/download/v0.26.1/meow-v0.26.1-aarch64-apple-darwin.tar.gz>，
  sha256 `1fbc19f54a51469dab03253ede4d4186e19517ccfb8a76f00657cc32f543d5ae`
- Linux 使用 musl 静态构建（x64 / arm64），Windows 使用 msvc 构建
- 许可证：**MIT**（见上游仓库 <https://github.com/meow-rs/meow-rs/blob/main/LICENSE>）
- 源码：<https://github.com/meow-rs/meow-rs>（tag `v0.26.1`）

插件只在需要「订阅节点」出口时启动这个二进制，参数为
`meow -d <身份目录> -f <生成的配置绝对路径>`；它作为独立进程运行，插件不修改其代码。
首次使用时插件会把 `.gz` 解压到
`~/.multicc/plugins-data/chrome-proxy-launcher/runtime/meow` 并复用。

本文件里的 `.gz` 是从上游 tar.gz 中取出的单文件重新压缩的，内容与上游
`meow-v0.26.1-aarch64-apple-darwin/meow` 一致。

### 更新内核

改 `bundled-binaries.json` 里每个平台的 `url` 与 `sha256`（sha256 取上游 release 页给出的
digest），然后重新执行 `node scripts/build-plugin-binaries.js --platform … --arch …`。
macOS arm64 的 `meow.gz` 随仓库提交，更新后一并提交。
