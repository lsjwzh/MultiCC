'use strict';

// 只读观测器（测试专用）：测试台用 `node -r <本文件> server.js` 起真服务端时，
// 把 attachH264Bridge 包一层，把桥自己维护的 stats（transport / p2pOpened / …）
// 以及「这条 WS 上收到了多少条客户端二进制帧」定期写进一个 JSON 文件。
//
// 它不改任何行为：只旁听 ws 的 'message' 事件、读桥返回的 stats 对象（桥本来
// 就把它交给调用方，只是 connection-router 丢掉了）。生产路径不会加载本文件。
// 测试台的控制口 GET /p2p 把文件内容透给模拟器里的集成测试 —— 用它证明
// 「rtc-active 之后输入的字节没有再从 WS 中继走，而是走了 DataChannel」。
//
// 环境变量：
//   MULTICC_TEST_P2P_STATS_FILE  输出文件（未设置时本模块什么都不做）

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const out = process.env.MULTICC_TEST_P2P_STATS_FILE;

if (out) {
  const load = Module._load;
  let wrapped = false;
  let seq = 0;

  const write = state => {
    try {
      const tmp = `${out}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, out);
    } catch {}
  };

  Module._load = function (request, parent, isMain) {
    const exported = load.call(this, request, parent, isMain);
    if (
      wrapped ||
      !parent ||
      path.basename(parent.filename) !== 'remote-screen.js' ||
      !/(^|[\\/])remote-screen-h264-bridge$/.test(request)
    ) {
      return exported;
    }
    wrapped = true;
    const attach = exported.attachH264Bridge;
    exported.attachH264Bridge = function (ws, options) {
      const bridge = attach.call(this, ws, options);
      const id = ++seq;
      const state = { id, stats: bridge.stats, wsBinary: 0 };
      const tick = () => write({ ...state, at: Date.now() });
      const onMessage = (data, isBinary) => {
        if (isBinary) state.wsBinary += 1;
        tick();
      };
      ws.on('message', onMessage);
      const timer = setInterval(tick, 100);
      timer.unref?.();
      ws.on('close', () => {
        tick();
        clearInterval(timer);
      });
      tick();
      return bridge;
    };
    return exported;
  };
}
