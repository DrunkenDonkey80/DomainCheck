import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChecker, createBgQueue, Throttled } from '../src/check.mjs';

const tick = () => new Promise((r) => setTimeout(r, 1));
// stub method: records concurrency, answers via fn
function stub(name, kind, tlds, cap, fn) {
  const m = { name, kind, tlds, cap, calls: 0, active: 0, peak: 0 };
  m.run = async (d) => {
    m.calls++; m.active++; m.peak = Math.max(m.peak, m.active);
    try { await tick(); return fn(d); } finally { m.active--; }
  };
  return m;
}
const dnsMaybe = () => stub('dns', 'dns', ['com', 'bg', 'eu'], 100, () => 'maybe');

test('least-busy pick spreads load and respects caps', async () => {
  const a = stub('a', 'registry', ['com'], 2, () => 'free');
  const b = stub('b', 'registry', ['com'], 4, () => 'free');
  const c = createChecker({ methods: [dnsMaybe(), a, b] });
  const doms = Array.from({ length: 30 }, (_, i) => `x${i}.com`);
  const r = await c.checkDomains(doms);
  assert.ok([...r.values()].every((v) => v === 'free'));
  assert.ok(a.peak <= 2 && b.peak <= 4, `peaks ${a.peak} ${b.peak}`);
  assert.ok(a.calls > 0 && b.calls > a.calls, `calls ${a.calls} ${b.calls}`);
});

test('DNS taken skips registry', async () => {
  const reg = stub('r', 'registry', ['com'], 4, () => 'free');
  const c = createChecker({ methods: [stub('dns', 'dns', ['com'], 4, () => 'taken'), reg] });
  assert.equal((await c.checkDomains(['x.com'])).get('x.com'), 'taken');
  assert.equal(reg.calls, 0);
});

test('failover on error, then unknown when every method fails', async () => {
  const bad = stub('bad', 'registry', ['com'], 4, () => { throw new Error('boom'); });
  const good = stub('good', 'registry', ['com'], 4, () => 'taken');
  let c = createChecker({ methods: [dnsMaybe(), bad, good] });
  assert.equal((await c.checkDomains(['x.com'])).get('x.com'), 'taken');

  const bad2 = stub('bad2', 'registry', ['com'], 4, () => { throw new Error('boom'); });
  c = createChecker({ methods: [stub('d', 'dns', ['com'], 4, () => { throw new Error('dns down'); }), bad2] });
  assert.equal((await c.checkDomains(['y.com'])).get('y.com'), 'unknown');
});

test('throttled method rests for the backoff, then returns', async () => {
  let t = 0, throttle = true;
  const w = stub('w', 'registry', ['eu'], 4, () => { if (throttle) throw new Throttled('limit'); return 'free'; });
  const c = createChecker({ methods: [dnsMaybe(), w], backoffMs: 1000, now: () => t });
  assert.equal((await c.checkDomains(['a.eu'])).get('a.eu'), 'unknown');
  throttle = false;
  assert.equal((await c.checkDomains(['b.eu'])).get('b.eu'), 'unknown');
  assert.equal(w.calls, 1, 'not called while resting');
  t = 1000;
  assert.equal((await c.checkDomains(['c.eu'])).get('c.eu'), 'free');
});

test('.bg is DNS-only: likely or taken', async () => {
  const c = createChecker({ methods: [stub('d', 'dns', ['bg'], 4, (d) => (d === 'a.bg' ? 'taken' : 'maybe'))] });
  const r = await c.checkDomains(['a.bg', 'b.bg']);
  assert.equal(r.get('a.bg'), 'taken');
  assert.equal(r.get('b.bg'), 'likely');
});

test('.bg confirm queue spaces queries and pauses after a limit reply', async () => {
  let t = 0;
  const sleeps = [], sent = [];
  const replies = { 'a.bg': 'registration status: available', 'b.bg': 'registration status: busy, active', 'c.bg': 'Query limit exceeded, try again later.' };
  const q = createBgQueue({
    gapMs: 60_000, pauseMs: 1_800_000, now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    query: async (d) => { sent.push(d); return replies[d]; },
  });
  const res = await Promise.all(['a.bg', 'b.bg', 'c.bg', 'd.bg'].map((d) => q.confirm(d)));
  assert.deepEqual(res, ['free', 'taken', 'pending', 'pending']);
  assert.deepEqual(sent, ['a.bg', 'b.bg', 'c.bg'], 'no query while paused');
  assert.deepEqual(sleeps, [60_000, 60_000]);
  t += 1_800_000;
  replies['d.bg'] = 'registration status: available';
  assert.equal(await q.confirm('d.bg'), 'free');
});
