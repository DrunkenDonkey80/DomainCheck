// Name ideas and rule suggestions via `pi --print`, one child per model (D-02, D-03, Q-07).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AGENT = join(homedir(), '.pi', 'agent');
export const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function plan3Settings() {
  const s = JSON.parse(readFileSync(process.env.PI_SETTINGS || join(AGENT, 'settings.json'), 'utf8'));
  return s.workOrchestrator?.plan3 ?? {};
}
export function loadModels() {
  const models = plan3Settings().models ?? [];
  if (!models.length) throw new Error('workOrchestrator.plan3.models is empty');
  return models;
}
export function loadPlanningModel() {
  const p = plan3Settings();
  if (!p.planningModel) throw new Error('workOrchestrator.plan3.planningModel is not set');
  return { model: p.planningModel, thinking: p.models?.find((m) => m.model === p.planningModel)?.thinking };
}

// Kill the launcher and the real pi it starts with spawnSync (review finding 4).
function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}

export function runPi({ model, thinking }, prompt, { timeoutMs = 90_000, launcher = process.env.PI_LAUNCHER || join(AGENT, 'bin', 'pi-launcher.js') } = {}) {
  const args = [launcher, '--print', '--model', model, ...(thinking ? ['--thinking', thinking] : []),
    '--no-tools', '--no-session', '--no-extensions', '--no-skills', '--no-context-files'];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { windowsHide: true, detached: process.platform !== 'win32' });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${model}: timeout after ${timeoutMs} ms`));
      else if (code !== 0) reject(new Error(`${model}: exit ${code} ${err.trim().slice(0, 200)}`));
      else resolve(out);
    });
    child.stdin.end(prompt);
  });
}

function jsonArray(stdout) {
  try { const v = JSON.parse(stdout.trim()); if (Array.isArray(v)) return v; } catch {}
  const m = stdout.match(/\[[\s\S]*?\]/); // fallback: first [...] in the text
  if (!m) return [];
  try { const v = JSON.parse(m[0]); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function parseLabels(stdout) {
  return [...new Set(jsonArray(stdout)
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim().toLowerCase().replace(/\.(com|bg|eu)$/, ''))
    .filter((x) => LABEL_RE.test(x)))];
}
export const parseSuggestions = (stdout) =>
  jsonArray(stdout).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 300)).slice(0, 8);

const list = (xs) => (xs.length ? xs.join(', ') : '(none)');
const byRating = (rated, r) => rated.filter((n) => n.rating === r).map((n) => n.label);

// ctx: { project: {name, description}, rules: [{text}], rated: [{label, rating}], tried: [label] }
export function buildPrompt(ctx, count) {
  const { project, rules, rated, tried } = ctx;
  return `You invent domain names (the label only, no TLD) for this project.
Project: ${project.name}
Description: ${project.description || '(none)'}
Rules:
${rules.length ? rules.map((r) => `- ${r.text}`).join('\n') : '- (none)'}
Loved (medal): ${list(byRating(rated, 'medal'))}
Liked: ${list(byRating(rated, 'up'))}
Unsure: ${list(byRating(rated, 'wave'))}
Rejected (avoid this direction): ${list(byRating(rated, 'reject'))}
Already tried, never repeat: ${list(tried.slice(-300))}

Give ${count} new, varied names that follow the rules and the liked direction.
Only lowercase a-z, 0-9 and hyphen, 3 to 20 characters, no hyphen at the start or end.
Reply with ONLY a JSON array of lowercase labels without TLD.`;
}

export function buildSuggestPrompt(ctx, committed) {
  const { project, rules, rated } = ctx;
  return `You help refine naming rules for a domain-name search.
Project: ${project.name}
Description: ${project.description || '(none)'}
Current rules:
${rules.length ? rules.map((r) => `- ${r.text}`).join('\n') : '- (none)'}
Just rated: ${committed.map((c) => `${c.label}=${c.rating ?? 'cleared'}`).join(', ')}
All ratings so far: medal ${list(byRating(rated, 'medal'))}; liked ${list(byRating(rated, 'up'))}; unsure ${list(byRating(rated, 'wave'))}; rejected ${list(byRating(rated, 'reject'))}

Suggest up to 5 short rule changes (new rules, or rewrites of a current rule) that capture what the user likes and dislikes.
Reply with ONLY a JSON array of strings, each one rule.`;
}

// All models in parallel; a failing model is skipped (plan: "A model that fails ... is skipped").
export async function generateIdeas(ctx, perModel, { models = loadModels(), runner = runPi } = {}) {
  const prompt = buildPrompt(ctx, perModel);
  const res = await Promise.allSettled(models.map((m) => runner(m, prompt)));
  const errors = res.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  const labels = [...new Set(res.flatMap((r) => (r.status === 'fulfilled' ? parseLabels(r.value) : [])))];
  return { labels, errors };
}

export async function suggestRules(ctx, committed, { model = loadPlanningModel(), runner = runPi } = {}) {
  return parseSuggestions(await runner(model, buildSuggestPrompt(ctx, committed)));
}
