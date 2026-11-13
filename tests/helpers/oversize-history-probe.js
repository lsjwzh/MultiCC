'use strict';

// 子进程探针：在受限堆里整份读一个工具密集的超长历史会话。
//
// 2026-11-13 的 OOM 事故就是这条路径：read_text 的 read_to_end 把整份
// transcript 读进内存，from_utf8_lossy().into_owned() 再复制一份，转成 JS
// 字符串时 UTF-8 变 UTF-16 体积翻倍，最后 parse_transcript 整份解析成对象
// 数组——实测 135MB 文件约 434MB 堆对象。放大倍数本身是设计的一部分，
// 但它【不能再变大】：谁再加一份整份拷贝，这个探针就会 FATAL OOM 退非 0。
//
// 之所以放到子进程用 --max-old-space-size 卡死，而不是在主测试里断言
// heapUsed：进程内 heapUsed 受 GC 时机影响，阈值判断会间歇红。
const v8 = require('node:v8');

const { createChatHistoryFileRepository } = require('../../src/session/adapters/chat-history-file-repository');

const [dataDir, sessionId] = process.argv.slice(2);
if (!dataDir || !sessionId) {
  console.error('usage: oversize-history-probe.js <dataDir> <sessionId>');
  process.exit(2);
}

const repository = createChatHistoryFileRepository({ dataDir });
const messages = repository.readStrict(sessionId);
// 只留尾部几条，模拟连接时的一页；整份数组在这之后才可回收。
const tail = messages.slice(-5);

process.stdout.write(JSON.stringify({
  messages: messages.length,
  tail: tail.length,
  tailHasTools: tail.every(message => message.role !== 'assistant' || Array.isArray(message.tools)),
  heapLimitMB: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576),
  heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1048576),
}));
