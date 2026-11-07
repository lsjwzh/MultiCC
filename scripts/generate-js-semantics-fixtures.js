#!/usr/bin/env node
'use strict';

// Generates native/core/tests/js-semantics-fixtures.json, the oracle for
// native/core/src/js/. Every expected value in the fixture comes from the
// running V8, so the Rust implementation is compared against JavaScript
// semantics rather than against another Rust assumption.
//
// Values are encoded as a tagged tree so that NaN/-0/undefined/Buffer/Date and
// lone surrogates survive JSON on disk:
//   { t:'undefined' } | { t:'null' } | { t:'boolean', v }
//   { t:'number'|'date', v:'<IEEE-754 bits, 16 hex>' }
//   { t:'string', v } | { t:'bytes', v:'<base64>' }
//   { t:'array', v:[wire...] } | { t:'object', v:[[key, wire]...] }
// The Rust side reads the file with the new js::json_parse (not serde), so
// "\udxxx" escapes decode back to lone surrogate code units.
//
// Regenerate with: node scripts/generate-js-semantics-fixtures.js
const fs = require('node:fs');
const path = require('node:path');

const bitsView = new DataView(new ArrayBuffer(8));
function bits(number) {
  bitsView.setFloat64(0, number, false);
  let out = '';
  for (let index = 0; index < 8; index += 1) out += bitsView.getUint8(index).toString(16).padStart(2, '0');
  return out;
}

function wire(value) {
  if (value === undefined) return { t: 'undefined' };
  if (value === null) return { t: 'null' };
  const kind = typeof value;
  if (kind === 'boolean') return { t: 'boolean', v: value };
  if (kind === 'number') return { t: 'number', v: bits(value) };
  if (kind === 'string') return { t: 'string', v: value };
  if (Buffer.isBuffer(value)) return { t: 'bytes', v: value.toString('base64') };
  if (value instanceof Date) return { t: 'date', v: bits(value.getTime()) };
  if (Array.isArray(value)) {
    const items = [];
    for (let index = 0; index < value.length; index += 1) items.push(wire(value[index]));
    return { t: 'array', v: items };
  }
  if (kind === 'object') {
    return { t: 'object', v: Object.keys(value).map(key => [key, wire(value[key])]) };
  }
  throw new Error(`unsupported fixture value: ${kind}`);
}

// A small deterministic generator broadens the number formatting corpus.
let seed = 0x9e3779b9;
function random() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
}
function randomDouble() {
  const sign = random() < 0.5 ? -1 : 1;
  const exponent = Math.floor(random() * 120) - 60;
  const mantissa = 1 + random();
  return sign * mantissa * 2 ** exponent;
}

const NUMBERS = [
  NaN, Infinity, -Infinity, 0, -0, 1, -1, 1.5, -1.5, 2, 2.5, 100, -100,
  0.1, 0.2, 0.1 + 0.2, 1e21, 1e20, 1e-6, 1e-7, 0.000001, 0.0000001,
  123456789.123456789, 9007199254740992, 9007199254740993,
  123456789012345680000, 1.7976931348623157e308, 5e-324, 1e-323,
  Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Math.PI, Math.E,
  4294967295, 4294967296, 2147483647, -2147483648,
  ...Array.from({ length: 120 }, randomDouble),
];

const STRINGS = [
  '', 'a', 'Hello', '  spaced  ', '\t\n\r', '\u0000\u0001\u001f', '"\\"',
  '中文', '😀', '😀😀', 'a😀b', '\ud83d', '\ude00', 'A\ud83dB', '😀',
  '  ', '\u007f', 'é', 'İ', 'ΣΣ', 'ß', 'ǅungla', '\u{1F600}',
];

const WHITESPACE_STRINGS = [
  '', ' ', '\t', '\n', '\r', '\u000b', '\u000c', ' ', ' ',
  ' ', ' ', ' ', ' ', ' ', ' ', '　',
  '﻿', '\u0085', ' \t\n x \r\n ', '﻿　x ',
  '\u0085x\u0085', 'x\u0085', '\ud83d', ' \ud83d ', ' x ', 'x y z',
];

const NUMBER_STRINGS = [
  '', ' ', '  ', '\t\n', '﻿', '　', '\u0085',
  '0', '-0', '+0', '1', '-1', '+1', ' 42 ', ' 42　',
  '1.5', '.5', '5.', '-.5', '+.5', '1e3', '1E3', '1e+3', '1e-3', '1e400',
  '0x10', '0X10', '0x', '0xg', '-0x10', '+0x10', '0o17', '0O17', '0o18',
  '0b101', '0B101', '0b102', 'Infinity', '+Infinity', '-Infinity', 'infinity',
  'NaN', 'null', 'undefined', 'true', '1_0', '00012', '1.2.3', '--1',
  '2024-01-02', '2024-01-02T03:04:05Z', '0x1f', '1e', 'e3', '.', '+', '-',
  '1e-400', '9007199254740993', '1.7976931348623157e309',
];

function denseArray(...items) {
  return items;
}

function sparseArray() {
  const value = [];
  value[2] = 1;
  value[5] = 'x';
  return value;
}

const JSON_VALUES = [
  undefined, null, true, false, 0, -0, NaN, Infinity, -Infinity, 1.5, 1e21,
  1e-7, 'x', '', 'quote"backslash\\slash/', '\u0000\u0008\u0009\u000a\u000c\u000d\u001f',
  '  ', '中文😀', '\ud83d', 'A\ud83dB', '😀\ude00',
  denseArray(), denseArray(undefined), denseArray(1, undefined, null),
  denseArray(NaN, Infinity, -0, 1.5), denseArray(Buffer.from('ab'), new Date(0)),
  sparseArray(), denseArray(denseArray({ a: 1 }, 'x'), []),
  {}, { a: undefined }, { b: 2, a: 1 }, { a: 1, a2: 2, b: 3 },
  { 2: 'b', 1: 'a', x: 0 }, { z: 1, '10': 2, '2': 3 },
  { '\ud83d': 1, ok: 'v' }, { nested: { list: [1, 2, { deep: undefined }] } },
  Buffer.alloc(0), Buffer.from([0, 1, 127, 128, 255]),
  new Date(0), new Date(-1), new Date('2024-01-02T03:04:05.678Z'),
  new Date(NaN), new Date(8640000000000000), new Date(-8640000000000000),
];

const JSON_PARSE_VALID = [
  'null', 'true', 'false', '0', '-0', '1', '-1', '1.5',
  '1e3', '1E+3', '1e-3', '1e400', '9007199254740993', '123456789012345678901234567890',
  '1.7976931348623157e308', '5e-324',
  '""', '"x"', '"\\u0000\\u001f"', '"\\ud83d"', '"\\ud83d\\ude00"',
  '"\\/\\"\\\\"', '"中😀"', '" "',
  '[]', '[1,2,3]', '[1,"two",null,true,{"a":1}]', '[[[[]]]]',
  '{}', '{"a":1}', '{"a":1,"b":"\\ud83d","a":2}',
  '{"2":3,"1":2,"x":1}', '{"__proto__":1,"constructor":2}',
  ' { "a" : [ 1 , { "b" : null } ] } ',
  '{"k":"\\u4e2d\\u6587"}',
];

const JSON_PARSE_INVALID = [
  '', ' ', '{', '[', ']', '}', '{"a":}', '[1,]', '[1 2]', '{"a" 1}',
  '01', '1.', '+1', '.5', 'NaN', 'Infinity', '-Infinity', 'undefined',
  '{"a":}', "{'a':1}", '"\\x"', '"\\u12"', '"\\u12g4"', '"unterminated',
  'tru', 'nul', 'truefalse', '{"a":1}}', '[1]]', '﻿1', '//x\n1', '0x10',
];

const fixture = {
  note: 'Generated by scripts/generate-js-semantics-fixtures.js from Node. Do not edit by hand.',
  toString: [
    ...NUMBERS.map(value => ({ value: wire(value), out: String(value) })),
    ...STRINGS.map(value => ({ value: wire(value), out: String(value) })),
    { value: wire([1, null, 'x', undefined, [2, [3]]]), out: String([1, null, 'x', undefined, [2, [3]]]) },
    { value: wire({ a: 1 }), out: String({ a: 1 }) },
    { value: wire(Buffer.from([0x68, 0x69, 0xff])), out: String(Buffer.from([0x68, 0x69, 0xff])) },
    { value: wire(Buffer.alloc(0)), out: String(Buffer.alloc(0)) },
  ],
  toNumber: NUMBER_STRINGS.map(value => ({ in: value, out: bits(Number(value)) })),
  trim: WHITESPACE_STRINGS.map(value => ({
    in: value, out: value.trim(), start: value.trimStart(), end: value.trimEnd(),
  })),
  jsonStringify: JSON_VALUES.map(value => ({
    value: wire(value),
    out: JSON.stringify(value) === undefined ? null : JSON.stringify(value),
  })),
  jsonParseValid: JSON_PARSE_VALID.map(input => ({
    in: input, out: JSON.stringify(JSON.parse(input)),
  })),
  jsonParseInvalid: JSON_PARSE_INVALID,
};

const target = path.join(__dirname, '..', 'native', 'core', 'tests', 'js-semantics-fixtures.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`${target}: ${fixture.toString.length} toString, ${fixture.toNumber.length} toNumber, `
  + `${fixture.trim.length} trim, ${fixture.jsonStringify.length} stringify, `
  + `${fixture.jsonParseValid.length} parse, ${fixture.jsonParseInvalid.length} invalid`);
