// Round loop (D-04, Q-04, Q-06): ask every model for 2×N ideas, up to 4 rounds, stop once N names are free.
import { generateIdeas } from './ideas.mjs';

const FREEISH = new Set(['free', 'likely']); // A-03: likely-free .bg counts

export async function generate(db, pid, { n, tlds }, { checker, ideas = generateIdeas, maxRounds = 4 } = {}) {
  const project = db.getProject(pid);
  if (!project) throw new Error('no such project');
  db.updateProject(pid, { tlds }); // R1: default for next time
  const found = [], errors = [];
  let rounds = 0;
  for (; rounds < maxRounds && found.length < n; rounds++) {
    const ctx = { project, rules: db.listRules(pid), rated: db.ratedNames(pid), tried: [...db.triedLabels(pid)] };
    const res = await ideas(ctx, 2 * n);
    errors.push(...res.errors);
    if (!res.labels.length && res.errors.length) { rounds++; break; } // every model failed
    const fresh = db.addTried(pid, res.labels, rounds + 1);
    const domains = fresh.flatMap((l) => tlds.map((t) => `${l}.${t}`));
    const cached = db.getAvailability(domains); // Q-02: cached results are not re-checked here
    const checked = await checker.checkDomains(domains.filter((d) => !cached.has(d)));
    db.setAvailability(checked);
    const status = (d) => checked.get(d) ?? cached.get(d);
    const winners = fresh.filter((l) => tlds.some((t) => FREEISH.has(status(`${l}.${t}`))));
    db.markCandidates(pid, winners, tlds); // Q-06: all of them, even past N
    found.push(...winners);
  }
  return { n, found: found.length, labels: found, rounds, errors: [...new Set(errors)] };
}
