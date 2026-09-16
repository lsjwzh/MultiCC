'use strict';

const { createHash } = require('node:crypto');

// Request copies only. Vendor-native transcripts remain the source of truth.
// These are Responses item IDs, NOT tool-result correlation IDs. Claude's
// tool_use.id and Chat Completions' tool_calls[].id instead identify a call;
// they must never be globally renamed by a prefix replacement.
const ITEM_RULES = Object.freeze({
  message: { prefix: 'msg', optional: ['id', 'status', 'internal_chat_message_metadata_passthrough'] },
  function_call: { prefix: 'fc', optional: ['id', 'status', 'internal_chat_message_metadata_passthrough'] },
  function_call_output: { prefix: 'fco', optional: ['id', 'status', 'internal_chat_message_metadata_passthrough'] },
  custom_tool_call: { prefix: 'ctc', optional: ['id', 'status', 'internal_chat_message_metadata_passthrough'] },
  custom_tool_call_output: { prefix: 'ctco', optional: ['id', 'status', 'internal_chat_message_metadata_passthrough'] },
});

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function itemRule(type) {
  return Object.hasOwn(ITEM_RULES, type) ? ITEM_RULES[type] : null;
}

function convertedId(type, id, index, occupied) {
  const prefix = ITEM_RULES[type].prefix;
  let salt = 0;
  let candidate;
  do {
    const digest = createHash('sha256').update(JSON.stringify([type, id, index, salt++])).digest('hex').slice(0, 32);
    candidate = `${prefix}_${digest}`;
  } while (occupied.has(candidate));
  occupied.add(candidate);
  return candidate;
}

function change(index, item, field, action, rule) {
  return { path: `input[${index}].${field}`, itemType: item.type, action, rule };
}

function preprocessResponsesHistory(body) {
  if (!Array.isArray(body?.input)) return { body, changes: [] };
  const changes = [];
  const ids = new Map();
  const referenced = new Set();
  for (const item of body.input) {
    if (typeof item?.id !== 'string') continue;
    if (item.type === 'item_reference') referenced.add(item.id);
    else ids.set(item.id, (ids.get(item.id) || 0) + 1);
  }
  const occupied = new Set([...ids.keys(), ...referenced]);
  const remapped = new Map();
  const input = body.input.map((item, index) => {
    if (!object(item)) return item;
    let result = item;
    const rule = itemRule(item.type);
    // Reasoning IDs/encrypted content, agent_message and future item types are
    // deliberately opaque. No guessed schema or silent dropping of new types.
    if (rule && typeof item.id === 'string' && !item.id.startsWith(`${rule.prefix}_`)) {
      // A reference to two identically named records is ambiguous. Let the
      // upstream explain it rather than inventing which record it means.
      if (!referenced.has(item.id) || ids.get(item.id) === 1) {
        const id = convertedId(item.type, item.id, index, occupied);
        result = { ...result, id };
        if (referenced.has(item.id)) remapped.set(item.id, id);
        changes.push(change(index, item, 'id', 'convert', 'responses_item_id'));
      }
    }
    if (item.type === 'function_call' && object(item.arguments)) {
      result = { ...result, arguments: JSON.stringify(item.arguments) };
      changes.push(change(index, item, 'arguments', 'convert', 'json_function_arguments'));
    }
    return result;
  }).map((item, index) => {
    if (item?.type !== 'item_reference' || !remapped.has(item.id)) return item;
    changes.push(change(index, item, 'id', 'convert', 'responses_item_reference'));
    return { ...item, id: remapped.get(item.id) };
  });
  return { body: changes.length ? { ...body, input } : body, changes };
}

function rejectedParameter(error) {
  if (typeof error?.param === 'string' && error.param) return error.param;
  const match = /(?:Invalid|Unknown parameter|Unsupported parameter|Unrecognized parameter)\s*:?\s*['"]([^'"]+)['"]/i.exec(String(error?.message || ''));
  return match ? match[1] : '';
}

// Third-party Responses providers (DeepSeek, other responses-compatible
// gateways) persist reasoning items with a raw content=[reasoning_text]
// array. The official ChatGPT backend's private schema requires reasoning
// items to carry NO content ("Expected an array with maximum length 0"), so
// a thread recorded on a third-party provider fails replay against official
// with 400 Invalid 'input[N].content': array too long. Strip the field from
// every reasoning item in one pass. The local rollout transcript is never
// touched (request copies only). Reached only through
// normalizeResponsesHistory's `omitReasoningContent`, which only the official
// relay's dial sets — a third-party route keeps this content, because there it
// is real context rather than a schema violation.
function stripReasoningContent(body) {
  if (!Array.isArray(body?.input)) return { body, changes: [] };
  const changes = [];
  const input = body.input.map((item, index) => {
    if (item?.type === 'reasoning' && Array.isArray(item.content) && item.content.length > 0) {
      const copy = { ...item };
      delete copy.content;
      changes.push(change(index, item, 'content', 'omit', 'reasoning_content_not_accepted'));
      return copy;
    }
    return item;
  });
  return changes.length ? { body: { ...body, input }, changes } : { body, changes };
}

// Third-party Responses gateways also mint their OWN encrypted reasoning
// blobs (GLM-style Fernet `gAAAAA…`, DeepSeek-style `uuid-N`), which the
// official ChatGPT backend cannot decrypt and rejects with "The encrypted
// content … could not be verified". Drop the field from every reasoning item
// in the request copy; the item keeps its id/summary, which is exactly the
// shape official itself produces when no encrypted content exists.
function stripUnverifiableEncryptedContent(body) {
  if (!Array.isArray(body?.input)) return { body, changes: [] };
  const changes = [];
  const input = body.input.map((item, index) => {
    if (item?.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content) {
      const copy = { ...item };
      delete copy.encrypted_content;
      changes.push(change(index, item, 'encrypted_content', 'omit', 'encrypted_content_unverifiable'));
      return copy;
    }
    return item;
  });
  return changes.length ? { body: { ...body, input }, changes } : { body, changes };
}

// Cross-upstream resume, third stop. A rollout recorded on another Responses
// upstream replays ids THAT upstream minted. The official ChatGPT hop runs with
// store:false (nothing is persisted server-side), so any id the backend cannot
// resolve from inline content is a dangling reference and it rejects the whole
// request: "Item with id 'rs_…' not found. Items are not persisted when `store`
// is set to false. … remove this item from your input." Remove every shape that
// can only ever resolve server-side:
//   • top-level previous_response_id;
//   • {type:'item_reference'} entries;
//   • id-only husks ({id,type}[,status]) — e.g. reasoning items whose foreign
//     content/encrypted_content earlier passes already stripped;
//   • a reasoning item's foreign id when no encrypted_content backs it — the
//     backend resolves reasoning ids statelessly ONLY through a verifiable
//     blob (normal official replay always carries one);
//   • plus any id the upstream explicitly named as not found (repair path).
// Self-contained items — messages, tool calls with inline arguments/outputs,
// reasoning with a verifiable encrypted blob — pass through untouched.
function stripUnresolvedItemReferences(body, extraIds = []) {
  if (!object(body)) return { body, changes: [] };
  const unresolved = new Set(extraIds.filter(id => typeof id === 'string' && id));
  const changes = [];
  const selfContained = item => {
    const copy = { ...item };
    delete copy.id;
    return copy;
  };
  const isHusk = item => typeof item.id === 'string' && item.id
    && Object.keys(item).every(key => key === 'id' || key === 'type' || key === 'status');
  let next = body;
  if (typeof body.previous_response_id === 'string' && body.previous_response_id) {
    next = { ...next };
    delete next.previous_response_id;
    changes.push({ path: 'previous_response_id', action: 'omit', rule: 'store_false_reference' });
  }
  if (Array.isArray(body.input)) {
    const input = [];
    let inputChanged = false;
    body.input.forEach((item, index) => {
      if (!object(item)) { input.push(item); return; }
      const dropped = (path) => changes.push({ path, itemType: item.type, action: 'omit', rule: 'store_false_reference' });
      if (item.type === 'item_reference' || isHusk(item)) {
        dropped(`input[${index}]`);
        inputChanged = true;
        return;
      }
      if (typeof item.id !== 'string' || !item.id) { input.push(item); return; }
      if (unresolved.has(item.id)) {
        // The backend named this exact id — and if it got as far as an id
        // lookup, any encrypted_content the item carried failed to resolve it
        // (a verifiable official blob never needs a lookup). Drop both; keep
        // whatever inline content survives, or the whole item if nothing does.
        const copy = { ...item };
        delete copy.id;
        if (item.type === 'reasoning' && typeof copy.encrypted_content === 'string') delete copy.encrypted_content;
        const keepsContext = (Array.isArray(copy.summary) && copy.summary.length > 0)
          || (Array.isArray(copy.content) && copy.content.length > 0);
        const carriesContent = Object.keys(copy).some(key => key !== 'type' && key !== 'status')
          && !(item.type === 'reasoning' && !keepsContext);
        if (carriesContent) {
          dropped(`input[${index}].id`);
          input.push(copy);
        } else {
          dropped(`input[${index}]`);
        }
        inputChanged = true;
        return;
      }
      if (item.type === 'reasoning' && !item.encrypted_content) {
        const hasSummary = Array.isArray(item.summary) && item.summary.length > 0;
        // Third-party gateways record the chain of thought as inline
        // content:[{type:'reasoning_text'}] instead of a blob + summary. That
        // content is real context and survives the id strip; only an item
        // carrying nothing but an id is worthless enough to drop.
        const hasInlineContent = Array.isArray(item.content) && item.content.length > 0;
        if (!hasSummary && !hasInlineContent) {
          // No blob, no summary, no inline content: the item carries zero
          // context — an empty {type:'reasoning'} shell is riskier than
          // dropping it.
          dropped(`input[${index}]`);
          inputChanged = true;
          return;
        }
        dropped(`input[${index}].id`);
        input.push(selfContained(item));
        inputChanged = true;
        return;
      }
      input.push(item);
    });
    if (inputChanged) next = { ...next, input };
  }
  return changes.length ? { body: next, changes } : { body, changes };
}

// The pass every Codex route runs on the forwarded copy, whoever performs the
// dial: cli-provider-router's request hook (src/providers/codex-history-hooks),
// the official OAuth relay's own ChatGPT hop, and that relay's fall-through for
// a router without hooks. It lives here, once, because the sequence — and the
// order inside it — is what makes a cross-upstream resume replayable, and three
// copies of a sequence is three chances to drift.
//
// The two halves are provider-agnostic on purpose:
//   · preprocessResponsesHistory renames foreign record ids and hands ambiguous
//     references to the upstream instead of guessing;
//   · stripUnresolvedItemReferences drops the shapes that can only ever resolve
//     server-side, which under store:false is every one of them.
//
// `omitReasoningContent` is the one per-upstream judgement call, and it is a
// parameter rather than another caller because the difference is real:
// official's private schema requires reasoning items to carry NO content
// ("Expected an array with maximum length 0"), while a third-party Responses
// upstream accepts — and produced — exactly that array as inline context. Only
// the caller that dials official passes it (src/codex/official-relay), so no
// third-party route loses context it would have kept.
//
// The reasoning pass necessarily runs BEFORE the reference pass: emptying a
// reasoning item's content is what can leave it as an id-only husk, and the
// husk is removed by the pass that follows. Reversing them would leave a
// content-less reasoning item behind to draw the very rejection this exists to
// avoid.
function normalizeResponsesHistory(body, { omitReasoningContent = false } = {}) {
  const prepared = preprocessResponsesHistory(body);
  const content = omitReasoningContent
    ? stripReasoningContent(prepared.body)
    : { body: prepared.body, changes: [] };
  const references = stripUnresolvedItemReferences(content.body);
  return {
    body: references.body,
    changes: [...prepared.changes, ...content.changes, ...references.changes],
  };
}

// One rejection-driven fallback, restricted to optional metadata. Never drop a
// whole tool, a call/result, arguments, names or a schema; the one deliberate
// exception is reasoning content, which official rejects outright (see
// stripReasoningContent). The caller may apply this only to an HTTP 400 before
// streaming any output.
function repairRejectedResponsesHistory(body, error) {
  const param = rejectedParameter(error);
  const message = String(error?.message || '');
  const unsupported = /unknown parameter|unsupported parameter|unrecognized parameter|extra inputs? (?:are )?not permitted/i.test(message);
  const invalidId = /expected an? id.*(?:begin|start)|invalid.*\bid\b.*(?:prefix|format)/i.test(message);
  const invalidOptional = ['invalid_type', 'invalid_value'].includes(error?.code) && /invalid\b/i.test(message);
  const match = /^input\[(\d+)\]\.(\w+)$/.exec(param);
  const optionalFieldRepair = (() => {
    if (!match || !Array.isArray(body?.input)) return null;
    const index = Number(match[1]);
    const field = match[2];
    const item = body.input[index];
    const rule = itemRule(item?.type);
    // Fall through to the content backstop below when this param does not map
    // to an omittable optional field (e.g. reasoning items are opaque here).
    if (!rule || !rule.optional.includes(field) || !Object.hasOwn(item, field)) return null;
    if (!unsupported && !invalidOptional && !(field === 'id' && invalidId)) return null;
    if (field === 'id' && body.input.some(other => other?.type === 'item_reference' && other.id === item.id)) return null;
    const copy = { ...item };
    delete copy[field];
    const input = body.input.slice();
    input[index] = copy;
    return {
      body: { ...body, input },
      changes: [change(index, item, field, 'omit', 'upstream_rejected_optional_field')],
    };
  })();
  if (optionalFieldRepair) return optionalFieldRepair;
  // Backstop for the reasoning-content rejection: the official relay strips
  // proactively (below), but if a rejection of this shape still arrives —
  // other item types carrying content where none is allowed, or a shape the
  // proactive pass missed — strip every reasoning item and retry once.
  const contentParam = /input\[\d+\]\.content/i.test(`${param} ${message}`)
    && (/array too long/i.test(message) || /array_above_max_length/i.test(String(error?.code || '')));
  if (contentParam) {
    const stripped = stripReasoningContent(body);
    if (stripped.changes.length) return stripped;
  }
  // Backstop for third-party encrypted reasoning: gateways mint their own
  // encrypted_content blobs that official cannot decrypt ("could not be
  // verified"), so drop every reasoning item's encrypted blob in one pass.
  // Dropping a blob leaves its id unresolvable under store:false, which would
  // draw the item-not-found rejection on the retry — strip the dangling ids in
  // the SAME pass so the single allowed repair round suffices.
  if (/encrypted content .{0,120}(?:could not be verified|could not be decrypted|could not be parsed)/i.test(message)) {
    const stripped = stripUnverifiableEncryptedContent(body);
    const refs = stripUnresolvedItemReferences(stripped.body);
    const changes = [...stripped.changes, ...refs.changes];
    if (changes.length) return { body: refs.body, changes };
  }
  // Backstop for the store:false dangling-reference rejection itself: the
  // upstream names the exact id it could not resolve. Target that id plus the
  // whole family of server-side-only reference shapes in one repair pass.
  const itemNotFound = /item with id ['"]([^'"]+)['"] not found/i.exec(message);
  if (itemNotFound) {
    const stripped = stripUnresolvedItemReferences(body, [itemNotFound[1]]);
    if (stripped.changes.length) return stripped;
  }
  const toolMatch = /^tools\[(\d+)\]\.(strict|defer_loading|cache_control)$/.exec(param);
  if (!unsupported || !toolMatch || !Array.isArray(body?.tools)) return null;
  const index = Number(toolMatch[1]);
  const field = toolMatch[2];
  const tool = body.tools[index];
  if (tool?.type !== 'function' || !Object.hasOwn(tool, field)) return null;
  const copy = { ...tool };
  delete copy[field];
  const tools = body.tools.slice();
  tools[index] = copy;
  return {
    body: { ...body, tools },
    changes: [{ path: param, itemType: 'function', action: 'omit', rule: 'upstream_rejected_optional_field' }],
  };
}

module.exports = {
  normalizeResponsesHistory,
  preprocessResponsesHistory,
  repairRejectedResponsesHistory,
  stripReasoningContent,
  stripUnresolvedItemReferences,
  stripUnverifiableEncryptedContent,
};
