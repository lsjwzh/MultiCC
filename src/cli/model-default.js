'use strict';

// 选择规则、历史快照及查询缓存均由 Rust 持有；这里只装配宿主读端口。

const { getNative } = require('../native/runtime');

function createModelDefaultResolver({ history, now, historyTtlMs }) {
  const owner = new (getNative().RustModelDefaults)(historyTtlMs);
  return request => owner.resolve(request, history, now);
}

module.exports = { createModelDefaultResolver };
