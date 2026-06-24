'use strict';
// STUB — 待集成真实模块（另一会话实现）。
// 签名严格遵循 docs/codex-proxy-contract.md 模块 A/B。
// 真实实现合入后此文件应被覆盖删除/替换。

/**
 * Responses API 请求体 → Chat Completions 请求体（stub：原样透传，仅补 stream）。
 * @param {object} responsesBody
 * @returns {object} Chat Completions body
 */
function responsesToChat(responsesBody) {
  // stub: 直接透传，确保 stream:true
  return { ...responsesBody, stream: true };
}

/**
 * 创建 Chat SSE → Responses SSE 转换器（stub：行级透传，发 data: 原行）。
 * @param {(sseText:string)=>void} emit
 * @returns {{ pushLine:(line:string)=>void, end:()=>void }}
 */
function chatStreamToResponses(emit) {
  return {
    pushLine(line) {
      if (!line) return;
      // 透传：把上游 SSE 行原样转成 Responses-style 事件包，便于联调
      emit(`data: ${line}\n\n`);
    },
    end() {
      emit('data: [DONE]\n\n');
    },
  };
}

module.exports = { responsesToChat, chatStreamToResponses };
