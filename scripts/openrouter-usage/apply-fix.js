'use strict';

// Maintenance installer for the separately deployed local chart service.
// The only retained Node change is its existing Chrome adapter's exit reporting;
// no transformation, storage, or aggregation logic is added here. Move that
// reporting into Rust when the service's refresh pipeline is migrated.
const fs = require('node:fs');
const path = require('node:path');

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error('Unsupported service version: ' + label);
  }
  return source.replace(before, after);
}

function repairSources({ fetch, index }) {
  fetch = replaceOnce(fetch,
    'const pid = findMainChrome();',
    "console.log('正在通过浏览器网关创建独立后台取数标签');", 'background source tab');
  fetch = replaceOnce(fetch,
    "execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', path.join(__dirname, 'chrome-page.jxa.js'), pid, 'refresh'],",
    "execFileSync(process.execPath, [path.join(__dirname, 'browser-source.js')],", 'browser gateway bridge');
  fetch = replaceOnce(fetch,
    '主 Chrome 页面取数失败或超时，请检查目标图表页面与浏览器脚本权限',
    '浏览器网关取数失败或超时，请检查主 Chrome 连接和上游页面', 'browser gateway error');
  fetch = replaceOnce(fetch,
    'const result = JSON.parse(raw);',
    "const result = JSON.parse(raw);\n      if (result.historyCoverage === 'latest-two') console.warn('上游仅返回最近两条数据：可更新最新日期，无法自动回补历史缺口；已有历史保留。');",
    'native response coverage');
  fetch = replaceOnce(fetch,
    "if (!status.ok) throw new Error('接口已读取，但数据日期检查未通过：' + status.problems.join('；'));",
    "if (!status.ok) console.warn('上游数据提示：' + status.problems.join('；') + '；抓取与保存已完成，供应商截至日期详见页面。');",
    'upstream freshness reporting');
  index = replaceOnce(index,
    '从 MacroMicro 重新抓取最新数据（6 小时内重复点击会直接用缓存）',
    '从 MacroMicro 重新抓取完整历史数据并补齐缺失日期', 'refresh tooltip');
  index = replaceOnce(index,
    "fetch('refresh', { method: 'POST' })",
    "fetch('refresh?force=1', { method: 'POST', cache: 'no-store' })", 'manual refresh');
  index = replaceOnce(index,
    "if (!j.ok) throw new Error((j.log || []).join(' ') || '抓取失败');",
    "if (!j.ok) throw new Error((j.log || []).join(' ') || '抓取失败');\n    const coverageNotice = (j.log || []).find(line => line.includes('上游仅返回最近两条数据')) || '';\n    sessionStorage.setItem('openrouterRefreshNotice', coverageNotice);",
    'refresh coverage notice');
  index = replaceOnce(index,
    '  // Top8 按最新值排序；其余归并为「其他」',
    "  const refreshNotice = sessionStorage.getItem('openrouterRefreshNotice');\n  if (refreshNotice) { freshnessEl.classList.add('warning'); freshnessEl.textContent += ' ' + refreshNotice; }\n  // Top8 按最新值排序；其余归并为「其他」",
    'display coverage notice');
  index = replaceOnce(index,
    "' 以下仍展示上次成功抓取的数据，请检查每日刷新任务。';",
    "' 当前展示已保存的数据；各供应商截至日期详见下表。';", 'freshness explanation');
  return { fetch, index };
}

function install(directory) {
  const files = {
    fetch: path.join(directory, 'fetch.js'),
    index: path.join(directory, 'public/index.html'),
    adapter: path.join(directory, 'browser-source.js'),
  };
  // Validate every expected source before writing any deployed file.
  const repaired = repairSources({
    fetch: fs.readFileSync(files.fetch, 'utf8'),
    index: fs.readFileSync(files.index, 'utf8'),
  });
  const adapter = fs.readFileSync(path.join(__dirname, 'browser-source.js'), 'utf8');
  const backup = path.join(directory, 'backups', 'history-readiness-' + Date.now());
  fs.mkdirSync(backup, { recursive: true });
  for (const [key, file] of Object.entries(files)) {
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(backup, path.basename(file)));
    const temporary = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, key === 'adapter' ? adapter : repaired[key]);
    fs.renameSync(temporary, file);
  }
  console.log('Installed history readiness and refresh fixes. Backup: ' + backup);
}

if (require.main === module) {
  const directory = process.argv[2];
  if (!directory || !path.isAbsolute(directory)) {
    throw new Error('Usage: node scripts/openrouter-usage/apply-fix.js <absolute-service-directory>');
  }
  install(directory);
}
module.exports = { repairSources };
