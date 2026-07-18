'use strict';

const fs = require('fs');
const path = require('path');

function loadSchemaRegistry(directory) {
  const registry = new Map();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const schema = JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8'));
    registry.set(entry.name, schema);
    if (schema.$id) registry.set(schema.$id, schema);
  }
  return registry;
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function allowsType(expected, value) {
  const actual = valueType(value);
  const allowed = Array.isArray(expected) ? expected : [expected];
  return allowed.some(type => type === actual || (type === 'number' && actual === 'integer'));
}

function pointerGet(document, pointer) {
  if (!pointer || pointer === '#') return document;
  if (!pointer.startsWith('#/')) return undefined;
  return pointer.slice(2).split('/').reduce((node, segment) => {
    if (node === undefined || node === null) return undefined;
    return node[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }, document);
}

function resolveRef(ref, rootSchema, registry) {
  const [documentRef, fragment = ''] = String(ref).split('#');
  const document = documentRef
    ? registry.get(documentRef) || registry.get(path.basename(documentRef))
    : rootSchema;
  if (!document) return null;
  return fragment ? pointerGet(document, `#${fragment}`) : document;
}

function validate(schema, value, { registry = new Map(), rootSchema = schema } = {}) {
  const errors = [];

  function visit(node, current, location, root) {
    if (!node || typeof node !== 'object') {
      errors.push(`${location}: invalid schema node`);
      return;
    }
    if (node.$ref) {
      const resolved = resolveRef(node.$ref, root, registry);
      if (!resolved) errors.push(`${location}: unresolved $ref ${node.$ref}`);
      else visit(resolved, current, location, resolved);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(node, 'const') && current !== node.const) {
      errors.push(`${location}: expected const ${JSON.stringify(node.const)}`);
      return;
    }
    if (Array.isArray(node.enum) && !node.enum.some(item => Object.is(item, current))) {
      errors.push(`${location}: value is not in enum`);
      return;
    }
    if (node.type && !allowsType(node.type, current)) {
      errors.push(`${location}: expected ${JSON.stringify(node.type)}, got ${valueType(current)}`);
      return;
    }
    if (node.anyOf) {
      const matched = node.anyOf.some(candidate => validate(candidate, current, { registry, rootSchema: root }).valid);
      if (!matched) errors.push(`${location}: no anyOf branch matched`);
      return;
    }
    if (node.oneOf) {
      const count = node.oneOf.filter(candidate => validate(candidate, current, { registry, rootSchema: root }).valid).length;
      if (count !== 1) errors.push(`${location}: expected exactly one oneOf match, got ${count}`);
      return;
    }
    if (current === null || current === undefined) return;

    if (typeof current === 'string') {
      if (node.minLength != null && current.length < node.minLength) errors.push(`${location}: shorter than minLength`);
      if (node.maxLength != null && current.length > node.maxLength) errors.push(`${location}: longer than maxLength`);
      if (node.pattern && !(new RegExp(node.pattern)).test(current)) errors.push(`${location}: pattern mismatch`);
      if (node.format === 'date-time' && !Number.isFinite(new Date(current).getTime())) errors.push(`${location}: invalid date-time`);
    }
    if (typeof current === 'number') {
      if (node.minimum != null && current < node.minimum) errors.push(`${location}: below minimum`);
      if (node.maximum != null && current > node.maximum) errors.push(`${location}: above maximum`);
    }
    if (Array.isArray(current)) {
      if (node.minItems != null && current.length < node.minItems) errors.push(`${location}: fewer than minItems`);
      if (node.maxItems != null && current.length > node.maxItems) errors.push(`${location}: more than maxItems`);
      if (node.uniqueItems && new Set(current.map(item => JSON.stringify(item))).size !== current.length) errors.push(`${location}: items are not unique`);
      if (node.items) current.forEach((item, index) => visit(node.items, item, `${location}[${index}]`, root));
    }
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      for (const key of node.required || []) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) errors.push(`${location}: missing required property ${key}`);
      }
      const properties = node.properties || {};
      for (const [key, item] of Object.entries(current)) {
        if (properties[key]) visit(properties[key], item, `${location}.${key}`, root);
        else if (node.additionalProperties === false) errors.push(`${location}: additional property ${key}`);
        else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
          visit(node.additionalProperties, item, `${location}.${key}`, root);
        }
      }
    }
  }

  visit(schema, value, '$', rootSchema);
  return { valid: errors.length === 0, errors };
}

function validateSchemaDocument(schema, name = 'schema') {
  const errors = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) errors.push(`${name}: must be an object`);
  if (!schema.$schema || !String(schema.$schema).includes('2020-12')) errors.push(`${name}: must declare JSON Schema 2020-12`);
  if (!schema.$id || typeof schema.$id !== 'string') errors.push(`${name}: missing $id`);
  if (!schema.type) errors.push(`${name}: missing root type`);
  return { valid: errors.length === 0, errors };
}

function walkRefs(value, callback) {
  if (Array.isArray(value)) return value.forEach(item => walkRefs(item, callback));
  if (!value || typeof value !== 'object') return;
  if (typeof value.$ref === 'string') callback(value.$ref);
  Object.values(value).forEach(item => walkRefs(item, callback));
}

function validateOpenApiDocument(document, registry = new Map()) {
  const errors = [];
  if (!document || typeof document !== 'object') return { valid: false, errors: ['OpenAPI document must be an object'] };
  if (document.openapi !== '3.1.0') errors.push('OpenAPI version must be 3.1.0');
  if (!document.info || document.info.version !== 'v1') errors.push('OpenAPI info.version must be v1');
  if (!document.paths || Object.keys(document.paths).length === 0) errors.push('OpenAPI paths are required');
  walkRefs(document, ref => {
    if (ref.startsWith('#/')) {
      if (pointerGet(document, `#${ref.slice(1)}`) === undefined) errors.push(`unresolved OpenAPI ref ${ref}`);
    } else {
      const file = ref.split('#')[0];
      if (!registry.get(file) && !registry.get(path.basename(file))) errors.push(`unresolved schema ref ${ref}`);
    }
  });
  return { valid: errors.length === 0, errors };
}

function assertBackwardCompatible(baseline, registry) {
  const errors = [];
  for (const [file, expected] of Object.entries(baseline.schemas || {})) {
    const schema = registry.get(file);
    if (!schema) { errors.push(`${file}: schema removed`); continue; }
    const currentRequired = [...(schema.required || [])].sort();
    const previousRequired = [...(expected.required || [])].sort();
    if (JSON.stringify(currentRequired) !== JSON.stringify(previousRequired)) {
      errors.push(`${file}: required fields changed`);
    }
    for (const [property, constraint] of Object.entries(expected.properties || {})) {
      const current = schema.properties && schema.properties[property];
      if (!current) { errors.push(`${file}: property removed: ${property}`); continue; }
      if (constraint.$ref !== undefined && current.$ref !== constraint.$ref) {
        errors.push(`${file}.${property}: ref changed`);
      }
      if (constraint.items && constraint.items.$ref !== undefined
        && (!current.items || current.items.$ref !== constraint.items.$ref)) {
        errors.push(`${file}.${property}: item ref changed`);
      }
      const oldTypes = Array.isArray(constraint.type) ? constraint.type : (constraint.type ? [constraint.type] : []);
      const newTypes = Array.isArray(current.type) ? current.type : (current.type ? [current.type] : []);
      for (const type of oldTypes) if (!newTypes.includes(type)) errors.push(`${file}.${property}: no longer accepts type ${type}`);
      for (const item of constraint.enum || []) {
        if (!Array.isArray(current.enum) || !current.enum.some(value => Object.is(value, item))) {
          errors.push(`${file}.${property}: enum value removed: ${JSON.stringify(item)}`);
        }
      }
      if (constraint.const !== undefined && current.const !== constraint.const) errors.push(`${file}.${property}: const changed`);
    }
  }
  return { compatible: errors.length === 0, errors };
}

module.exports = {
  assertBackwardCompatible,
  loadSchemaRegistry,
  pointerGet,
  resolveRef,
  validate,
  validateOpenApiDocument,
  validateSchemaDocument,
};
