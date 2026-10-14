import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.mjs';

test('projects, rules and suggestions round trip', () => {
  const db = openDb();
  const p = db.createProject({ name: 'Interior', description: 'design site', tlds: ['com', 'bg'] });
  assert.deepEqual(db.getProject(p).tlds, ['com', 'bg']);
  db.updateProject(p, { tlds: ['eu'] });
  assert.deepEqual(db.getProject(p).tlds, ['eu']);
  const r = db.addRule(p, 'contains design');
  assert.equal(db.listRules(p)[0].text, 'contains design');
  assert.ok(db.updateRule(p, r, 'contains home'));
  db.addSuggestions(p, ['avoid hyphens', 'try studio']);
  const [s1] = db.listSuggestions(p);
  assert.ok(db.resolveSuggestion(p, s1.id, 'accepted'));
  assert.equal(db.listSuggestions(p).length, 1);
  assert.ok(db.deleteProject(p));
  assert.equal(db.listRules(p).length, 0, 'cascade');
});

test('tried names are unique per project, not across projects', () => {
  const db = openDb();
  const a = db.createProject({ name: 'a' }), b = db.createProject({ name: 'b' });
  assert.deepEqual(db.addTried(a, ['x', 'y'], 1), ['x', 'y']);
  assert.deepEqual(db.addTried(a, ['y', 'z'], 2), ['z']);
  assert.deepEqual(db.addTried(b, ['x'], 1), ['x']);
  assert.deepEqual([...db.triedLabels(a)].sort(), ['x', 'y', 'z']);
});

test('availability cache is global, taken is final, unknown not cached', () => {
  const db = openDb();
  db.setAvailability([['x.com', 'taken'], ['y.com', 'free'], ['z.com', 'unknown']]);
  db.setAvailability([['x.com', 'free'], ['y.com', 'taken']]);
  assert.deepEqual([...db.getAvailability(['x.com', 'y.com', 'z.com'])], [['x.com', 'taken'], ['y.com', 'taken']]);
});

test('only candidates are on the board and can be rated; bad batch rolls back', () => {
  const db = openDb();
  const p = db.createProject({ name: 'p' });
  db.addTried(p, ['aa', 'bb', 'cc'], 1);
  db.markCandidates(p, ['aa', 'bb'], ['com', 'bg']);
  db.setAvailability([['aa.com', 'free'], ['aa.bg', 'likely']]);
  const board = db.board(p);
  assert.deepEqual(board.map((n) => n.label), ['aa', 'bb']);
  assert.deepEqual(board[0].tlds, { com: 'free', bg: 'likely' });

  assert.throws(() => db.commitRatings(p, [{ label: 'aa', rating: 'medal' }, { label: 'cc', rating: 'up' }]), /unknown candidate/);
  assert.throws(() => db.commitRatings(p, [{ label: 'aa', rating: 'medal' }, { label: 'bb', rating: 'love' }]), /bad rating/);
  assert.equal(db.board(p)[0].rating, null, 'rolled back');

  assert.equal(db.commitRatings(p, [{ label: 'aa', rating: 'medal' }, { label: 'bb', rating: 'reject' }]), 2);
  assert.deepEqual(db.ratedNames(p), [{ label: 'aa', rating: 'medal' }, { label: 'bb', rating: 'reject' }]);
});

test('board rebuilds from candidate rows after reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dc-db-'));
  try {
    const file = join(dir, 'x.db');
    let db = openDb(file);
    const p = db.createProject({ name: 'p' });
    db.addTried(p, ['aa', 'bb'], 1);
    db.markCandidates(p, ['aa'], ['com']);
    db.setAvailability([['aa.com', 'free']]);
    db.commitRatings(p, [{ label: 'aa', rating: 'wave' }]);
    db.close();
    db = openDb(file);
    assert.deepEqual(db.board(p), [{ label: 'aa', rating: 'wave', round: 1, tlds: { com: 'free' } }]);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
