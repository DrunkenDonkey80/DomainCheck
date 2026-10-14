import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.mjs';
import { startServer } from '../server.mjs';

let server, port, db;
const ideas = async () => ({ labels: ['fa', 'fb', 'tc'], errors: [] });
const checker = { checkDomains: async (ds) => new Map(ds.map((d) => [d, d.startsWith('f') ? 'free' : 'taken'])) };
let suggestImpl = async () => ['prefer short names'];
const suggestCalls = [];

before(async () => {
  db = openDb();
  server = await startServer({ port: 0, db, checker, ideas, bgQueue: { confirm: async () => 'free' },
    suggest: async (...a) => { suggestCalls.push(a); return suggestImpl(...a); }, log: () => {} });
  port = server.address().port;
});
after(() => server.close());

// raw request so tests control Host, Origin, Content-Type and the unnormalized path
function req(method, path, { body, headers = {} } = {}) {
  return new Promise((ok, fail) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path,
      headers: { host: `127.0.0.1:${port}`, ...(data !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let t = ''; res.on('data', (c) => (t += c));
      res.on('end', () => ok({ status: res.statusCode, text: t, json: (() => { try { return JSON.parse(t); } catch { return null; } })() }));
    });
    r.on('error', fail);
    if (data !== undefined) r.write(data);
    r.end();
  });
}

test('fresh database lists no projects; static page served', async () => {
  assert.deepEqual((await req('GET', '/api/projects')).json, []);
  const page = await req('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /DomainCheck/);
});

test('wrong Host is refused (DNS rebinding)', async () => {
  assert.equal((await req('GET', '/api/projects', { headers: { host: `evil.example:${port}` } })).status, 421);
});

test('cross-origin POST is refused', async () => {
  const r = await req('POST', '/api/projects', { body: { name: 'x' }, headers: { origin: 'http://evil.example' } });
  assert.equal(r.status, 403);
  assert.deepEqual((await req('GET', '/api/projects')).json, []);
});

test('non-JSON POST is refused', async () => {
  assert.equal((await req('POST', '/api/projects', { body: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
});

test('oversized body is refused', async () => {
  assert.equal((await req('POST', '/api/projects', { body: { name: 'x', description: 'a'.repeat(70_000) } })).status, 413);
});

test('path traversal is refused', async () => {
  for (const p of ['/../server.mjs', '/..%2fserver.mjs', '/%2e%2e/package.json', '/..%5cserver.mjs']) {
    const r = await req('GET', p);
    assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.doesNotMatch(r.text, /createApp|"scripts"/, p);
  }
});

test('input validation: N, TLDs and ratings', async () => {
  const { id } = (await req('POST', '/api/projects', { body: { name: 'Valid', tlds: ['com'] } })).json;
  for (const body of [{ n: 0, tlds: ['com'] }, { n: 51, tlds: ['com'] }, { n: 2.5, tlds: ['com'] }, { n: 3, tlds: [] }, { n: 3, tlds: ['net'] }]) {
    assert.equal((await req('POST', `/api/projects/${id}/generate`, { body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await req('POST', `/api/projects/${id}/ratings`, { body: { items: [{ label: 'nope', rating: 'medal' }] } })).status, 400);
  assert.equal((await req('POST', `/api/projects/999/generate`, { body: { n: 1, tlds: ['com'] } })).status, 404);
});

test('generate fills the board; rule CRUD works', async () => {
  const { id } = (await req('POST', '/api/projects', { body: { name: 'Interior', description: 'design' } })).json;
  const g = (await req('POST', `/api/projects/${id}/generate`, { body: { n: 2, tlds: ['com', 'eu'] } })).json;
  assert.equal(g.result.found, 2);
  assert.deepEqual(g.board.map((n) => n.label), ['fa', 'fb']);
  assert.deepEqual(g.board[0].tlds, { com: 'free', eu: 'free' });
  const r = (await req('POST', `/api/projects/${id}/rules`, { body: { text: 'contains home' } })).json;
  assert.equal(r.rules[0].text, 'contains home');
  const d = await req('DELETE', `/api/projects/${id}/rules/${r.rules[0].id}`, { body: {} });
  assert.equal(d.status, 200, d.text);
  assert.equal(d.json.rules.length, 0);
});

// P4-3: batch commit saves atomically first, then one suggestRules call; pi failure keeps the ratings.
async function projectWithBoard(name) {
  const { id } = (await req('POST', '/api/projects', { body: { name } })).json;
  await req('POST', `/api/projects/${id}/generate`, { body: { n: 2, tlds: ['com'] } });
  return id;
}

test('valid batch saves, calls suggestRules once, stores suggestions', async () => {
  const id = await projectWithBoard('Commit ok');
  suggestCalls.length = 0;
  const r = await req('POST', `/api/projects/${id}/ratings`, { body: { items: [{ label: 'fa', rating: 'medal' }, { label: 'fb', rating: 'reject' }] } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.saved, 2);
  assert.equal(r.json.suggestError, null);
  assert.equal(suggestCalls.length, 1);
  assert.deepEqual(suggestCalls[0][1], [{ label: 'fa', rating: 'medal' }, { label: 'fb', rating: 'reject' }]);
  assert.deepEqual(r.json.suggestions.map((s) => s.text), ['prefer short names']);
  const acc = await req('POST', `/api/projects/${id}/suggestions/${r.json.suggestions[0].id}`, { body: { action: 'accept' } });
  assert.deepEqual([acc.json.rules.map((x) => x.text), acc.json.suggestions.length], [['prefer short names'], 0]);
});

test('invalid batch rolls back and makes no pi call', async () => {
  const id = await projectWithBoard('Commit bad');
  suggestCalls.length = 0;
  const r = await req('POST', `/api/projects/${id}/ratings`, { body: { items: [{ label: 'fa', rating: 'medal' }, { label: 'tc', rating: 'up' }] } });
  assert.equal(r.status, 400); // tc was tried but never a candidate
  assert.equal(suggestCalls.length, 0);
  const v = (await req('GET', `/api/projects/${id}`)).json;
  assert.equal(v.board.find((n) => n.label === 'fa').rating, null);
});

test('pi failure after the save keeps the ratings and reports the error', async () => {
  const id = await projectWithBoard('Commit pi down');
  suggestImpl = async () => { throw new Error('plan: timeout after 90000 ms'); };
  try {
    const r = await req('POST', `/api/projects/${id}/ratings`, { body: { items: [{ label: 'fa', rating: 'up' }] } });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.saved, r.json.suggestError], [1, 'plan: timeout after 90000 ms']);
    assert.equal(r.json.board.find((n) => n.label === 'fa').rating, 'up');
  } finally { suggestImpl = async () => ['prefer short names']; }
});
