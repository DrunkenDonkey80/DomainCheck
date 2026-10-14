import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { generate } from '../src/generate.mjs';

// ideas stub: hands out labels from a queue, records requested counts and the tried list it saw
function ideasStub(batches) {
  const calls = [];
  const fn = async (ctx, count) => { calls.push({ count, tried: ctx.tried.slice() }); return { labels: batches.shift() ?? [], errors: [] }; };
  return Object.assign(fn, { calls });
}
// checker stub: free iff label starts with "f"; records every domain checked
function checkerStub() {
  const seen = [];
  return { seen, checkDomains: async (ds) => { seen.push(...ds); return new Map(ds.map((d) => [d, d.startsWith('f') ? 'free' : 'taken'])); } };
}
const setup = () => { const db = openDb(); return { db, pid: db.createProject({ name: 'p' }) }; };

test('stops at N, asks 2×N, skips tried names', async () => {
  const { db, pid } = setup();
  const ideas = ideasStub([['fa', 'ta', 'tb'], ['fa', 'fb', 'fc']]);
  const checker = checkerStub();
  const r = await generate(db, pid, { n: 2, tlds: ['com'] }, { ideas, checker });
  assert.deepEqual([r.found, r.rounds], [3, 2]);
  assert.deepEqual(ideas.calls.map((c) => c.count), [4, 4]);
  assert.deepEqual(ideas.calls[1].tried.sort(), ['fa', 'ta', 'tb']);
  assert.deepEqual(checker.seen, ['fa.com', 'ta.com', 'tb.com', 'fb.com', 'fc.com'], 'fa not checked twice');
  assert.deepEqual(db.board(pid).map((x) => x.label), ['fa', 'fb', 'fc']);
  assert.deepEqual(db.getProject(pid).tlds, ['com'], 'TLD selection remembered');
});

test('cap: stops after 4 rounds and reports found k of N', async () => {
  const { db, pid } = setup();
  const ideas = ideasStub([['t1', 'f1'], ['t2'], ['t3'], ['t4'], ['f5']]);
  const r = await generate(db, pid, { n: 5, tlds: ['com'] }, { ideas, checker: checkerStub() });
  assert.deepEqual([r.found, r.n, r.rounds, ideas.calls.length], [1, 5, 4, 4]);
});

test('N=1 with several free in one round: all become candidates (Q-06)', async () => {
  const { db, pid } = setup();
  const r = await generate(db, pid, { n: 1, tlds: ['com'] }, { ideas: ideasStub([['fa', 'fb', 'fc', 'tx']]), checker: checkerStub() });
  assert.equal(r.found, 3);
  assert.equal(db.board(pid).length, 3);
});

test('cached domains are not re-checked; only uncached TLDs are', async () => {
  const { db, pid } = setup();
  db.setAvailability([['fa.com', 'taken'], ['fb.com', 'free']]); // e.g. from another project
  const checker = checkerStub();
  await generate(db, pid, { n: 5, tlds: ['com', 'bg'] }, { ideas: ideasStub([['fa', 'fb']]), checker, maxRounds: 1 });
  assert.deepEqual(checker.seen.sort(), ['fa.bg', 'fb.bg']);
  assert.deepEqual(db.board(pid).find((x) => x.label === 'fa').tlds, { com: 'taken', bg: 'free' });
});

test('every model failing ends the request', async () => {
  const { db, pid } = setup();
  const r = await generate(db, pid, { n: 3, tlds: ['com'] }, { ideas: async () => ({ labels: [], errors: ['m: timeout'] }), checker: checkerStub() });
  assert.deepEqual([r.found, r.rounds, r.errors], [0, 1, ['m: timeout']]);
});
