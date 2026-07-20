'use strict';

// DOM adapter for classic chat history. The state machine remains in
// chat-history-store.js; this module is the only owner of persisted-message
// hydration, upsert, tool-card DOM and the live assistant Markdown surface.
(function attachChatHistoryView(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCChatHistoryView = api;
})(typeof window !== 'undefined' ? window : globalThis, function createApi() {
  const TOOL_ICONS = Object.freeze({
    Bash: '>', Read: '📄', Edit: '✎', Write: '💾',
    Glob: '🔍', Grep: '🔎', Agent: '🤖',
  });

  function asText(value) {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }

  function createHistoryView(options) {
    const settings = options && typeof options === 'object' ? options : {};
    const document = settings.document;
    const messagesEl = settings.messagesEl;
    if (!document || !messagesEl) throw new TypeError('document and messagesEl are required');

    const safeMarkdown = settings.safeMarkdown;
    const fixupLocalImages = typeof settings.fixupLocalImages === 'function'
      ? settings.fixupLocalImages : function noop() {};
    const highlightCodeBlocks = typeof settings.highlightCodeBlocks === 'function'
      ? settings.highlightCodeBlocks : function noop() {};
    const buildUsageLine = typeof settings.buildUsageLine === 'function'
      ? settings.buildUsageLine : function noUsage() { return null; };
    const buildTimingLine = typeof settings.buildTimingLine === 'function'
      ? settings.buildTimingLine : function noTiming() { return null; };
    const attachDeleteButton = typeof settings.attachDeleteButton === 'function'
      ? settings.attachDeleteButton : function noop() {};
    const attachForkButton = typeof settings.attachForkButton === 'function'
      ? settings.attachForkButton : function noop() {};
    const warn = typeof settings.warn === 'function' ? settings.warn : function noop() {};

    function truncate(value, limit) {
      const text = asText(value);
      return text.length > limit ? text.slice(0, limit) + '...' : text;
    }

    function directChildByClass(parent, className) {
      for (const child of Array.from(parent.children || [])) {
        if (child.classList && child.classList.contains(className)) return child;
      }
      return null;
    }

    // This is the sole Markdown HTML sink in the chat view. MultiCCSafeMarkdown
    // either returns DOMPurify-sanitized markup or escaped plain text. If that
    // boundary is unavailable or throws, this host writes source as textContent.
    function createMarkdownRoot(source) {
      const root = document.createElement('div');
      root.className = 'message-markdown';
      const text = asText(source);
      if (!text) return root;
      if (!safeMarkdown || typeof safeMarkdown.render !== 'function') {
        root.textContent = text;
        return root;
      }
      try {
        const safeHtml = safeMarkdown.render(text);
        root.innerHTML = typeof safeHtml === 'string' ? safeHtml : '';
      } catch (_) {
        root.textContent = text;
      }
      return root;
    }

    function renderMarkdownInto(contentEl, source, final) {
      const previous = directChildByClass(contentEl, 'message-markdown');
      const markdownRoot = createMarkdownRoot(source);
      if (previous) previous.replaceWith(markdownRoot);
      else contentEl.insertBefore(markdownRoot, contentEl.firstElementChild || null);
      fixupLocalImages(markdownRoot);
      if (final) highlightCodeBlocks(markdownRoot);
      return markdownRoot;
    }

    function renderCurrentText(bubble, source, options = {}) {
      if (!bubble) return null;
      const contentEl = bubble.querySelector('.msg-content');
      if (!contentEl) return null;
      renderMarkdownInto(contentEl, source, !!options.final);
      if (options.streaming && !options.final) contentEl.classList.add('streaming-dot');
      else contentEl.classList.remove('streaming-dot');
      return contentEl;
    }

    function getToolStack(contentEl) {
      let stack = directChildByClass(contentEl, 'tool-stack');
      if (!stack) {
        stack = document.createElement('div');
        stack.className = 'tool-stack';
        contentEl.appendChild(stack);
      }
      return stack;
    }

    function appendToolCard(contentEl, card) {
      const stack = getToolStack(contentEl);
      stack.appendChild(card);
      stack.scrollTop = stack.scrollHeight;
      return card;
    }

    function createToolCard(name, id) {
      const toolName = asText(name || 'Tool');
      const card = document.createElement('div');
      card.className = 'tool-card';
      if (id) card.dataset.toolId = asText(id);

      const header = document.createElement('div');
      header.className = 'tool-header';
      const icon = document.createElement('span');
      icon.className = 'tool-icon';
      icon.textContent = TOOL_ICONS[toolName] || '⚙';
      const nameEl = document.createElement('span');
      nameEl.className = 'tool-name';
      nameEl.textContent = toolName;
      const description = document.createElement('span');
      description.className = 'tool-desc';
      description.textContent = 'running...';
      const arrow = document.createElement('span');
      arrow.className = 'tool-arrow';
      arrow.textContent = '▶';
      header.appendChild(icon);
      header.appendChild(nameEl);
      header.appendChild(description);
      header.appendChild(arrow);
      header.onclick = () => card.classList.toggle('open');

      const body = document.createElement('div');
      body.className = 'tool-body';
      const input = document.createElement('pre');
      input.className = 'tool-input';
      body.appendChild(input);
      card.appendChild(header);
      card.appendChild(body);
      return card;
    }

    function updateToolInput(toolState) {
      if (!toolState || !toolState.card) return;
      const input = toolState.card.querySelector('.tool-input');
      const description = toolState.card.querySelector('.tool-desc');
      if (!input) return;
      try {
        const parsed = JSON.parse(toolState.inputJson || '{}');
        const summary = parsed.description || parsed.command || parsed.pattern || parsed.file_path || '';
        if (summary && description) description.textContent = truncate(summary, 60);
        input.textContent = JSON.stringify(parsed, null, 2);
      } catch (_) {
        input.textContent = asText(toolState.inputJson);
      }
    }

    function addToolResult(toolState, value, isError) {
      if (!toolState || !toolState.card) return;
      const body = toolState.card.querySelector('.tool-body');
      if (!body) return;
      // A repeated tool_result is an upsert, not a second result block.
      for (const old of Array.from(body.querySelectorAll('.tool-result-owned'))) old.remove();
      const label = document.createElement('div');
      label.className = 'tool-result-label tool-result-owned' + (isError ? ' error' : '');
      label.textContent = isError ? 'Error:' : 'Result:';
      const result = document.createElement('pre');
      result.className = 'tool-result-owned';
      result.textContent = truncate(value, 2000);
      body.appendChild(label);
      body.appendChild(result);
      const description = toolState.card.querySelector('.tool-desc');
      if (description) description.textContent = isError ? 'failed' : 'done';
    }

    function hydrateTool(tool, contentEl) {
      const id = tool.id || tool.tool_use_id || '';
      const card = createToolCard(tool.name || 'Tool', id);
      const state = {
        card,
        inputJson: tool.input == null ? '{}' : JSON.stringify(tool.input),
        name: tool.name || 'Tool',
        id,
      };
      updateToolInput(state);
      if (tool.result !== undefined) addToolResult(state, tool.result, !!tool.is_error);
      else {
        const description = card.querySelector('.tool-desc');
        const input = tool.input && typeof tool.input === 'object' ? tool.input : {};
        const summary = input.description || input.command || input.pattern || input.file_path || '';
        if (description && !summary) description.textContent = '?';
      }
      appendToolCard(contentEl, card);
      return state;
    }

    function attachMessageActions(node, message) {
      if (message.clientMsgId) node.dataset.clientMsgId = message.clientMsgId;
      if (!message.id) return;
      node.dataset.msgId = message.id;
      attachDeleteButton(node);
      attachForkButton(node);
    }

    function renderAssistant(message) {
      const node = document.createElement('div');
      node.className = 'msg assistant';
      const contentEl = document.createElement('div');
      contentEl.className = 'msg-content';
      if (message.content) renderMarkdownInto(contentEl, message.content, true);
      for (const tool of Array.isArray(message.tools) ? message.tools : []) hydrateTool(tool, contentEl);
      if (message.cancelled) {
        const tag = document.createElement('div');
        tag.className = 'msg system-msg';
        tag.style.cssText = 'font-size:11px;color:#f85149;padding:2px 0;';
        tag.textContent = '(cancelled)';
        contentEl.appendChild(tag);
      }
      if (message.usage) {
        const usage = buildUsageLine(message.usage);
        if (usage) contentEl.appendChild(usage);
      }
      const timing = buildTimingLine(message);
      if (timing) contentEl.appendChild(timing);
      node.appendChild(contentEl);
      attachMessageActions(node, message);
      return node;
    }

    function renderUser(message) {
      const node = document.createElement('div');
      node.className = 'msg user';
      node.textContent = message.content || '';
      if (Array.isArray(message.bgToolUseIds) && message.bgToolUseIds.length) {
        const tag = document.createElement('div');
        tag.textContent = '🔁 后台任务回流' + (message.bgToolUseIds.length > 1 ? ` ×${message.bgToolUseIds.length}` : '');
        tag.style.cssText = 'font-size:11px;color:#8b949e;margin-top:6px;border-top:1px dashed rgba(139,164,158,.35);padding-top:4px;';
        node.appendChild(tag);
      }
      attachMessageActions(node, message);
      return node;
    }

    function renderMessage(message) {
      const source = message && typeof message === 'object' ? message : {};
      if (source.role === 'user') return renderUser(source);
      if (source.role === 'assistant') return renderAssistant(source);
      const node = document.createElement('div');
      node.className = 'msg system-msg';
      node.textContent = source.content || '';
      if (source.id) node.dataset.msgId = source.id;
      return node;
    }

    function historyElements() {
      return Array.from(messagesEl.querySelectorAll('.msg[data-msg-id]'));
    }

    function findById(id) {
      if (!id) return null;
      return historyElements().find(element => element.dataset.msgId === id) || null;
    }

    function findByClientMsgId(clientMsgId) {
      if (!clientMsgId) return null;
      return Array.from(messagesEl.querySelectorAll('.msg'))
        .find(element => element.dataset.clientMsgId === clientMsgId) || null;
    }

    function visibleIds() {
      return historyElements().map(element => element.dataset.msgId).filter(Boolean);
    }

    function nextVisibleId(excludedId) {
      const node = historyElements().find(element => element.dataset.msgId !== excludedId);
      return node ? node.dataset.msgId : null;
    }

    function removeById(id) {
      const node = findById(id);
      if (node) node.remove();
      return node;
    }

    function hydrateStreamingTools(message, bubble) {
      const cards = new Map();
      if (!message || !Array.isArray(message.tools) || !bubble) return cards;
      const available = Array.from(bubble.querySelectorAll('.tool-card[data-tool-id]'));
      for (const tool of message.tools) {
        const id = tool.id || tool.tool_use_id;
        if (!id) continue;
        const card = available.find(element => element.dataset.toolId === id);
        if (!card) continue;
        cards.set(`history:${id}`, {
          card,
          inputJson: tool.input ? JSON.stringify(tool.input) : '',
          name: tool.name || 'Tool',
          id,
        });
      }
      return cards;
    }

    function replaceMessageNode(existing, node, hostState = {}) {
      let currentElement = hostState.currentElement || null;
      let lastUserElement = hostState.lastUserElement || null;
      const wasCurrent = currentElement === existing;
      const wasLastUser = lastUserElement === existing;
      const pendingAutoCommit = wasLastUser ? existing.querySelector('.msg-auto-commit') : null;
      if (pendingAutoCommit) node.appendChild(pendingAutoCommit);
      existing.replaceWith(node);
      if (wasCurrent) currentElement = node;
      if (wasLastUser) lastUserElement = node;
      return { currentElement, lastUserElement };
    }

    function commitMessage(message, hostState = {}) {
      const source = message && typeof message === 'object' ? message : {};
      if (!source.id || !source.role) {
        return Object.freeze({
          node: null,
          currentElement: hostState.currentElement || null,
          lastUserElement: hostState.lastUserElement || null,
        });
      }

      let existing = findById(source.id) || findByClientMsgId(source.clientMsgId);
      if (!existing && source.role === 'assistant') {
        existing = Array.from(messagesEl.querySelectorAll('.msg.assistant:not([data-msg-id])')).pop() || null;
      }

      const node = renderMessage(source);
      if (!existing) {
        messagesEl.appendChild(node);
        return Object.freeze({
          node,
          currentElement: hostState.currentElement || null,
          lastUserElement: source.role === 'user' ? node : (hostState.lastUserElement || null),
        });
      }

      const next = replaceMessageNode(existing, node, hostState);
      return Object.freeze({ node, ...next });
    }

    function reorderAuthoritativeNodes(plan, currentElement) {
      const messages = Array.isArray(plan.messages) ? plan.messages : [];
      const ordered = [];
      const seen = new Set();
      const authoritativeIds = new Set();
      const tail = messages[messages.length - 1];
      let streamingTailNode = null;
      for (const message of messages) {
        if (message && message.id) authoritativeIds.add(message.id);
        let node = message && message.id ? findById(message.id) : null;
        if (!node && message === tail && message?.role === 'assistant' && message.streaming) {
          node = currentElement?.classList.contains('assistant')
            ? currentElement
            : Array.from(messagesEl.querySelectorAll('.msg.assistant:not([data-msg-id])')).pop() || null;
          streamingTailNode = node;
        }
        if (!node || seen.has(node)) continue;
        seen.add(node);
        ordered.push(node);
      }
      if (!ordered.length) return;

      const children = Array.from(messagesEl.children);
      let orderedIndex = 0;
      const nextChildren = [];
      for (const child of children) {
        const isAuthoritativeSlot = authoritativeIds.has(child.dataset.msgId)
          || (streamingTailNode && child === streamingTailNode);
        if (!isAuthoritativeSlot) {
          nextChildren.push(child);
          continue;
        }
        // Replace every authoritative page slot in-place. Extra slots are stale
        // duplicate DOM nodes and are deliberately dropped.
        if (orderedIndex < ordered.length) nextChildren.push(ordered[orderedIndex++]);
      }
      while (orderedIndex < ordered.length) nextChildren.push(ordered[orderedIndex++]);
      messagesEl.replaceChildren(...nextChildren);
    }

    function applyPlan(plan, hostState = {}) {
      let currentElement = hostState.currentElement || null;
      let lastUserElement = hostState.lastUserElement || null;
      if (plan.hasMore) messagesEl.querySelector('.history-start-hint')?.remove();
      for (let index = 0; index < plan.operations.length; index += 1) {
        const operation = plan.operations[index];
        try {
          let existing = operation.id ? findById(operation.id) : null;
          if (!existing && operation.message?.clientMsgId) {
            existing = findByClientMsgId(operation.message.clientMsgId);
          }
          if (!existing && operation.kind === 'stream-tail') {
            if (currentElement?.classList.contains('assistant') && !currentElement.dataset.msgId) {
              existing = currentElement;
            } else {
              existing = Array.from(messagesEl.querySelectorAll('.msg.assistant:not([data-msg-id])')).pop() || null;
            }
          }
          const node = renderMessage(operation.message);
          if (existing) {
            const next = replaceMessageNode(existing, node, { currentElement, lastUserElement });
            currentElement = next.currentElement;
            lastUserElement = next.lastUserElement;
          } else {
            messagesEl.appendChild(node);
          }
        } catch (error) {
          warn('[multicc] history view skipped message', index, error);
        }
      }

      // A reconnect page is authoritative for the relative order of every
      // persisted message it contains. Missing messages may have been absent
      // from another window while later assistant frames were still rendered;
      // move keyed nodes into canonical server order instead of merely appending
      // the missing bubbles after newer content.
      reorderAuthoritativeNodes(plan, currentElement);

      let streamingTail = null;
      if (plan.streamingTail) {
        const element = plan.streamingTail.id
          ? findById(plan.streamingTail.id)
          : Array.from(messagesEl.querySelectorAll('.msg.assistant')).pop() || null;
        if (element) {
          const message = Array.from(plan.messages).reverse().find(candidate =>
            candidate.role === 'assistant'
            && (!plan.streamingTail.id || candidate.id === plan.streamingTail.id));
          streamingTail = Object.freeze({
            element,
            content: plan.streamingTail.content,
            toolCards: hydrateStreamingTools(message, element),
          });
        }
      }
      return Object.freeze({ currentElement, lastUserElement, streamingTail });
    }

    function prependMessages(messages) {
      if (!Array.isArray(messages) || !messages.length) return 0;
      const firstChild = messagesEl.firstElementChild;
      const previousHeight = messagesEl.scrollHeight;
      const previousTop = messagesEl.scrollTop;
      const fragment = document.createDocumentFragment();
      const pageIds = new Set();
      let inserted = 0;
      for (const message of messages) {
        if (message.id && (pageIds.has(message.id) || findById(message.id))) continue;
        try {
          fragment.appendChild(renderMessage(message));
          inserted += 1;
          if (message.id) pageIds.add(message.id);
        } catch (error) {
          warn('[multicc] history view skipped older message', error);
        }
      }
      messagesEl.insertBefore(fragment, firstChild);
      messagesEl.scrollTop = previousTop + (messagesEl.scrollHeight - previousHeight);
      return inserted;
    }

    function createAssistantBubble(streaming = true) {
      const node = document.createElement('div');
      node.className = 'msg assistant';
      const content = document.createElement('div');
      content.className = 'msg-content';
      if (streaming) content.classList.add('streaming-dot');
      node.appendChild(content);
      messagesEl.appendChild(node);
      return node;
    }

    function clearMessages() {
      messagesEl.replaceChildren();
    }

    function tagLatestMessage(role, id, clientMsgId) {
      if (!id) return null;
      const clientNode = findByClientMsgId(clientMsgId);
      if (clientNode) {
        if (!clientNode.dataset.msgId) {
          clientNode.dataset.msgId = id;
          attachDeleteButton(clientNode);
          attachForkButton(clientNode);
        }
        return clientNode;
      }
      const selector = role === 'user' ? '.msg.user' : '.msg.assistant';
      const nodes = messagesEl.querySelectorAll(selector);
      const node = nodes[nodes.length - 1];
      if (!node || node.dataset.msgId) return node || null;
      node.dataset.msgId = id;
      attachDeleteButton(node);
      attachForkButton(node);
      return node;
    }

    return Object.freeze({
      addToolResult,
      appendToolCard,
      applyPlan,
      clearMessages,
      commitMessage,
      createAssistantBubble,
      createToolCard,
      findByClientMsgId,
      findById,
      getToolStack,
      nextVisibleId,
      prependMessages,
      removeById,
      renderCurrentText,
      renderMessage,
      tagLatestMessage,
      updateToolInput,
      visibleIds,
    });
  }

  return Object.freeze({ createHistoryView });
});
