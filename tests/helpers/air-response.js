'use strict';

// /api/air 两个读接口支持条件请求（ETag → 304），处理器会自己把正文写进响应，
// 所以这里给出一个最小的 Express 响应替身：set/send/end 缺一不可。
// 需要断言正文时用 JSON.parse(res.body)（send 收到的是已序列化的 JSON 字符串）。
function airResponse() {
  return {
    statusCode: 200, headers: {}, body: undefined, headersSent: false, ended: false,
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; this.headersSent = true; return this; },
    end() { this.headersSent = true; this.ended = true; return this; },
    json(value) { this.body = JSON.stringify(value); this.headersSent = true; return this; },
  };
}

module.exports = { airResponse };
