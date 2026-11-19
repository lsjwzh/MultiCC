'use strict';

// Freeze the output of the production Node envelope function for JSON wire
// values. The Rust kernel intentionally does not claim arbitrary VM objects.
const { createWsEnvelope } = require('../../../src/api-contract');
const pairs = [
  ['{"type":"pong"}', '{}'],
  ['{"type":"event","text":"hello"}', '{}'],
  ['{"type":"","apiVersion":"old"}', '{}'],
  ['{"type":"event","apiVersion":"old","requestId":"old"}', '{"requestId":"new","correlationId":"corr:1"}'],
  ['{"type":"event","requestId":"old"}', '{"correlationId":"bad id"}'],
  ['{"type":"event","requestId":{"nested":1}}', '{"correlationId":"bad id"}'],
  ['{"type":"event","requestId":0}', '{"correlationId":"bad id"}'],
  ['{"type":"event"}', '{"requestId":"bad id","correlationId":"bad id"}'],
  ['{"type":"event"}', '{"requestId":"ok:1","correlationId":"bad id"}'],
  ['{"type":"event"}', '{"requestId":false,"correlationId":"ok:1"}'],
  ['{"type":"event"}', '{"requestId":0,"correlationId":0}'],
  ['{"type":"event"}', '{"requestId":true,"correlationId":true}'],
  ['{"type":"event"}', '{"requestId":[],"correlationId":{}}'],
  ['{"type":"event","2":"b","1":"a","extra":"x"}', '{}'],
  ['{"type":"event","emoji":"😀","lone":"\\ud800"}', '{}'],
  ['{"type":"event","n":1e400,"z":-0}', '{}'],
  ['{"type":"event","__proto__":{"x":1}}', '{}'],
  ['{"type":"event"}', '{"requestId":"' + 'a'.repeat(128) + '"}'],
  ['{"type":"event"}', '{"requestId":"' + 'a'.repeat(129) + '"}'],
  ['{"type":"event"}', '{"requestId":"中文"}'],
  ['{"type":"event"}', 'null'],
  ['{"other":1}', '{}'], ['{"type":null}', '{}'],
  ['null', '{}'], ['[]', '{}'], ['"text"', '{}'],
];
const output = pairs.map(([payload, context]) => {
  try {
    return { payload, context, response: Buffer.from(JSON.stringify(createWsEnvelope(JSON.parse(payload), JSON.parse(context)))).toString('base64') };
  } catch { return { payload, context, response: null }; }
});
process.stdout.write(JSON.stringify(output, null, 2) + '\n');
