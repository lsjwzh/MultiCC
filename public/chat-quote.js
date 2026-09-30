'use strict';

// Quote a message into the composer.
//
// The quoted text is only half of what a quote is worth. A task shell shows one
// conversation built out of several tasks, and a message's meaning depends on
// which of them it came from — the same sentence from 「修登录页」 and from
// 「迁移数据库」 is two different pieces of evidence. So the block carries the
// message's own provenance too: the subtask it belongs to (name + id), who said
// it, when, and the message identity (`<sessionId>:<messageId>`), which is
// exactly the handle the task-context reader takes to re-read it in full.
//
// The block is plain text in the textarea, never a separate widget. A draft is
// persisted as raw text per task and a failed send is restored from the text it
// tried to send; a quote that lived outside the box would be lost by both. Plain
// text also means the model reads it as-is and the user can edit or drop it.
(function attachMultiCCChatQuote(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCChatQuote = api;
})(typeof window !== 'undefined' ? window : globalThis, function createApi(root) {
  // Long enough for a paragraph of real evidence, short enough that quoting a
  // whole answer does not silently spend the next turn's context on itself.
  const MAX_CHARS = 800;

  function translator(explicit) {
    if (typeof explicit === 'function') return explicit;
    const globalT = root && root.t;
    return typeof globalT === 'function' ? globalT : key => key;
  }

  // The DOM half of the provenance. The view stamps these onto the bubble as it
  // renders, and the annotation broadcast re-stamps them when a turn's task
  // attribution is decided after the fact.
  const STAMPED = ['taskId', 'taskName', 'turnId', 'sourceSessionId', 'sourceMessageId'];

  function roleOf(node) {
    if (!node || !node.classList) return 'system';
    // An injected 🔇 card keeps the `user` class for the view's own backtracking
    // selectors, but it is engine-authored: quote it as a system line, never as
    // something the human said.
    if (node.classList.contains('system-inject')) return 'system';
    if (node.classList.contains('user')) return 'user';
    if (node.classList.contains('assistant')) return 'assistant';
    return 'system';
  }

  // The bubble's own text, without the floating action buttons that live inside
  // the same element. Assistant bubbles keep their exact source in `rawText`
  // (set at render time because the visible DOM is markdown + tool cards).
  function textOf(node) {
    if (!node) return '';
    const raw = node.dataset && node.dataset.rawText;
    if (raw) return String(raw);
    const clone = node.cloneNode(true);
    for (const button of Array.from(clone.querySelectorAll('button'))) button.remove();
    for (const tail of Array.from(clone.querySelectorAll('.msg-task-tail'))) tail.remove();
    const content = clone.querySelector('.msg-content');
    const surface = content ? (content.querySelector('.message-markdown') || content) : clone;
    return (surface.textContent || '').trim();
  }

  function clock(ts, t) {
    const value = Number(ts);
    if (!Number.isFinite(value) || value <= 0) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function taskLabel(source, t) {
    const name = typeof source.taskName === 'string' ? source.taskName.trim() : '';
    const id = typeof source.taskId === 'string' ? source.taskId.trim() : '';
    if (name && id) return t('msgQuoteTask', { name, id });
    if (name) return t('msgQuoteTaskNamed', { name });
    if (id) return id;
    return t('msgQuoteNoTask');
  }

  function headerOf(source, t) {
    // The message identity is the shell's own `<sessionId>:<messageId>` — the
    // same handle `/api/task-shells/.../context?message_id=` takes, so the
    // quote stays re-readable and not just quotable.
    const sessionId = typeof source.sourceSessionId === 'string' ? source.sourceSessionId : '';
    const messageId = typeof source.sourceMessageId === 'string' && source.sourceMessageId
      ? source.sourceMessageId : (typeof source.messageId === 'string' ? source.messageId : '');
    const trace = sessionId && messageId ? `${sessionId}:${messageId}` : (messageId || sessionId);
    return t('msgQuoteHeader', {
      task: taskLabel(source, t),
      role: t(source.role === 'user' ? 'msgQuoteRoleUser'
        : source.role === 'assistant' ? 'msgQuoteRoleAssistant' : 'msgQuoteRoleSystem'),
      time: clock(source.ts, t),
      message: trace || t('msgQuoteNoTrace'),
    });
  }

  // Prefix every line so the block survives as a quote even after the user adds
  // their own text above or below it — including lines the excerpt cut mid-way.
  function quoteLines(text) {
    return String(text).split('\n').map(line => `> ${line}`.trimEnd()).join('\n');
  }

  function formatQuote(source, explicitTranslator) {
    if (!source || typeof source !== 'object') return '';
    const t = translator(explicitTranslator);
    const text = String(source.text == null ? '' : source.text).trim();
    if (!text) return '';
    const clipped = text.length > MAX_CHARS;
    const body = clipped ? text.slice(0, MAX_CHARS).trimEnd() : text;
    const parts = [headerOf(source, t), quoteLines(body)];
    if (clipped) parts.push(`> ${t('msgQuoteTruncated', { n: text.length })}`);
    return parts.join('\n');
  }

  // Read the provenance back off a rendered bubble. Everything here was stamped
  // by chat-history-view at render time or by an annotation event; nothing is
  // inferred from the text.
  function fromNode(node, explicitTranslator) {
    if (!node || !node.dataset) return '';
    const source = { role: roleOf(node), text: textOf(node) };
    for (const field of STAMPED) {
      if (node.dataset[field]) source[field] = node.dataset[field];
    }
    const ts = Number(node.dataset.ts);
    if (Number.isFinite(ts) && ts > 0) source.ts = ts;
    return formatQuote(source, explicitTranslator);
  }

  // Insert above whatever is already in the box. A quote is context you are
  // adding to what you were going to say, so it must never replace the draft.
  function insert(block, doc) {
    if (!block) return false;
    const target = doc || (root && root.document);
    const input = target && target.getElementById ? target.getElementById('input') : null;
    if (!input) return false;
    const draft = String(input.value || '');
    const next = draft.trim() ? `${block}\n\n${draft.replace(/^\n+/, '')}` : `${block}\n\n`;
    input.value = next;
    // The composer grows the textarea and the Air host stores the per-task draft
    // both from a real `input` event; assigning `.value` fires nothing.
    const EventCtor = (root && root.Event) || (typeof Event === 'function' ? Event : null);
    if (EventCtor) input.dispatchEvent(new EventCtor('input', { bubbles: true }));
    if (typeof input.focus === 'function') input.focus();
    try { input.setSelectionRange(next.length, next.length); } catch (_) { /* not selectable */ }
    return true;
  }

  function quoteInto(node, doc, explicitTranslator) {
    return insert(fromNode(node, explicitTranslator), doc);
  }

  return Object.freeze({ MAX_CHARS, formatQuote, fromNode, insert, quoteInto, textOf });
});
