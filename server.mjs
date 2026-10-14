// Local web server: static page + JSON API (A-01: 127.0.0.1 only; boundary checks from review finding 3).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb, RATINGS, TLDS } from './src/db.mjs';
import { createChecker, createBgQueue } from './src/check.mjs';
import { generateIdeas, suggestRules } from './src/ideas.mjs';
import { generate } from './src/generate.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_BODY = 64 * 1024;

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (msg) => { throw new HttpError(400, msg); };
const str = (v, max, name) => (typeof v === 'string' && v.trim().length <= max ? v.trim() : bad(`${name} must be text up to ${max} chars`));
const tldList = (v) => (Array.isArray(v) && v.length && v.every((t) => TLDS.includes(t)) ? [...new Set(v)] : bad('tlds must be a non-empty subset of com, bg, eu'));

async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new HttpError(413, 'body too large'); chunks.push(c); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { bad('invalid JSON'); }
}

export function createApp({ db, checker, bgQueue, ideas = generateIdeas, suggest = suggestRules, log = console.log } = {}) {
  const busy = new Set();
  const ctxOf = (pid) => ({ project: db.getProject(pid), rules: db.listRules(pid), rated: db.ratedNames(pid), tried: [...db.triedLabels(pid)] });
  const view = (pid) => ({ project: db.getProject(pid), rules: db.listRules(pid), board: db.board(pid), suggestions: db.listSuggestions(pid) });
  const candidate = (pid, label) => db.board(pid).find((n) => n.label === label) ?? bad('unknown candidate');

  async function api(method, parts, body) {
    const [, , idRaw, sub, subId] = parts; // parts: ['', 'projects', id, sub, subId]
    if (parts[1] !== 'projects') throw new HttpError(404, 'not found');
    if (idRaw === undefined) {
      if (method === 'GET') return db.listProjects();
      if (method === 'POST') return { id: db.createProject({ name: str(body.name, 100, 'name') || bad('name required'), description: str(body.description ?? '', 2000, 'description'), tlds: body.tlds ? tldList(body.tlds) : ['com'] }) };
      throw new HttpError(405, 'method not allowed');
    }
    const pid = Number(idRaw);
    if (!Number.isInteger(pid) || !db.getProject(pid)) throw new HttpError(404, 'no such project');

    if (sub === undefined) {
      if (method === 'GET') return view(pid);
      if (method === 'PUT') {
        db.updateProject(pid, { name: body.name !== undefined ? str(body.name, 100, 'name') || bad('name required') : undefined,
          description: body.description !== undefined ? str(body.description, 2000, 'description') : undefined,
          tlds: body.tlds !== undefined ? tldList(body.tlds) : undefined });
        return view(pid);
      }
      if (method === 'DELETE') return { deleted: db.deleteProject(pid) };
    }
    if (sub === 'rules') {
      if (method === 'POST' && subId === undefined) { db.addRule(pid, str(body.text, 500, 'text') || bad('text required')); return view(pid); }
      const rid = Number(subId);
      if (method === 'PUT' && db.updateRule(pid, rid, str(body.text, 500, 'text') || bad('text required'))) return view(pid);
      if (method === 'DELETE' && db.deleteRule(pid, rid)) return view(pid);
      throw new HttpError(404, 'no such rule');
    }
    if (method !== 'POST') throw new HttpError(405, 'method not allowed');
    if (sub === 'generate') {
      const n = body.n;
      if (!Number.isInteger(n) || n < 1 || n > 50) bad('n must be an integer from 1 to 50');
      const tlds = tldList(body.tlds);
      if (busy.has(pid)) throw new HttpError(409, 'generation already running for this project');
      busy.add(pid);
      try {
        log(`generate project=${pid} n=${n} tlds=${tlds}`);
        const result = await generate(db, pid, { n, tlds }, { checker, ideas });
        log(`generate project=${pid} found=${result.found} rounds=${result.rounds} errors=${result.errors.length}`);
        return { result, ...view(pid) };
      } finally { busy.delete(pid); }
    }
    if (sub === 'ratings') {
      if (!Array.isArray(body.items) || !body.items.length || body.items.length > 500) bad('items must be a list of 1 to 500 ratings');
      const items = body.items.map((it) => ({ label: str(it?.label, 63, 'label'), rating: it?.rating ?? null }));
      if (items.some((it) => it.rating !== null && !RATINGS.includes(it.rating))) bad('bad rating');
      try { db.commitRatings(pid, items); } catch (e) { bad(e.message); } // rolled back as a whole
      // Saved first; suggestions are a separate outcome (review finding 5, D-05).
      let suggestError = null;
      try {
        log(`suggestRules project=${pid} ratings=${items.length}`);
        const texts = await suggest({ ...ctxOf(pid), pending: db.listSuggestions(pid) }, items);
        db.addSuggestions(pid, texts);
      } catch (e) { suggestError = e.message; log(`suggestRules failed: ${e.message}`); }
      return { saved: items.length, suggestError, ...view(pid) };
    }
    if (sub === 'suggestions') {
      const sid = Number(subId), action = body.action;
      if (!['accept', 'ignore'].includes(action)) bad('action must be accept or ignore');
      const s = db.listSuggestions(pid).find((x) => x.id === sid) ?? bad('no such pending suggestion');
      db.tx(() => { if (action === 'accept') db.addRule(pid, s.text); db.resolveSuggestion(pid, sid, action === 'accept' ? 'accepted' : 'ignored'); });
      return view(pid);
    }
    if (sub === 'recheck') { // Q-02: manual only; .bg stays DNS-only (D-09)
      const n = candidate(pid, str(body.label, 63, 'label'));
      const ds = Object.entries(n.tlds).filter(([, s]) => s !== 'taken').map(([t]) => `${n.label}.${t}`);
      db.setAvailability(await checker.checkDomains(ds));
      return view(pid);
    }
    if (sub === 'confirm') { // D-09: slow .bg WHOIS queue
      const n = candidate(pid, str(body.label, 63, 'label'));
      if (!('bg' in n.tlds)) bad('name was not checked in .bg');
      const status = await bgQueue.confirm(`${n.label}.bg`);
      if (status === 'free' || status === 'taken') db.setAvailability([[`${n.label}.bg`, status]]);
      return { confirm: status, ...view(pid) };
    }
    throw new HttpError(404, 'not found');
  }

  return async function handler(req, res) {
    const send = (code, data, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
      res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
    };
    try {
      const port = req.socket.localPort;
      const host = req.headers.host;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(421, 'bad host'); // DNS rebinding
      const url = new URL(req.url, `http://${host}`);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${host}`) throw new HttpError(403, 'cross-origin request refused');
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'JSON only');
      }
      if (url.pathname.startsWith('/api/')) {
        const body = req.method === 'GET' ? {} : await readJson(req);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) bad('body must be a JSON object');
        return send(200, await api(req.method, url.pathname.slice(4).split('/'), body));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      let rel;
      try { rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); } catch { bad('bad path'); }
      const file = resolve(PUBLIC, '.' + rel);
      if (!file.startsWith(PUBLIC + sep)) throw new HttpError(403, 'forbidden');
      const data = await readFile(file).catch(() => { throw new HttpError(404, 'not found'); });
      return send(200, data, TYPES[extname(file)] ?? 'application/octet-stream');
    } catch (e) {
      const code = e instanceof HttpError ? e.code : 500;
      if (code === 500) console.error(e);
      if (!res.headersSent) send(code, { error: code === 500 ? 'internal error' : e.message });
    }
  };
}

export function startServer({ port = 8787, dbFile = join(ROOT, 'data', 'domaincheck.db'), ...deps } = {}) {
  const db = deps.db ?? openDb(dbFile);
  const app = createApp({ db, checker: deps.checker ?? createChecker(), bgQueue: deps.bgQueue ?? createBgQueue(), ...deps });
  const server = http.createServer(app);
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const s = await startServer({ port: Number(process.env.PORT) || 8787 });
  console.log(`DomainCheck on http://127.0.0.1:${s.address().port}`);
}
