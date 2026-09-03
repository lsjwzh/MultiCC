'use strict';

const path = require('path');

const SAMPLE_SLUG = 'getting-started';
const SAMPLE_NAME = 'MultiCC 入门示例';

const SAMPLE_FILES = Object.freeze([
  Object.freeze({
    name: 'README.md',
    content: `# MultiCC 入门示例

这是一个可随时从 MultiCC 移除的安全练习项目，不是正在运行的 MultiCC 源码。

## 推荐的第一条任务

请先查看这个工作区，再由产品、开发和测试角色分工，让欢迎页更适合第一次访问的用户。

## 文件

- \`index.html\`：欢迎页结构
- \`styles.css\`：页面样式
- \`TASKS.md\`：待改进事项
`,
  }),
  Object.freeze({
    name: 'index.html',
    content: `<!doctype html>
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
`,
  }),
  Object.freeze({
    name: 'styles.css',
    content: `:root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0d1117; color: #f0f6fc; }
.welcome { width: min(680px, calc(100% - 48px)); }
.eyebrow { color: #3ad6c5; font: 700 12px ui-monospace, monospace; letter-spacing: .14em; }
h1 { margin: 12px 0; font-size: clamp(36px, 8vw, 68px); line-height: 1; }
p { color: #9da7b3; line-height: 1.7; }
button { margin-top: 16px; padding: 12px 18px; border: 0; border-radius: 10px; background: #3ad6c5; color: #07110f; font-weight: 700; }
`,
  }),
  Object.freeze({
    name: 'TASKS.md',
    content: `# 待改进事项

- 第一次访问的人还不知道点击按钮后会发生什么。
- 页面缺少清晰的完成标准和下一步说明。
- 需要检查键盘操作、颜色对比度和移动端布局。
`,
  }),
]);

function ensureSampleWorkspace(fsPort) {
  const root = path.join(fsPort.sampleRoot(), SAMPLE_SLUG);
  fsPort.mkdirp(root);
  const createdFiles = [];
  for (const file of SAMPLE_FILES) {
    if (fsPort.writeFileExclusive(path.join(root, file.name), file.content)) createdFiles.push(file.name);
  }
  return { name: SAMPLE_NAME, path: root, createdFiles };
}

module.exports = { SAMPLE_FILES, SAMPLE_NAME, SAMPLE_SLUG, ensureSampleWorkspace };
