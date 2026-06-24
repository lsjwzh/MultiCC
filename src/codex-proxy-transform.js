'use strict';

// ── Codex Responses API ↔ Chat Completions 协议转换 ──
// 纯函数模块。让 codex CLI（只支持 wire_api="responses"）能连只提供
// /chat/completions 的国产 LLM 服务商（DeepSeek/GLM/Qwen 等）。

// ── UUID 工具 ───────────────────────────────────────────────────────────────
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
function shortId(prefix, n) { return `${prefix}_${n}`; }

// ═══════════════════════════════════════════════════════════════════════════════
// 模块 A：请求转换 — Responses API body → Chat Completions body
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 把 codex 发来的 Responses API 请求体转成 Chat Completions 请求体。
 * @param {object} responsesBody  codex 的 POST /responses 请求体
 * @returns {object} Chat Completions body
 */
function responsesToChat(responsesBody) {
  const messages = [];

  // 1. instructions → system message 首条
  if (responsesBody.instructions) {
    messages.push({ role: 'system', content: responsesBody.instructions });
  }

  // 2. input[] → messages
  const input = responsesBody.input || [];
  for (const item of input) {
    switch (item.type) {
      case 'message': {
        // role: developer → system（DeepSeek 不认 developer）
        const role = item.role === 'developer' ? 'system' : item.role;
        // 拼接所有 input_text
        const parts = (item.content || [])
          .filter(c => c.type === 'input_text')
          .map(c => c.text)
          .join('');
        messages.push({ role, content: parts });
        break;
      }
      case 'function_call': {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: item.call_id,
            type: 'function',
            function: { name: item.name, arguments: item.arguments || '' },
          }],
        });
        break;
      }
      case 'function_call_output': {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: item.output || '',
        });
        break;
      }
      // 忽略未知 type
    }
  }

  // 3. tools: Responses 扁平格式 → Chat 嵌套格式
  const tools = (responsesBody.tools || []).map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));

  // 4. 构建 Chat body
  const chatBody = {
    model: responsesBody.model || 'deepseek-chat',
    messages,
    stream: true,
  };

  if (tools.length > 0) chatBody.tools = tools;
  if (responsesBody.tool_choice != null) chatBody.tool_choice = responsesBody.tool_choice;
  if (responsesBody.parallel_tool_calls != null) {
    chatBody.parallel_tool_calls = responsesBody.parallel_tool_calls;
  }
  // 5. 丢弃: reasoning, store, include, prompt_cache_key, client_metadata

  return chatBody;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 模块 B：流式响应转换 — Chat SSE → Responses SSE 状态机
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 创建 Chat Completions SSE 流 → Responses SSE 事件的转换器。
 *
 * 用法：
 *   const tx = chatStreamToResponses((sse) => upstreamResponse.write(sse));
 *   for (const line of chatSseLines) tx.pushLine(line);
 *   tx.end();
 *
 * @param {(sseText:string)=>void} emit  把构造好的 SSE 文本写出
 * @returns {{ pushLine: (line:string)=>void, end: (errorMsg?:string)=>void }}
 */
function chatStreamToResponses(emit) {
  const RESPONSE_ID = 'resp_' + uuid().replace(/-/g, '').slice(0, 12);

  // ── 状态 ──
  let _finished = false;
  let _headerSent = false;         // response.created 已发？
  let _textStarted = false;        // output_item.added (message) 已发？
  let _textPartStarted = false;    // content_part.added 已发？
  let _textContentIndex = 0;       // content_index（同一 message 内第几个 output_text）
  let _textItemFinished = false;   // output_item.done (message) 已发？

  let _toolIndex = 0;              // 第几个 function_call
  const _toolItems = [];           // [{id, call_id, name, arguments, itemDone, accArgs}]
  let _currentToolName = '';       // 当前在聚合的 tool_call 名称
  let _currentToolId = '';         // 当前 tool_call 的 id
  let _toolStarted = false;        // 当前 tool call 的 output_item.added 已发？
  let _toolAccArgs = '';           // 当前 tool call 累积的 arguments

  const _outputItems = [];         // 所有 output item（用于 response.completed）
  let _lastUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let _model = '';

  // ── 发送 SSE 事件 ──
  function sse(eventType, data) {
    emit(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // ── 确保文本 item 已打开 ──
  function ensureTextItem(contentSoFar) {
    if (_textItemFinished) return; // 文本项已关闭，不再新建
    if (!_textStarted) {
      const itemId = shortId('msg', 0);
      const item = { type: 'message', id: itemId, role: 'assistant', content: [] };
      _outputItems.push(item);
      sse('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: _outputItems.length - 1,
        item,
      });
      _textStarted = true;
    }
    if (!_textPartStarted) {
      const part = { type: 'output_text', text: '' };
      const itemId = shortId('msg', 0);
      sse('response.content_part.added', {
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: 0,
        content_index: _textContentIndex,
        part,
      });
      _textPartStarted = true;
    }
  }

  // ── 关闭文本 item ──
  function finishTextItem(fullText) {
    if (_textItemFinished) return;
    const itemId = shortId('msg', 0);
    const ci = _textContentIndex;

    // output_text.done
    sse('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: 0,
      content_index: ci,
      text: fullText,
    });
    // content_part.done
    sse('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: itemId,
      output_index: 0,
      content_index: ci,
      part: { type: 'output_text', text: fullText },
    });
    // output_item.done
    const msgItem = { type: 'message', id: itemId, role: 'assistant',
      content: [{ type: 'output_text', text: fullText }] };
    sse('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: msgItem,
    });
    // Update stored item
    if (_outputItems.length > 0 && _outputItems[0].type === 'message') {
      _outputItems[0].content = [{ type: 'output_text', text: fullText }];
    }
    _textItemFinished = true;
  }

  // ── 确保当前 tool call item 已打开 ──
  function ensureToolItem(name, callId) {
    if (_toolStarted && _currentToolName === name && _currentToolId === callId) return;
    // 关闭上一个 tool item（如果还在进行中）
    if (_toolStarted) {
      finishToolItem();
    }
    _currentToolName = name;
    _currentToolId = callId || shortId('fc', _toolIndex);
    _toolAccArgs = '';
    _toolStarted = true;

    const item = {
      type: 'function_call',
      id: _currentToolId,
      call_id: _currentToolId,
      name: _currentToolName,
      arguments: '',
    };
    _outputItems.push(item);

    sse('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: _outputItems.length - 1,
      item,
    });
    _toolIndex++;
  }

  // ── 关闭当前 tool call item ──
  function finishToolItem() {
    if (!_toolStarted) return;
    sse('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: _currentToolId,
      output_index: _outputItems.length - 1,
      arguments: _toolAccArgs,
    });
    const fcItem = { type: 'function_call', id: _currentToolId,
      call_id: _currentToolId, name: _currentToolName, arguments: _toolAccArgs };
    sse('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: _outputItems.length - 1,
      item: fcItem,
    });
    // Update stored item
    if (_outputItems.length > 0) {
      _outputItems[_outputItems.length - 1] = fcItem;
    }
    _toolStarted = false;
  }

  // ── 主入口：推送一行 ──
  function pushLine(line) {
    if (_finished) return;

    const s = line.trim();
    if (!s) return;           // 空行
    if (!s.startsWith('data:')) return;  // 非 data 行

    const payload = s.slice(5).trim();

    // [DONE]
    if (payload === '[DONE]') { end(); return; }

    let obj;
    try { obj = JSON.parse(payload); }
    catch (_) { return; }     // 非 JSON 行忽略

    // 记录 model
    if (obj.model) _model = obj.model;
    if (obj.usage) _lastUsage = {
      input_tokens: obj.usage.prompt_tokens || obj.usage.input_tokens || 0,
      output_tokens: obj.usage.completion_tokens || obj.usage.output_tokens || 0,
      total_tokens: obj.usage.total_tokens || 0,
    };

    const choice = (obj.choices && obj.choices.length > 0) ? obj.choices[0] : null;
    if (!choice) return;

    const delta = choice.delta || {};
    const finishReason = choice.finish_reason;

    // ── 发 header（首次有内容时） ──
    if (!_headerSent) {
      _headerSent = true;
      sse('response.created', {
        type: 'response.created',
        response: {
          id: RESPONSE_ID,
          object: 'response',
          status: 'in_progress',
          model: _model || '',
          output: [],
        },
      });
    }

    // ── tool_calls ──
    if (delta.tool_calls && delta.tool_calls.length > 0) {
      // tool_calls 来时，如果文本 item 还在进行中，先关闭它
      if (_textStarted && !_textItemFinished) {
        finishTextItem('');
      }

      for (const tc of delta.tool_calls) {
        const tcId = tc.id || '';
        const fn = tc.function || {};

        // 首次出现 → 打开 item
        if (tcId && !_toolStarted) {
          ensureToolItem(fn.name || '', tcId);
        } else if (tcId && tcId !== _currentToolId && _toolStarted) {
          // 新的 tool_call id
          ensureToolItem(fn.name || '', tcId);
        } else if (!_toolStarted) {
          ensureToolItem(fn.name || '', tcId);
        }

        // 累积 arguments
        if (fn.arguments) {
          _toolAccArgs += fn.arguments;
          sse('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: _currentToolId,
            output_index: _outputItems.length - 1,
            delta: fn.arguments,
          });
        }
      }
      return;
    }

    // ── 文本 delta ──
    const content = delta.content;
    if (content !== undefined && content !== null) {
      // 如果正在累积 tool，先关闭
      if (_toolStarted) { finishToolItem(); }

      ensureTextItem(content);
      const itemId = shortId('msg', 0);
      sse('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: itemId,
        output_index: 0,
        content_index: _textContentIndex,
        delta: typeof content === 'string' ? content : String(content),
      });
      return;
    }

    // ── finish_reason: stop → 关闭文本 item ──
    if (finishReason === 'stop' || finishReason === 'length') {
      if (_toolStarted) { finishToolItem(); }
      if (_textStarted && !_textItemFinished) { finishTextItem(''); }
    }
  }

  // ── 结束 ──
  function end(errorMsg) {
    if (_finished) return;
    _finished = true;

    if (errorMsg) {
      sse('response.failed', {
        type: 'response.failed',
        response: { status: 'failed', error: { message: errorMsg } },
      });
      return;
    }

    // 关闭任何还在进行中的 item
    if (_toolStarted) { finishToolItem(); }
    if (_textStarted && !_textItemFinished) { finishTextItem(''); }

    // response.completed
    sse('response.completed', {
      type: 'response.completed',
      response: {
        id: RESPONSE_ID,
        status: 'completed',
        output: _outputItems,
        usage: _lastUsage,
      },
    });
  }

  return { pushLine, end };
}

module.exports = { responsesToChat, chatStreamToResponses };
