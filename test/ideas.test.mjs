import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseLabels, parseSuggestions, buildPrompt, generateIdeas, suggestRules, runPi } from '../src/ideas.mjs';

const launcher = fileURLToPath(new URL('./stub-launcher.cjs', import.meta.url));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('parseLabels: clean JSON, fenced fallback, validation and dedupe', () => {
  assert.deepEqual(parseLabels('["designhome","DesignHome","studio-nest"]'), ['designhome', 'studio-nest']);
  assert.deepEqual(parseLabels('Sure!\n```json\n["a-b", "-bad", "bad-", "x.com", "dom ain", 7, "ок"]\n```'), ['a-b', 'x']);
  assert.deepEqual(parseLabels('no array here'), []);
});

test('parseSuggestions keeps non-empty strings, max 8', () => {
  assert.deepEqual(parseSuggestions('["  avoid hyphens ", "", 3]'), ['avoid hyphens']);
  assert.equal(parseSuggestions(JSON.stringify(Array(12).fill('r'))).length, 8);
});

const ctx = { project: { name: 'Interior', description: 'design studio' }, rules: [{ text: 'contains home' }],
  rated: [{ label: 'nesthome', rating: 'medal' }, { label: 'ugly', rating: 'reject' }], tried: ['nesthome', 'ugly', 'old'] };

test('prompt carries rules, ratings, tried list and count', () => {
  const p = buildPrompt(ctx, 20);
  for (const s of ['contains home', 'Loved (medal): nesthome', 'Rejected (avoid this direction): ugly', 'never repeat: nesthome, ugly, old', 'Give 20 new']) assert.ok(p.includes(s), s);
});

test('generateIdeas merges models, skips a failing one', async () => {
  const runner = async (m) => {
    if (m.model === 'bad') throw new Error('bad: exit 1');
    return m.model === 'a' ? '["one","two"]' : '["two","three"]';
  };
  const r = await generateIdeas(ctx, 4, { models: [{ model: 'a' }, { model: 'b' }, { model: 'bad' }], runner });
  assert.deepEqual(r.labels, ['one', 'two', 'three']);
  assert.deepEqual(r.errors, ['bad: exit 1']);
});

test('suggestRules uses the given planning model once', async () => {
  const calls = [];
  const s = await suggestRules(ctx, [{ label: 'ugly', rating: 'reject' }], { model: { model: 'plan' }, runner: async (m, p) => { calls.push(m.model); assert.ok(p.includes('ugly=reject')); return '["no hyphens"]'; } });
  assert.deepEqual(s, ['no hyphens']);
  assert.deepEqual(calls, ['plan']);
});

test('runPi passes prompt on stdin and returns stdout', async () => {
  process.env.STUB_MODE = 'echo';
  const out = await runPi({ model: 'm', thinking: 'high' }, 'hello', { launcher });
  // node launcher --print --model m --thinking high + 5 flags = argv length 12
  assert.deepEqual(parseLabels(out), ['echo-name', 'args12', 'gotstdin']);
});

test('runPi timeout kills launcher and grandchild, then rejects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dc-pi-'));
  try {
    process.env.STUB_MODE = 'hang';
    process.env.STUB_PIDFILE = join(dir, 'pid');
    await assert.rejects(runPi({ model: 'm' }, 'x', { launcher, timeoutMs: 1500 }), /timeout/);
    const gpid = Number(readFileSync(process.env.STUB_PIDFILE, 'utf8'));
    assert.ok(gpid > 0);
    assert.equal(alive(gpid), false, 'grandchild still running');
  } finally {
    delete process.env.STUB_MODE;
    rmSync(dir, { recursive: true, force: true });
  }
});
