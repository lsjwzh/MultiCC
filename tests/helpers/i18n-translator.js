'use strict';

// 页面脚本现在都通过全局 t() 取文案（i18n.js 在真页面上提供它）。vm 沙箱里没有
// i18n.js，脚本一调 t() 就 ReferenceError —— 单元测试不该为此再拉一个 i18n 运行时
// 进来，所以这里给一个只查 zh.json 的替身：中文目录就是这些测试断言的原文，
// 顺手也把「模块引用的 key 在词典里存不存在」变成一次性的硬检查。
//
// 缺 key 时返回 key 本身，和真 t() 的兜底一致 —— 断言里出现一个 key 字面量，
// 比抛 ReferenceError 更容易看出是哪一条没登记。
const fs = require('node:fs');
const path = require('node:path');

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'assets', 'i18n', 'zh.json'), 'utf8'));

function t(key, params) {
  const text = Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : key;
  if (!params) return text;
  return String(text).replace(/\{(\w+)\}/g, (whole, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
  ));
}

// i18n.js 里和 t 一起挂在 window 上的还有 getLocale()：所有 Intl / toLocaleString
// 都要求传它，不许写字面量。沙箱里的语言就是默认的中文，于是它恒为 'zh-CN'。
const getLocale = () => 'zh-CN';

module.exports = { t, getLocale, catalog };
