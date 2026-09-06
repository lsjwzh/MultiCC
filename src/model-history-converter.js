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

// One rejection-driven fallback, restricted to optional metadata. Never drop a
// whole tool, a call/result, arguments, names, content, reasoning or a schema.
// The caller may apply this only to an HTTP 400 before streaming any output.
function repairRejectedResponsesHistory(body, error) {
  const param = rejectedParameter(error);
  const message = String(error?.message || '');
  const unsupported = /unknown parameter|unsupported parameter|unrecognized parameter|extra inputs? (?:are )?not permitted/i.test(message);
  const invalidId = /expected an? id.*(?:begin|start)|invalid.*\bid\b.*(?:prefix|format)/i.test(message);
  const invalidOptional = ['invalid_type', 'invalid_value'].includes(error?.code) && /invalid\b/i.test(message);
  const match = /^input\[(\d+)\]\.(\w+)$/.exec(param);
  if (match && Array.isArray(body?.input)) {
    const index = Number(match[1]);
    const field = match[2];
    const item = body.input[index];
    const rule = itemRule(item?.type);
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

module.exports = { preprocessResponsesHistory, repairRejectedResponsesHistory };
