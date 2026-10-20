// DomainCheck page. All user and model text goes through textContent (never innerHTML).
const $ = (id) => document.getElementById(id);
const RATINGS = [
  { key: 'medal', icon: '🥇', label: 'Medal', group: 'Medal' },
  { key: 'up', icon: '👍', label: 'Thumbs up', group: 'Thumbs up' },
  { key: 'wave', icon: '〰', label: 'Unsure', group: 'Unsure' },
  { key: 'reject', icon: '✕', label: 'Reject', group: 'Rejected' },
];
const CHIP = { free: 'free', likely: 'likely free', taken: 'taken', unknown: 'not checked' };

let projects = [], current = null, view = null, showRejected = false;
const staged = new Map(); // label -> rating | null

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('aria-') || k.startsWith('data-') || k === 'role') n.setAttribute(k, v);
    else n[k] = v;
  }
  n.append(...kids.filter((k) => k != null));
  return n;
}

async function api(method, path, body) {
  const r = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}
const status = (text, kind = '') => { $('status').textContent = text; $('status').dataset.kind = kind; };

// ---- projects ----
async function loadProjects() {
  projects = await api('GET', '/projects');
  renderProjects();
}
function renderProjects() {
  $('projects').replaceChildren(...projects.map((p) => el('li', {},
    el('button', { type: 'button', class: 'project-link', text: p.name, 'aria-current': p.id === current ? 'page' : 'false', on: { click: () => openProject(p.id) } }))));
}
async function openProject(id) {
  if (staged.size && !confirm('Discard staged ratings?')) return;
  staged.clear();
  current = id;
  localStorage.setItem('dc.project', id);
  show(await api('GET', `/projects/${id}`));
  renderProjects();
  status('');
}

function show(v) {
  view = v;
  $('empty').hidden = true;
  $('project').hidden = false;
  if (document.activeElement !== $('p-name')) $('p-name').value = v.project.name;
  if (document.activeElement !== $('p-desc')) $('p-desc').value = v.project.description;
  for (const cb of document.querySelectorAll('input[name=tld]')) cb.checked = v.project.tlds.includes(cb.value);
  renderRules();
  renderBoard();
}

// ---- rules and suggestions ----
function renderRules() {
  $('rules').replaceChildren(...view.rules.map((r) => {
    const input = el('input', { value: r.text, maxLength: 500, 'aria-label': 'Rule' });
    return el('li', { class: 'row' }, input,
      el('button', { type: 'button', class: 'quiet', text: 'Save', on: { click: () => act(() => api('PUT', `/projects/${current}/rules/${r.id}`, { text: input.value }), 'Rule saved') } }),
      el('button', { type: 'button', class: 'quiet danger', text: 'Delete', 'aria-label': `Delete rule: ${r.text}`, on: { click: () => act(() => api('DELETE', `/projects/${current}/rules/${r.id}`, {})) } }));
  }));
  $('suggestions').hidden = !view.suggestions.length;
  $('suggestion-list').replaceChildren(...view.suggestions.map((s) => el('li', { class: 'suggestion' },
    el('span', { text: s.text }),
    el('button', { type: 'button', text: 'Accept', on: { click: () => act(() => api('POST', `/projects/${current}/suggestions/${s.id}`, { action: 'accept' }), 'Rule added') } }),
    el('button', { type: 'button', class: 'quiet', text: 'Ignore', on: { click: () => act(() => api('POST', `/projects/${current}/suggestions/${s.id}`, { action: 'ignore' })) } }))));
}

async function act(fn, done = '') {
  try { show(await fn()); if (done) status(done); } catch (e) { status(e.message, 'error'); }
}

// ---- board ----
const effective = (n) => (staged.has(n.label) ? staged.get(n.label) : n.rating);

function card(n) {
  const eff = effective(n);
  const chips = el('ul', { class: 'chips', 'aria-label': 'Availability' }, ...Object.entries(n.tlds).map(([t, s]) =>
    el('li', { class: `chip ${s}`, title: `${n.label}.${t}: ${CHIP[s] ?? s}` },
      el('span', { class: 'tld', text: `.${t}` }), el('span', { class: 'chip-state', text: CHIP[s] ?? s }))));
  const rate = el('div', { class: 'rate', role: 'group', 'aria-label': `Rate ${n.label}` }, ...RATINGS.map((r, i) =>
    el('button', { type: 'button', class: `rate-btn ${r.key}`, 'aria-pressed': String(eff === r.key), title: `${r.label} (key ${i + 1})`,
      on: { click: () => stage(n, eff === r.key ? null : r.key) } },
      el('span', { 'aria-hidden': 'true', text: r.icon }), el('span', { class: 'sr', text: r.label }))));
  const extra = el('div', { class: 'card-actions' },
    el('button', { type: 'button', class: 'quiet', text: 'Recheck', on: { click: (e) => recheck(n, e.target) } }),
    n.tlds.bg === 'likely' ? el('button', { type: 'button', class: 'quiet', text: 'Confirm .bg', on: { click: (e) => confirmBg(n, e.target) } }) : null);
  return el('article', { class: `card${staged.has(n.label) ? ' staged' : ''}`, tabIndex: 0, 'data-label': n.label, 'aria-label': n.label,
    on: { keydown: (e) => keyRate(e, n) } },
    el('h3', { class: 'name', text: n.label }), chips, rate, extra);
}

function keyRate(e, n) {
  if (e.target !== e.currentTarget) return;
  const i = '1234'.indexOf(e.key);
  if (i >= 0) stage(n, effective(n) === RATINGS[i].key ? null : RATINGS[i].key);
  else if (e.key === '0') stage(n, null);
}

function renderBoard() {
  const groups = [{ key: null, title: 'Not rated yet' }, ...RATINGS.slice(0, 3).map((r) => ({ key: r.key, title: r.group }))];
  const visible = view.board.filter((n) => n.rating !== 'reject');
  const sections = groups.map((g) => {
    const names = visible.filter((n) => n.rating === g.key);
    if (!names.length) return null;
    return el('section', { class: 'group', 'aria-label': g.title },
      el('h2', { class: 'group-title' }, el('span', { text: g.title }), el('span', { class: 'count', text: String(names.length) })),
      el('div', { class: 'cards' }, ...names.map(card)));
  }).filter(Boolean);
  $('board').replaceChildren(...(sections.length ? sections
    : [el('p', { class: 'board-empty', text: 'No candidates yet. Pick the endings and press Find names.' })]));

  const rejected = view.board.filter((n) => n.rating === 'reject');
  $('toggle-rejected').hidden = !rejected.length;
  $('toggle-rejected').textContent = `${showRejected ? 'Hide' : 'Show'} rejected names (${rejected.length})`;
  $('toggle-rejected').setAttribute('aria-expanded', String(showRejected));
  $('rejected').hidden = !showRejected || !rejected.length;
  $('rejected').replaceChildren(el('div', { class: 'cards' }, ...rejected.map(card)));

  $('commit-bar').hidden = !staged.size;
  $('staged-count').textContent = `${staged.size} ${staged.size === 1 ? 'change' : 'changes'} staged`;
}

function stage(n, rating) {
  if (rating === n.rating) staged.delete(n.label); else staged.set(n.label, rating);
  const focused = document.activeElement?.closest?.('.card')?.dataset.label;
  renderBoard();
  if (focused) document.querySelector(`.card[data-label="${CSS.escape(focused)}"]`)?.focus();
}

async function recheck(n, btn) {
  btn.disabled = true; btn.textContent = 'Checking…';
  await act(() => api('POST', `/projects/${current}/recheck`, { label: n.label }), `Rechecked ${n.label}`);
}
async function confirmBg(n, btn) {
  btn.disabled = true; btn.textContent = 'Asking the .bg registry…';
  try {
    const r = await api('POST', `/projects/${current}/confirm`, { label: n.label });
    show(r);
    status(r.confirm === 'pending' ? 'The .bg registry is limiting queries. Try Confirm again in about 30 minutes.'
      : r.confirm === 'unknown' ? 'The .bg registry did not answer. Try again later.' : `${n.label}.bg is ${r.confirm}.`, r.confirm === 'free' || r.confirm === 'taken' ? '' : 'error');
  } catch (e) { status(e.message, 'error'); renderBoard(); }
}

// ---- events ----
$('new-project').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { id } = await api('POST', '/projects', { name: $('new-name').value, tlds: ['com'] });
    $('new-name').value = '';
    await loadProjects();
    await openProject(id);
    $('p-desc').focus();
  } catch (err) { alert(err.message); }
});
$('p-name').addEventListener('change', () => act(async () => { const v = await api('PUT', `/projects/${current}`, { name: $('p-name').value }); await loadProjects(); return v; }));
$('save-brief').addEventListener('click', () => act(() => api('PUT', `/projects/${current}`, { description: $('p-desc').value }), 'Description saved'));
$('delete-project').addEventListener('click', async () => {
  if (!confirm(`Delete "${view.project.name}" with its rules and ratings? Checked domains stay cached.`)) return;
  await api('DELETE', `/projects/${current}`, {});
  current = null; staged.clear(); localStorage.removeItem('dc.project');
  $('project').hidden = true; $('empty').hidden = false; $('commit-bar').hidden = true;
  await loadProjects();
});
$('add-rule').addEventListener('submit', (e) => {
  e.preventDefault();
  act(async () => { const v = await api('POST', `/projects/${current}/rules`, { text: $('rule-text').value }); $('rule-text').value = ''; return v; });
});
$('request').addEventListener('submit', async (e) => {
  e.preventDefault();
  const tlds = [...document.querySelectorAll('input[name=tld]:checked')].map((c) => c.value);
  if (!tlds.length) return status('Tick at least one ending.', 'error');
  const n = Number($('n').value);
  $('generate').disabled = true;
  const t0 = Date.now();
  const tick = setInterval(() => status(`Asking the models and checking names… ${Math.round((Date.now() - t0) / 1000)} s`), 1000);
  status('Asking the models and checking names…');
  try {
    const r = await api('POST', `/projects/${current}/generate`, { n, tlds });
    clearInterval(tick);
    show(r);
    const { found, rounds, errors } = r.result;
    let msg = found >= n ? `Found ${found} free ${found === 1 ? 'name' : 'names'} in ${rounds} ${rounds === 1 ? 'round' : 'rounds'}.`
      : `Found ${found} of ${n} after ${rounds} ${rounds === 1 ? 'round' : 'rounds'}. Loosen the rules or ask again.`;
    if (errors.length) msg += ` Some models did not answer: ${errors.join('; ')}`;
    status(msg, found >= n ? '' : 'warn');
  } catch (err) { clearInterval(tick); status(err.message, 'error'); }
  finally { $('generate').disabled = false; }
});
$('toggle-rejected').addEventListener('click', () => { showRejected = !showRejected; renderBoard(); });
// Standalone HTML of saved liked names (medal, then thumbs up). Built with el(), so names are escaped.
$('export').addEventListener('click', () => {
  const liked = ['medal', 'up'].flatMap((k) => view.board.filter((n) => n.rating === k));
  if (!liked.length) return status('No liked names to export yet. Rate and commit first.', 'warn');
  const icon = { medal: '🥇', up: '👍' };
  const rows = liked.map((n) => el('li', {}, el('span', { class: 'r', text: icon[n.rating] }), el('b', { text: n.label }),
    ...Object.entries(n.tlds).map(([t, s]) => el('span', { class: `t ${s}`, text: `.${t} ${CHIP[s] ?? s}` }))));
  const body = el('body', {}, el('h1', { text: view.project.name }), el('p', { text: view.project.description }), el('ol', {}, ...rows));
  const css = 'body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#16202E}ol{list-style:none;padding:0}li{display:flex;gap:.6rem;align-items:baseline;padding:.4rem 0;border-bottom:1px solid #C9D1DA;flex-wrap:wrap}b{font-size:1.4rem;min-width:12rem}.t{font-size:.8rem;border:1px solid #9AA4B0;border-radius:99px;padding:0 .5rem;color:#6B7684}.t.free{background:#1F7A57;border-color:#1F7A57;color:#fff}.t.likely{border:1px dashed #1F7A57;color:#1F7A57}.t.taken{text-decoration:line-through}';
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>${el('i', { text: view.project.name }).innerHTML}: liked names</title><style>${css}</style>${body.outerHTML}</html>`;
  const a = el('a', { href: URL.createObjectURL(new Blob([html], { type: 'text/html' })), download: `${view.project.name.replace(/[^\w-]+/g, '-')}-liked.html` });
  a.click();
  URL.revokeObjectURL(a.href);
});
$('discard').addEventListener('click', () => { staged.clear(); renderBoard(); });
$('commit').addEventListener('click', async () => {
  const items = [...staged].map(([label, rating]) => ({ label, rating }));
  $('commit').disabled = true;
  status(`Saving ${items.length} ${items.length === 1 ? 'rating' : 'ratings'} and asking for rule suggestions…`);
  try {
    const r = await api('POST', `/projects/${current}/ratings`, { items });
    staged.clear(); // cleared only after the save is confirmed
    show(r);
    status(r.suggestError ? `Saved ${r.saved} ratings. Rule suggestions failed: ${r.suggestError}` : `Saved ${r.saved} ratings.`, r.suggestError ? 'warn' : '');
  } catch (err) { status(`Nothing saved: ${err.message}`, 'error'); }
  finally { $('commit').disabled = false; }
});
window.addEventListener('beforeunload', (e) => { if (staged.size) e.preventDefault(); });

await loadProjects();
const last = Number(localStorage.getItem('dc.project'));
if (projects.some((p) => p.id === last)) await openProject(last);
