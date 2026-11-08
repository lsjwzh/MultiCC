'use strict';
// Frozen pre-migration semantic scrub, copied verbatim from the last commit
// that had it in JS: the clone, descriptor walkers and write-back of
// `scrubProviderSemanticStructure` in src/chat/provider-attempt-runtime.js.
// The two text functions it calls are themselves frozen in
// tests/helpers/legacy-api-error-text.js. Test-only differential oracle; never
// imported by product code.

const {
  redactExactSecretFragments, redactProviderRouteCapability,
} = require('./legacy-api-error-text');

function cloneStructuredValue(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const output = Array.isArray(value) ? [] : {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(output, key, {
      value: cloneStructuredValue(item, seen),
      enumerable: true, configurable: true, writable: true,
    });
  }
  return output;
}

function addStringDescriptor(descriptors, parent, key) {
  if (parent && typeof parent[key] === 'string') {
    descriptors.push({ kind: 'value', parent, key, value: parent[key] });
  }
}

function collectModelControlled(node, parent, key, descriptors, seen = new WeakSet()) {
  if (typeof node === 'string') {
    addStringDescriptor(descriptors, parent, key);
    return;
  }
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      collectModelControlled(node[index], node, index, descriptors, seen);
    }
    return;
  }
  for (const objectKey of Object.keys(node)) {
    descriptors.push({ kind: 'key', parent: node, key: objectKey, value: objectKey });
    collectModelControlled(node[objectKey], node, objectKey, descriptors, seen);
  }
}

function collectToolResultContent(content, parent, key, descriptors) {
  if (typeof content === 'string') {
    addStringDescriptor(descriptors, parent, key);
    return;
  }
  if (!content || typeof content !== 'object') return;
  if (!Array.isArray(content)) {
    collectModelControlled(content, parent, key, descriptors);
    return;
  }
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    if (typeof block === 'string') {
      addStringDescriptor(descriptors, content, index);
    } else if (block && typeof block === 'object' && typeof block.text === 'string') {
      addStringDescriptor(descriptors, block, 'text');
    } else if (block && typeof block === 'object' && block.content != null) {
      collectToolResultContent(block.content, block, 'content', descriptors);
    } else {
      collectModelControlled(block, content, index, descriptors);
    }
  }
}

function collectMessageContent(content, descriptors, contentParent = null, contentKey = null) {
  if (typeof content === 'string') {
    addStringDescriptor(descriptors, contentParent, contentKey);
    return;
  }
  const blocks = Array.isArray(content) ? content : [content];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const parent = Array.isArray(content) ? content : null;
    const key = Array.isArray(content) ? index : null;
    if (typeof block === 'string') {
      if (parent) addStringDescriptor(descriptors, parent, key);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    if ((block.type === 'text' || block.type === 'thinking')
        && typeof block[block.type] === 'string') {
      addStringDescriptor(descriptors, block, block.type);
    } else if (block.type === 'tool_use') {
      collectModelControlled(block.input, block, 'input', descriptors);
    } else if (block.type === 'tool_result') {
      collectToolResultContent(block.content, block, 'content', descriptors);
    } else {
      for (const field of ['text', 'thinking']) addStringDescriptor(descriptors, block, field);
      if (block.input != null) collectModelControlled(block.input, block, 'input', descriptors);
      if (block.content != null) collectToolResultContent(block.content, block, 'content', descriptors);
    }
  }
}

function applySemanticRedactions(descriptors, secrets) {
  for (const descriptor of descriptors) descriptor.redacted = descriptor.value;
  for (const select of [
    descriptor => descriptor.kind === 'value',
    descriptor => descriptor.kind === 'key',
    () => true,
  ]) {
    const selected = descriptors.filter(select);
    const redacted = redactExactSecretFragments(selected.map(item => item.redacted), secrets);
    selected.forEach((descriptor, index) => { descriptor.redacted = redacted[index]; });
  }
  if (!descriptors.some(descriptor => descriptor.redacted !== descriptor.value)) return false;
  descriptors.forEach((descriptor) => {
    if (descriptor.kind === 'value' && descriptor.redacted !== descriptor.value) {
      descriptor.parent[descriptor.key] = descriptor.redacted;
    }
  });
  descriptors.forEach((descriptor) => {
    if (descriptor.kind !== 'key' || descriptor.redacted === descriptor.value) return;
    const property = Object.getOwnPropertyDescriptor(descriptor.parent, descriptor.key);
    if (!property) return;
    let targetKey = descriptor.redacted;
    let collision = 2;
    while (Object.prototype.hasOwnProperty.call(descriptor.parent, targetKey)
        && targetKey !== descriptor.key) {
      targetKey = `${descriptor.redacted}#${collision++}`;
    }
    delete descriptor.parent[descriptor.key];
    Object.defineProperty(descriptor.parent, targetKey, property);
  });
  return true;
}

function scrubProviderSemanticStructure(event, secrets) {
  if (!event || typeof event !== 'object') return redactProviderRouteCapability(event);
  const output = cloneStructuredValue(event);
  const descriptors = [];
  if ((output.type === 'assistant' || output.type === 'user') && output.message?.content != null) {
    collectMessageContent(output.message.content, descriptors, output.message, 'content');
  } else if (output.type === 'tool_start' || output.type === 'tool_update') {
    collectModelControlled(output.input, output, 'input', descriptors);
  } else if (output.type === 'tool_result') {
    collectToolResultContent(output.content, output, 'content', descriptors);
  }
  const changed = applySemanticRedactions(descriptors, secrets);
  return redactProviderRouteCapability(changed ? output : event);
}

module.exports = { scrubProviderSemanticStructure };
