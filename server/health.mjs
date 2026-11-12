// Branch health: pure helpers (tested), fed by server/index.mjs with git output.
// Levels: 'ok' | 'warn' | 'bad' | 'na' (not measurable). Nothing here invents
// data: every check names the git fact it is derived from.

const DAY = 86400000;

/**
 * Parses `git merge-tree --write-tree --name-only <base> <branch>`.
 * Exit 0: clean merge. Exit 1: conflicts, stdout = tree OID, conflicted file names, blank line, messages.
 * Any other exit (old git, unknown ref): null = unknown.
 */
/**
 * `git worktree list --porcelain` -> [{ path, head, branch, detached, bare, locked, prunable }].
 * Paths use forward slashes.
 */
export function parseWorktrees(out) {
  const list = [];
  let cur = null;
  for (const line of String(out || '').split(/\r?\n/)) {
    if (!line.trim()) { cur = null; continue; }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp), val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'worktree') { cur = { path: val.split('\\').join('/'), head: '', branch: '', detached: false, bare: false, locked: false, prunable: false }; list.push(cur); continue; }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = val.slice(0, 12);
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
    else if (key in cur) cur[key] = true;
  }
  return list;
}

export function parseMergeTree(code, out) {
  if (code === 0) return [];
  if (code !== 1) return null;
  const lines = String(out || '').split('\n');
  const files = [];
  for (const line of lines.slice(1)) { if (!line.trim()) break; files.push(line.trim()); }
  return files;
}

/** Builds the health record for one branch. `b` holds the facts, all optional except name. */
export function branchHealth(b, now = Date.now()) {
  const checks = [];
  const base = b.base || '';
  const isBase = b.name === base;

  if (!isBase && base) {
    if (b.conflictFiles === null || b.conflictFiles === undefined) checks.push({ id: 'conflicts', level: 'na', label: `Merge into ${base}`, detail: 'not measurable (git merge-tree unavailable)' });
    else if (b.conflictFiles.length) checks.push({ id: 'conflicts', level: 'bad', label: `Merge into ${base}`, detail: `${b.conflictFiles.length} conflicting file${b.conflictFiles.length > 1 ? 's' : ''}`, files: b.conflictFiles.slice(0, 20) });
    else checks.push({ id: 'conflicts', level: 'ok', label: `Merge into ${base}`, detail: 'merges without conflict' });

    // A merged branch has nothing left to bring: being behind the base is normal, not a problem.
    if (b.merged) checks.push({ id: 'merged', level: 'ok', label: 'Already merged', detail: `every commit is in ${base} (git branch --merged): safe to delete` });
    else if (b.behindBase == null) checks.push({ id: 'base', level: 'na', label: `Behind ${base}`, detail: 'unknown' });
    else if (b.behindBase === 0) checks.push({ id: 'base', level: 'ok', label: `Behind ${base}`, detail: `up to date · ${b.aheadBase || 0} commit${b.aheadBase === 1 ? '' : 's'} ahead` });
    else checks.push({ id: 'base', level: 'warn', label: `Behind ${base}`, detail: `${b.behindBase} commit${b.behindBase > 1 ? 's' : ''} behind · ${b.aheadBase || 0} ahead: merge or rebase ${base} first` });
  }

  if (b.hasUpstream === false) checks.push({ id: 'upstream', level: 'na', label: 'Remote tracking', detail: 'no remote branch tracked' });
  else if (b.behind) checks.push({ id: 'upstream', level: 'warn', label: 'Remote tracking', detail: `${b.behind} commit${b.behind > 1 ? 's' : ''} behind the remote${b.ahead ? ` · ${b.ahead} to push` : ''}` });
  else if (b.ahead) checks.push({ id: 'upstream', level: 'warn', label: 'Remote tracking', detail: `${b.ahead} commit${b.ahead > 1 ? 's' : ''} to push` });
  else if (b.hasUpstream) checks.push({ id: 'upstream', level: 'ok', label: 'Remote tracking', detail: 'in sync with the remote' });

  // Age only matters for unfinished work left aside: not for a merged branch,
  // the base, or the branch checked out right now.
  if (b.date && !b.merged) {
    const days = Math.floor((now - b.date) / DAY);
    const stale = days > 30 && !b.current && b.name !== base && (b.aheadBase ?? 1) > 0;
    checks.push({ id: 'age', level: stale ? 'warn' : 'ok', label: 'Last commit', detail: `${days === 0 ? 'today' : `${days} day${days > 1 ? 's' : ''} ago`}${stale ? ': unmerged work left aside' : ''}` });
  }

  if (b.current) {
    if (b.worktreeConflicts?.length) checks.push({ id: 'worktree', level: 'bad', label: 'Working tree', detail: `${b.worktreeConflicts.length} unresolved conflict${b.worktreeConflicts.length > 1 ? 's' : ''}`, files: b.worktreeConflicts.slice(0, 20) });
    else if (b.changes) checks.push({ id: 'worktree', level: b.changes >= 25 ? 'warn' : 'ok', label: 'Working tree', detail: `${b.changes} uncommitted file${b.changes > 1 ? 's' : ''}` });
    else checks.push({ id: 'worktree', level: 'ok', label: 'Working tree', detail: 'clean' });
    if (b.test) checks.push({ id: 'tests', level: b.test.ok ? 'ok' : 'bad', label: 'Last tests', detail: `${b.test.ok ? 'passed' : 'failed'} · ${b.test.command || ''}`.trim() });
    if (b.build) checks.push({ id: 'build', level: b.build.ok ? 'ok' : 'bad', label: 'Last build', detail: `${b.build.ok ? 'passed' : 'failed'} · ${b.build.command || ''}`.trim() });
  }

  const rank = { bad: 3, warn: 2, ok: 1, na: 0 };
  const level = checks.reduce((m, c) => rank[c.level] > rank[m] ? c.level : m, checks.some(c => c.level === 'ok') ? 'ok' : 'na');
  const problems = checks.filter(c => c.level === 'bad').length, warnings = checks.filter(c => c.level === 'warn').length;
  const summary = level === 'bad' ? `${problems} problem${problems > 1 ? 's' : ''}` : level === 'warn' ? `${warnings} thing${warnings > 1 ? 's' : ''} to watch` : level === 'ok' ? 'healthy' : 'not measured';
  return { level, summary, base, checks };
}
