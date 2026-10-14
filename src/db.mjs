// SQLite storage (D-01). Taken/free cache is global (A-02); names are per project.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const RATINGS = ['medal', 'up', 'wave', 'reject'];
export const TLDS = ['com', 'bg', 'eu'];

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  tlds TEXT NOT NULL DEFAULT 'com', created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS names (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, label TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'tried', rating TEXT, tlds TEXT NOT NULL DEFAULT '', round INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL, UNIQUE (project_id, label));
CREATE TABLE IF NOT EXISTS availability (domain TEXT PRIMARY KEY, status TEXT NOT NULL, checked_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL);
`;

export function openDb(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const now = () => Date.now();
  const q = (sql) => db.prepare(sql);
  const tx = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const proj = (r) => r && { ...r, tlds: r.tlds ? r.tlds.split(',') : [] };

  return {
    close: () => db.close(),
    tx,

    createProject: ({ name, description = '', tlds = ['com'] }) =>
      Number(q('INSERT INTO projects (name, description, tlds, created) VALUES (?, ?, ?, ?)')
        .run(name, description, tlds.join(','), now()).lastInsertRowid),
    listProjects: () => q('SELECT * FROM projects ORDER BY created DESC, id DESC').all().map(proj),
    getProject: (id) => proj(q('SELECT * FROM projects WHERE id = ?').get(id)),
    updateProject: (id, { name, description, tlds }) => {
      const p = proj(q('SELECT * FROM projects WHERE id = ?').get(id));
      if (!p) return false;
      q('UPDATE projects SET name = ?, description = ?, tlds = ? WHERE id = ?')
        .run(name ?? p.name, description ?? p.description, (tlds ?? p.tlds).join(','), id);
      return true;
    },
    deleteProject: (id) => q('DELETE FROM projects WHERE id = ?').run(id).changes > 0,

    listRules: (pid) => q('SELECT id, text FROM rules WHERE project_id = ? ORDER BY id').all(pid),
    addRule: (pid, text) => Number(q('INSERT INTO rules (project_id, text, created) VALUES (?, ?, ?)').run(pid, text, now()).lastInsertRowid),
    updateRule: (pid, id, text) => q('UPDATE rules SET text = ? WHERE id = ? AND project_id = ?').run(text, id, pid).changes > 0,
    deleteRule: (pid, id) => q('DELETE FROM rules WHERE id = ? AND project_id = ?').run(id, pid).changes > 0,

    // R7: every generated label is remembered; returns only the labels that were new.
    addTried: (pid, labels, round) => tx(() => {
      const ins = q('INSERT OR IGNORE INTO names (project_id, label, round, created) VALUES (?, ?, ?, ?)');
      return labels.filter((l) => ins.run(pid, l, round, now()).changes > 0);
    }),
    triedLabels: (pid) => new Set(q('SELECT label FROM names WHERE project_id = ?').all(pid).map((r) => r.label)),
    markCandidates: (pid, labels, tlds) => tx(() => {
      const up = q("UPDATE names SET state = 'candidate', tlds = ? WHERE project_id = ? AND label = ?");
      for (const l of labels) up.run(tlds.join(','), pid, l);
    }),
    // Board: candidates with their rating and per-TLD availability for the TLDs ticked when offered.
    board(pid) {
      const rows = q("SELECT label, rating, tlds, round FROM names WHERE project_id = ? AND state = 'candidate' ORDER BY created, label").all(pid);
      const av = q('SELECT status, checked_at FROM availability WHERE domain = ?');
      return rows.map((r) => {
        const tlds = r.tlds ? r.tlds.split(',') : [];
        return { label: r.label, rating: r.rating, round: r.round,
          tlds: Object.fromEntries(tlds.map((t) => [t, av.get(`${r.label}.${t}`)?.status ?? 'unknown'])) };
      });
    },
    // R10: whole batch or nothing; ratings only for this project's candidates.
    commitRatings: (pid, items) => tx(() => {
      const up = q("UPDATE names SET rating = ? WHERE project_id = ? AND label = ? AND state = 'candidate'");
      for (const { label, rating } of items) {
        if (rating !== null && !RATINGS.includes(rating)) throw new Error(`bad rating ${rating}`);
        if (up.run(rating, pid, label).changes !== 1) throw new Error(`unknown candidate ${label}`);
      }
      return items.length;
    }),
    ratedNames: (pid) => q("SELECT label, rating FROM names WHERE project_id = ? AND rating IS NOT NULL ORDER BY label").all(pid).map((r) => ({ ...r })),

    getAvailability: (domains) => {
      const s = q('SELECT status FROM availability WHERE domain = ?');
      return new Map(domains.flatMap((d) => { const r = s.get(d); return r ? [[d, r.status]] : []; }));
    },
    // 'unknown' is never cached (D-07); taken is final (R7).
    setAvailability: (entries) => tx(() => {
      const up = q(`INSERT INTO availability (domain, status, checked_at) VALUES (?, ?, ?)
        ON CONFLICT(domain) DO UPDATE SET status = excluded.status, checked_at = excluded.checked_at WHERE availability.status <> 'taken'`);
      for (const [d, s] of entries) if (s !== 'unknown') up.run(d, s, now());
    }),

    addSuggestions: (pid, texts) => tx(() => {
      const ins = q('INSERT INTO suggestions (project_id, text, created) VALUES (?, ?, ?)');
      for (const t of texts) ins.run(pid, t, now());
    }),
    listSuggestions: (pid) => q("SELECT id, text FROM suggestions WHERE project_id = ? AND status = 'pending' ORDER BY id").all(pid),
    resolveSuggestion: (pid, id, status) => q("UPDATE suggestions SET status = ? WHERE id = ? AND project_id = ? AND status = 'pending'")
      .run(status, id, pid).changes > 0,
  };
}
