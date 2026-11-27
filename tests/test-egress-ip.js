'use strict';

// The egress-IP detector (src/providers/egress-ip.js) behind the provider
// "限定出口 IP" gate. The gate fails closed when the address is unknown, so what is
// worth pinning is how rarely the detector goes blind: it spreads load over many
// free services, stops asking one that is refusing, and never mixes IPv4 with IPv6.

const test = require('node:test');
const assert = require('node:assert/strict');

const { CANDIDATES, createDetector, isValidIp } = require('../src/providers/egress-ip');

const MIN = 60 * 1000;

function fakeDetector(behaviour, count = 6) {
  const candidates = Array.from({ length: count }, (_, i) => ({ id: `s${i}`, url: `https://s${i}.example/ip`, parse: x => x }));
  const clock = { t: 1_000_000 };
  const calls = [];
  const detector = createDetector({
    candidates,
    now: () => clock.t,
    fetcher: async (candidate, family) => {
      calls.push({ id: candidate.id, family });
      return behaviour(candidate, family, calls.length);
    },
  });
  return { detector, clock, calls };
}

const refuse = status => Object.assign(new Error(`http_${status}`), { status });

test('every refresh starts one service further along, so no free tier takes all the traffic', async () => {
  const { detector, calls } = fakeDetector(() => '203.0.113.7', 6);
  for (let i = 0; i < 12; i += 1) await detector.detect();
  const used = calls.map(call => call.id);
  assert.deepEqual(used.slice(0, 6), ['s0', 's1', 's2', 's3', 's4', 's5']);
  assert.deepEqual(used.slice(6), ['s0', 's1', 's2', 's3', 's4', 's5'], 'and it wraps around');
});

test('a failing service is skipped inside the same refresh', async () => {
  const { detector } = fakeDetector(candidate => {
    if (candidate.id === 's0') throw new Error('timeout');
    return '203.0.113.7';
  });
  const result = await detector.detect();
  assert.equal(result.ip, '203.0.113.7');
  assert.equal(result.source, 's1', 'the next service answered');
});

test('a rate-limited service sits out for 15 minutes and is then tried again', async () => {
  let limited = true;
  const { detector, clock, calls } = fakeDetector(candidate => {
    if (candidate.id === 's0' && limited) throw refuse(429);
    return '203.0.113.7';
  }, 3);
  await detector.detect();
  assert.equal(detector.snapshot()[0].coolingDown, true);
  // A full rotation later s0 would be first again, but it is cooling down.
  for (let i = 0; i < 6; i += 1) await detector.detect();
  assert.equal(calls.filter(call => call.id === 's0').length, 1, 'it is not asked again while it refuses');

  clock.t += 14 * MIN;
  assert.equal(detector.snapshot()[0].coolingDown, true, 'still inside the window');
  clock.t += 2 * MIN;
  assert.equal(detector.snapshot()[0].coolingDown, false);
  limited = false;
  for (let i = 0; i < 3; i += 1) await detector.detect();
  assert.ok(calls.filter(call => call.id === 's0').length >= 2, 'once the window is over it is back in rotation');
});

test('an ordinary failure backs off 30s, then 60s, and a success clears it', async () => {
  let failing = true;
  const { detector, clock } = fakeDetector(candidate => {
    if (candidate.id === 's0' && failing) throw new Error('timeout');
    return '203.0.113.7';
  }, 1);
  await assert.rejects(detector.detect());
  assert.equal(Math.round(detector.snapshot()[0].retryInMs / 1000), 30);
  clock.t += 31 * 1000;
  await assert.rejects(detector.detect());
  assert.equal(Math.round(detector.snapshot()[0].retryInMs / 1000), 60);
  failing = false;
  clock.t += 61 * 1000;
  assert.equal((await detector.detect()).ip, '203.0.113.7');
  assert.equal(detector.snapshot()[0].failures, 0);
  assert.equal(detector.snapshot()[0].coolingDown, false);
});

test('when every service is cooling down it still probes instead of going dark', async () => {
  let up = false;
  const { detector, calls } = fakeDetector(() => { if (!up) throw refuse(429); return '203.0.113.7'; }, 3);
  await assert.rejects(detector.detect());
  assert.ok(detector.snapshot().every(entry => entry.coolingDown), 'all three are now cooling down');
  up = true;
  calls.length = 0;
  const result = await detector.detect();
  assert.equal(result.ip, '203.0.113.7', 'the closest to recovery was tried and answered');
  assert.ok(calls.length >= 1);
});

test('lookups are forced to IPv4, with an unconstrained fallback only when v4 fails everywhere', async () => {
  const { detector, calls } = fakeDetector(() => '203.0.113.7');
  await detector.detect();
  assert.deepEqual(calls.map(call => call.family), [4], 'the normal path never leaves IPv4');

  const v6only = fakeDetector((candidate, family) => {
    if (family === 4) throw new Error('ENOTFOUND');
    return '2001:db8::1';
  });
  const result = await v6only.detector.detect();
  assert.equal(result.ip, '2001:db8::1');
  assert.ok(v6only.calls.some(call => call.family === 4) && v6only.calls.some(call => call.family === 0));
  assert.ok(v6only.calls.filter(call => call.family === 0).length <= 2, 'the fallback is only two services wide');
});

test('one refresh is bounded: it gives up after a few services instead of walking the list', async () => {
  const { detector, calls } = fakeDetector(() => { throw new Error('down'); }, 15);
  await assert.rejects(detector.detect(), error => error.code === 'EGRESS_IP_DETECT_FAILED');
  assert.ok(calls.length <= 4 + 2, `at most 4 on the v4 pass and 2 on the fallback (made ${calls.length})`);
});

test('the real candidate list is wide, unique, https-only and free of domestic echo services', () => {
  assert.ok(CANDIDATES.length >= 12, `plenty of fallbacks (have ${CANDIDATES.length})`);
  assert.equal(new Set(CANDIDATES.map(c => c.id)).size, CANDIDATES.length, 'ids are unique');
  assert.equal(new Set(CANDIDATES.map(c => new URL(c.url).hostname)).size, CANDIDATES.length, 'no two entries lean on the same host');
  for (const candidate of CANDIDATES) {
    assert.match(candidate.url, /^https:\/\//, `${candidate.id} is https`);
    // Under split routing these are reached DIRECT and would report the home IP
    // rather than the one api.anthropic.com sees.
    assert.doesNotMatch(new URL(candidate.url).hostname, /ipip\.net|3322\.net|ip\.cn|ip138|baidu|qq\.com|163\.com|sohu|sina|taobao|aliyun|myip\.com\.tw/i,
      `${candidate.id} must not be a domestic service`);
  }
});

test('every candidate parser reads the shape its service actually answers with', () => {
  const bodies = {
    cloudflare: 'fl=464f179\nh=www.cloudflare.com\nip=203.0.113.7\nts=1791879553.000\nvisit_scheme=https\n',
    ipify: '{"ip":"203.0.113.7"}',
    aws: '203.0.113.7\n',
    ipwho: '{\n  "ip": "203.0.113.7",\n  "success": true,\n  "type": "IPv4"\n}',
  };
  const byId = Object.fromEntries(CANDIDATES.map(c => [c.id, c]));
  for (const [id, body] of Object.entries(bodies)) assert.equal(byId[id].parse(body), '203.0.113.7', id);
  assert.equal(byId['cloudflare-1111'].parse(bodies.cloudflare), '203.0.113.7');
  // Every parser must hand back something isValidIp accepts, never throw on a bare address.
  for (const candidate of CANDIDATES) {
    const sample = /trace/.test(candidate.url) ? bodies.cloudflare : (candidate.parse === byId.ipify.parse ? bodies.ipify : bodies.aws);
    assert.ok(isValidIp(candidate.parse(sample)), `${candidate.id} parses its own shape`);
  }
  // A service answering with an error page must not produce an address.
  assert.equal(byId.aws.parse('<html>blocked</html>').startsWith('<'), true);
  assert.equal(isValidIp(byId.aws.parse('<html>blocked</html>')), false, 'and isValidIp rejects it');
});

test('egress policy starts the monitor only for a restricted provider and uses the current reading', () => {
  let starts = 0, reading = {};
  const policy = require('../src/native/binding').getNative().egressIpPolicyApi({
    ensureMonitorStarted() { starts++; }, getCachedEgressIp() { return reading; },
  });
  assert.deepEqual(policy.checkEgressIpAllowed({}), { allowed: true, code: null, detail: '' });
  assert.equal(starts, 0);
  const provider = { egressIpAllowlist: [' 192.0.2.7 ', '192.0.2.7'] };
  assert.deepEqual(policy.normalizeAllowlist(provider.egressIpAllowlist), ['192.0.2.7']);
  assert.throws(() => policy.assertEgressIpAllowed(provider), { code: 'EGRESS_IP_UNKNOWN' });
  reading = { error: 'offline' };
  assert.match(policy.checkEgressIpAllowed(provider).detail, /offline/);
  reading = { ip: '192.0.2.8' };
  assert.throws(() => policy.assertEgressIpAllowed(provider), { code: 'EGRESS_IP_MISMATCH' });
  reading = { ip: '192.0.2.7' };
  assert.equal(policy.assertEgressIpAllowed(provider), true);
  assert.equal(starts, 4);
});
