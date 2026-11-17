// The forge's in-memory store: repos, refs, objects, issues, pull requests, labels, comments.
// Everything is deterministic: ids come from counters, global ids are base64url of a typed key,
// and every timestamp is MAKEFUN_TRIAL_NOW (or a fixed fallback). No wall clock, no randomness.

import {
  ZERO_OID,
  buildCommitData,
  buildTreeFromFlat,
  flattenTree,
  hashObject,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type ObjectWriter,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

/** The trial's frozen "now": seconds since epoch and the ISO string, from MAKEFUN_TRIAL_NOW. */
let cachedTrialNow: { epoch: number; iso: string } | null = null;
export function trialNow(): { epoch: number; iso: string } {
  if (cachedTrialNow !== null) return cachedTrialNow;
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const ms = raw === '' ? Number.NaN : Number(raw);
  const epoch = Number.isFinite(ms) ? Math.floor(ms / 1000) : 1735689600;
  // The env value is fixed for the life of the process, so the answer never changes:
  // compute it once instead of allocating a Date and formatting ISO per call.
  cachedTrialNow = { epoch, iso: new Date(epoch * 1000).toISOString() };
  return cachedTrialNow;
}

/** Opaque, stable global id: base64url of a typed key (never the plain databaseId/number). */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(gid: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(gid, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export interface Comment {
  id: number;
  gid: string;
  body: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  gid: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
  createdAt: string;
}

export interface Pull {
  number: number;
  gid: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
  createdAt: string;
}

export interface Label {
  name: string;
  color: string;
}

export class Repo implements ObjectWriter {
  owner: string;
  name: string;
  databaseId: number;
  gid: string;
  description: string;
  private: boolean;
  defaultBranch = DEFAULT_BRANCH;
  refs = new Map<string, string>();
  objects = new Map<string, GitObject>();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  labels = new Map<string, Label>();
  issueSeq = 0;
  pullSeq = 0;
  commentSeq = 0;
  createdAt: string;
  /**
   * Memoized git smart-HTTP responses (fetch / ls-refs / info-refs), keyed by the
   * request's parsed arguments. A fetch answer is a pure function of the repo's refs
   * and objects plus those arguments, and git objects are immutable, so a cached
   * answer stays valid until a ref moves or an object is added — both clear this
   * map (see put() and the refs.set sites). Identical concurrent clones then share
   * one computed pack instead of each rebuilding it.
   */
  gitCache = new Map<string, Buffer>();

  constructor(owner: string, name: string, databaseId: number, description: string, isPrivate: boolean, createdAt: string) {
    this.owner = owner;
    this.name = name;
    this.databaseId = databaseId;
    this.gid = globalId('Repository', `${owner}/${name}`);
    this.description = description;
    this.private = isPrivate;
    this.createdAt = createdAt;
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  put(type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
      // A new object can change a later fetch answer (a want that was unresolvable
      // may now resolve), so any memoized git response is stale.
      this.gitCache.clear();
    }
    return oid;
  }

  /** A ref moved (or was created/deleted): any memoized git response is stale. */
  touchGit(): void {
    this.gitCache.clear();
  }

  get path(): string {
    return `${this.owner}/${this.name}`;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  defaultRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  tip(refName: string): string | undefined {
    return this.refs.get(refName);
  }
}

export class ForgeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  databaseIdSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    if (this.repos.has(this.key(owner, name))) {
      throw new ForgeError(422, `Repository ${owner}/${name} already exists`);
    }
    this.databaseIdSeq += 1;
    const repo = new Repo(owner, name, this.databaseIdSeq, description, isPrivate, trialNow().iso);
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listReposForOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.databaseId - b.databaseId);
    return out;
  }

  repoByGlobalId(gid: string): Repo | undefined {
    const decoded = decodeGlobalId(gid);
    if (decoded === null || decoded.kind !== 'Repository') return undefined;
    const slash = decoded.key.indexOf('/');
    if (slash < 0) return undefined;
    return this.getRepo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1));
  }
}

// ---------------------------------------------------------------------------------------------
// commits and contents

export interface CommitFileResult {
  commitSha: string;
  contentSha: string;
  created: boolean;
}

/**
 * Write one file on a branch (creating the branch from the default tip when it does not exist,
 * and the first commit when the repo is unborn). `expectedSha` is the stale-sha guard for
 * updates: a mismatch is a 409. Returns the new commit sha and the blob sha.
 */
export function commitFile(
  repo: Repo,
  branch: string | undefined,
  path: string,
  content: Buffer,
  message: string,
): CommitFileResult {
  const now = trialNow();
  const refName = `refs/heads/${branch ?? repo.defaultBranch}`;
  let tip = repo.refs.get(refName);
  if (tip === undefined && refName !== repo.defaultRef()) {
    // A named branch that does not exist starts from the default branch's tip.
    tip = repo.refs.get(repo.defaultRef());
  }
  const blobOid = repo.put('blob', content);
  let flat = new Map<string, { mode: string; oid: string }>();
  let created = true;
  const parents: string[] = [];
  if (tip !== undefined && tip !== ZERO_OID) {
    const commit = repo.get(tip);
    if (commit === undefined || commit.type !== 'commit') throw new ForgeError(422, `branch ${refName} points at a missing object`);
    flat = flattenTree(repo, parseCommit(commit.data).tree);
    parents.push(tip);
    created = !flat.has(path);
  }
  flat.set(path, { mode: '100644', oid: blobOid });
  const treeOid = buildTreeFromFlat(repo, flat);
  const commitData = buildCommitData(treeOid, parents, message, now.epoch, VIEWER_LOGIN, VIEWER_EMAIL);
  const commitSha = repo.put('commit', commitData);
  repo.refs.set(refName, commitSha);
  repo.touchGit();
  return { commitSha, contentSha: blobOid, created };
}

/** Update one file, enforcing the stale-sha guard (409 when `expectedSha` does not match). */
export function updateFile(
  repo: Repo,
  branch: string | undefined,
  path: string,
  content: Buffer,
  message: string,
  expectedSha: string | undefined,
): CommitFileResult {
  const refName = `refs/heads/${branch ?? repo.defaultBranch}`;
  const tip = repo.refs.get(refName);
  if (tip === undefined) throw new ForgeError(404, `branch ${branch ?? repo.defaultBranch} does not exist`);
  const commit = repo.get(tip);
  if (commit === undefined || commit.type !== 'commit') throw new ForgeError(422, 'branch tip is not a commit');
  const flat = flattenTree(repo, parseCommit(commit.data).tree);
  const current = flat.get(path);
  if (current === undefined) {
    // No existing file: this is a create on an existing branch.
    return commitFile(repo, branch, path, content, message);
  }
  if (expectedSha !== undefined && expectedSha !== current.oid) {
    throw new ForgeError(409, `sha ${expectedSha} does not match the current blob ${current.oid}`);
  }
  const result = commitFile(repo, branch, path, content, message);
  return { ...result, created: false };
}

/** Delete one file (409 when `expectedSha` does not match the current blob). */
export function deleteFile(
  repo: Repo,
  branch: string | undefined,
  path: string,
  message: string,
  expectedSha: string | undefined,
): { commitSha: string } {
  const now = trialNow();
  const refName = `refs/heads/${branch ?? repo.defaultBranch}`;
  const tip = repo.refs.get(refName);
  if (tip === undefined) throw new ForgeError(404, `branch ${branch ?? repo.defaultBranch} does not exist`);
  const commit = repo.get(tip);
  if (commit === undefined || commit.type !== 'commit') throw new ForgeError(422, 'branch tip is not a commit');
  const flat = flattenTree(repo, parseCommit(commit.data).tree);
  const current = flat.get(path);
  if (current === undefined) throw new ForgeError(404, `file ${path} does not exist`);
  if (expectedSha !== undefined && expectedSha !== current.oid) {
    throw new ForgeError(409, `sha ${expectedSha} does not match the current blob ${current.oid}`);
  }
  flat.delete(path);
  const treeOid = buildTreeFromFlat(repo, flat);
  const commitData = buildCommitData(treeOid, [tip], message, now.epoch, VIEWER_LOGIN, VIEWER_EMAIL);
  const commitSha = repo.put('commit', commitData);
  repo.refs.set(refName, commitSha);
  repo.touchGit();
  return { commitSha };
}

/** Resolve a ref argument (branch name, full ref, or commit oid) to a commit oid. */
export function resolveRef(repo: Repo, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '') return repo.refs.get(repo.defaultRef());
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const branchRef = `refs/heads/${ref}`;
  if (repo.refs.has(branchRef)) return repo.refs.get(branchRef);
  const obj = repo.get(ref);
  if (obj === undefined) return undefined;
  if (obj.type === 'commit') return ref;
  if (obj.type === 'tag') return parseTag(obj.data).object;
  return undefined;
}

/** List commits reachable from a tip, newest first (parent-chain walk). */
export function listCommits(repo: Repo, tip: string | undefined): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  if (tip === undefined || tip === ZERO_OID) return out;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    out.push({ sha: oid, message: info.message });
    for (const parent of info.parents) stack.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// issues

export function createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): Issue {
  for (const label of labels) {
    if (!repo.labels.has(label)) throw new ForgeError(422, `label ${label} does not exist`);
  }
  repo.issueSeq += 1;
  const number = repo.issueSeq;
  const now = trialNow().iso;
  const issue: Issue = {
    number,
    gid: globalId('Issue', `${repo.path}#${number}`),
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: number,
    createdAt: now,
  };
  repo.issues.push(issue);
  return issue;
}

export function getIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issues.find((issue) => issue.number === number);
}

export function listIssues(
  repo: Repo,
  state: string | undefined,
  sort: string | undefined,
  direction: string | undefined,
): Issue[] {
  let list = repo.issues;
  const wanted = state ?? 'open';
  if (wanted !== 'all') list = list.filter((issue) => issue.state === wanted);
  const dir = direction ?? 'desc';
  const sorted = [...list];
  if ((sort ?? 'created') === 'created') {
    sorted.sort((a, b) => (dir === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  return sorted;
}

// ---------------------------------------------------------------------------------------------
// pull requests

export function createPull(
  repo: Repo,
  head: string,
  base: string,
  title: string,
  body: string,
): Pull {
  const headTip = repo.refs.get(`refs/heads/${head}`);
  if (headTip === undefined) throw new ForgeError(422, `head branch ${head} does not exist`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (baseTip === undefined) throw new ForgeError(422, `base branch ${base} does not exist`);
  const existing = repo.pulls.find((pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open');
  if (existing !== undefined) throw new ForgeError(422, `a pull request from ${head} to ${base} already exists`);
  repo.pullSeq += 1;
  const number = repo.pullSeq;
  const now = trialNow().iso;
  const pull: Pull = {
    number,
    gid: globalId('PullRequest', `${repo.path}#${number}`),
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha: headTip,
    baseSha: baseTip,
    seq: number,
    createdAt: now,
  };
  repo.pulls.push(pull);
  return pull;
}

export function getPull(repo: Repo, number: number): Pull | undefined {
  return repo.pulls.find((pull) => pull.number === number);
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line additions/deletions between two texts (LCS; files here are small). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  const lcs = dp[0]![0] as number;
  return { additions: n - lcs, deletions: m - lcs };
}

/** The file diff between a pull request's base commit and its head commit. */
export function pullFiles(repo: Repo, pull: Pull): PullFile[] {
  const baseCommit = repo.get(pull.baseSha);
  const headCommit = repo.get(pull.headSha);
  if (baseCommit === undefined || headCommit === undefined) return [];
  const baseFlat = flattenTree(repo, parseCommit(baseCommit.data).tree);
  const headFlat = flattenTree(repo, parseCommit(headCommit.data).tree);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  const out: PullFile[] = [];
  for (const path of paths) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (b !== undefined && h === undefined) {
      const oldText = repo.get(b.oid)?.data.toString('utf8') ?? '';
      const deletions = splitLines(oldText).length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b === undefined && h !== undefined) {
      const newText = repo.get(h.oid)?.data.toString('utf8') ?? '';
      const additions = splitLines(newText).length;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const oldText = repo.get(b.oid)?.data.toString('utf8') ?? '';
      const newText = repo.get(h.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  return out;
}

/**
 * Squash-merge a pull request onto its base branch with a three-way tree merge:
 * a path the PR changed while the base also changed (to something else) is a conflict (405).
 * On success the base ref moves to the new merge commit and the PR closes as merged.
 */
export function mergePull(repo: Repo, pull: Pull): { sha: string } {
  if (pull.state !== 'open') throw new ForgeError(405, `pull request ${pull.number} is already ${pull.state}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) throw new ForgeError(422, `base branch ${pull.baseRef} does not exist`);
  const baseCommit = repo.get(pull.baseSha);
  const headCommit = repo.get(pull.headSha);
  const currentCommit = repo.get(baseTip);
  if (baseCommit === undefined || headCommit === undefined || currentCommit === undefined) {
    throw new ForgeError(422, 'a merge endpoint is missing');
  }
  const baseFlat = flattenTree(repo, parseCommit(baseCommit.data).tree);
  const headFlat = flattenTree(repo, parseCommit(headCommit.data).tree);
  const currentFlat = flattenTree(repo, parseCommit(currentCommit.data).tree);
  const merged = new Map<string, { mode: string; oid: string }>();
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...currentFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    const c = currentFlat.get(path);
    const headChanged = (h?.oid ?? null) !== (b?.oid ?? null);
    const baseChanged = (c?.oid ?? null) !== (b?.oid ?? null);
    if (headChanged && baseChanged && (h?.oid ?? null) !== (c?.oid ?? null)) {
      throw new ForgeError(405, `merge conflict on ${path}`);
    }
    const chosen = headChanged ? h : c;
    if (chosen !== undefined) merged.set(path, chosen);
  }
  const now = trialNow();
  const treeOid = buildTreeFromFlat(repo, merged);
  const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
  const commitData = buildCommitData(treeOid, [baseTip], message, now.epoch, VIEWER_LOGIN, VIEWER_EMAIL);
  const mergeSha = repo.put('commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  repo.touchGit();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = now.iso;
  pull.mergeCommitSha = mergeSha;
  return { sha: mergeSha };
}

/** A pull request is mergeable when its head is a descendant of (or equal to) its base tip. */
export function pullMergeable(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return false;
  return isAncestor(repo, pull.baseSha, pull.headSha) || pull.headSha === baseTip || isAncestor(repo, baseTip, pull.headSha);
}

// ---------------------------------------------------------------------------------------------
// JSON views (REST)

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.gid,
    databaseId: repo.databaseId,
    node_id: repo.gid,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    has_issues: true,
    has_pull_requests: true,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.gid,
    node_id: issue.gid,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.gid,
    node_id: pull.gid,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
  };
}

export function parseTreeEntries(repo: Repo, treeOid: string): Array<{ mode: string; name: string; oid: string }> {
  const obj = repo.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTree(obj.data);
}
