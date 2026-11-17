// The forge's HTTP server: git smart HTTP, REST v3, GraphQL and MCP over one shared,
// deterministic, in-memory store. Every reply is JSON (never HTML) except the git endpoints,
// which speak pkt-lines and packfiles; every reply carries X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ZERO_OID,
  delimPkt,
  flattenTree,
  flushPkt,
  objectsForCommits,
  parseCommit,
  parsePktLines,
  parseTag,
  parseTree,
  pktLine,
  readPack,
  sidebandChunks,
  walkCommits,
  writePack,
  type GitObject,
} from './git.ts';
import {
  commitFile,
  createIssue as storeCreateIssue,
  createPull as storeCreatePull,
  deleteFile,
  ForgeError,
  getIssue,
  getPull,
  issueJson,
  listCommits,
  listIssues,
  mergePull,
  parseTreeEntries,
  pullFiles,
  pullJson,
  repoJson,
  resolveRef,
  Store,
  trialNow,
  updateFile,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  type Repo,
} from './store.ts';
import { executeGraphQLBody } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const store = new Store();
let requestCounter = 0;

/** The token the env injects, read once: it is fixed for the life of the process. */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The token the env injects; when unset (local runs) any non-empty Bearer token is accepted. */
function expectedToken(): string {
  return EXPECTED_TOKEN;
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  // The old regex /^Bearer\s+(.+)$/ allowed any run of whitespace after Bearer and
  // kept the rest verbatim; startsWith + trimStart is the same match, without a
  // regex compile-and-run per request.
  const token = header.slice(7).trimStart();
  return token === '' ? null : token;
}

function isAuthed(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  const expected = expectedToken();
  return expected === '' || token === expected;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  requestCounter += 1;
  // One Buffer.from gives both the bytes and their length; Buffer.byteLength would
  // re-scan the whole string after stringify already produced it.
  const buf = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': `req-${requestCounter.toString(16)}`,
    ...headers,
  });
  res.end(buf);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  requestCounter += 1;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `req-${requestCounter.toString(16)}`,
  });
  res.end(body);
}

function sendNoContent(res: ServerResponse, status: number): void {
  requestCounter += 1;
  res.writeHead(status, { 'x-github-request-id': `req-${requestCounter.toString(16)}` });
  res.end();
}

function errJson(status: number, message: string): { status: number; body: { message: string } } {
  return { status, body: { message } };
}

/** Read the request body fully (or an empty buffer for bodiless requests). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return {};
  return JSON.parse(body.toString('utf8')) as unknown;
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The shared empty query set for requests with no '?': constructing a
 * URLSearchParams per request is pure allocation when nothing reads it, and no
 * caller ever mutates the object it gets back (linkHeader copies it first).
 */
const EMPTY_QUERY = new URLSearchParams('');
function queryOf(req: IncomingMessage): URLSearchParams {
  const url = req.url ?? '/';
  const index = url.indexOf('?');
  return index < 0 ? EMPTY_QUERY : new URLSearchParams(url.slice(index + 1));
}

function pathOf(req: IncomingMessage): string {
  const url = req.url ?? '/';
  const index = url.indexOf('?');
  const raw = index < 0 ? url : url.slice(0, index);
  // decodeURIComponent is a no-op for paths with no '%' — and every bench/git path
  // is plain ASCII — so only pay for it when an escape is actually present.
  if (raw.indexOf('%') < 0) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Split a path into its '/'-separated segments (no empty segments). */
function segments(path: string): string[] {
  return path.split('/').filter((part) => part !== '');
}

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

// ---------------------------------------------------------------------------------------------
// REST v3

function restNotFound(message = 'Not Found'): { status: number; body: { message: string } } {
  return errJson(404, message);
}

/** The repo a REST call addresses, or the 404 to answer with (a foreign owner is a 404, never a 403). */
function restRepo(owner: string, name: string): Repo | { status: number; body: { message: string } } {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return restNotFound('Not Found');
  return repo;
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; hasNext: boolean; pageNumber: number; perPage: number } {
  const perPage = Math.min(100, intParam(query, 'per_page', 30));
  const pageNumber = intParam(query, 'page', 1);
  const start = (pageNumber - 1) * perPage;
  const page = items.slice(start, start + perPage);
  return { page, hasNext: start + page.length < items.length, pageNumber, perPage };
}

function linkHeader(req: IncomingMessage, path: string, query: URLSearchParams, pageNumber: number, perPage: number): Record<string, string> {
  const next = new URLSearchParams(query);
  next.set('page', String(pageNumber + 1));
  next.set('per_page', String(perPage));
  const host = req.headers.host ?? 'localhost';
  return { link: `<http://${host}${path}?${next.toString()}>; rel="next"` };
}

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, segs: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  // segs[0..1] are 'api','v3' (split once by dispatch, not once per layer).
  const rest = segs.slice(2);

  // GET /api/v3/ — the API root, with the token's scopes.
  if (rest.length === 0) {
    if (method !== 'GET') return sendJson(res, 404, { message: 'Not Found' });
    return sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return sendJson(res, 404, { message: 'Not Found' });
    return sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return sendJson(res, 404, { message: 'Not Found' });
    return sendJson(res, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: Buffer.from(`User:${VIEWER_LOGIN}`, 'utf8').toString('base64url'),
      type: 'User',
      email: VIEWER_EMAIL,
      html_url: `https://github.com/${VIEWER_LOGIN}`,
    });
  }

  // /api/v3/user/repos — list (paginated) and create.
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.listReposForOwner(VIEWER_LOGIN);
      const { page, hasNext, pageNumber, perPage } = paginate(repos, query);
      const headers = hasNext ? linkHeader(req, path, query, pageNumber, perPage) : {};
      return sendJson(res, 200, page.map((repo) => repoJson(repo)), headers);
    }
    if (method === 'POST') {
      let body: unknown;
      try {
        body = parseJsonBody(await readBody(req));
      } catch {
        return sendJson(res, 400, { message: 'Malformed JSON body' });
      }
      const record = toRecord(body);
      const name = typeof record.name === 'string' ? record.name : '';
      if (name === '' || name.includes('/')) return sendJson(res, 422, { message: 'Repository name is invalid' });
      try {
        const repo = store.createRepo(
          VIEWER_LOGIN,
          name,
          typeof record.description === 'string' ? record.description : '',
          record.private === true,
        );
        return sendJson(res, 201, repoJson(repo));
      } catch (err) {
        if (err instanceof ForgeError) return sendJson(res, err.status, { message: err.message });
        throw err;
      }
    }
    return sendJson(res, 404, { message: 'Not Found' });
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    const repoOrError = restRepo(owner, name);
    if ('status' in repoOrError) return sendJson(res, repoOrError.status, repoOrError.body);
    const repo = repoOrError;
    const tail = rest.slice(3);
    return handleRepoRest(req, res, repo, tail, method, query, path);
  }

  return sendJson(res, 404, { message: 'Not Found' });
}

async function handleRepoRest(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
  method: string,
  query: URLSearchParams,
  path: string,
): Promise<void> {
  // The repo itself: GET / PATCH / DELETE.
  if (tail.length === 0) {
    if (method === 'GET') return sendJson(res, 200, repoJson(repo));
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return sendNoContent(res, 204);
    }
    if (method === 'PATCH') {
      let body: unknown;
      try {
        body = parseJsonBody(await readBody(req));
      } catch {
        return sendJson(res, 400, { message: 'Malformed JSON body' });
      }
      const record = toRecord(body);
      if (typeof record.description === 'string') repo.description = record.description;
      if (typeof record.private === 'boolean') repo.private = record.private;
      return sendJson(res, 200, repoJson(repo));
    }
    return sendJson(res, 404, { message: 'Not Found' });
  }

  const head = tail[0] as string;

  // POST /labels
  if (head === 'labels' && tail.length === 1) {
    if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' });
    let body: unknown;
    try {
      body = parseJsonBody(await readBody(req));
    } catch {
      return sendJson(res, 400, { message: 'Malformed JSON body' });
    }
    const record = toRecord(body);
    const name = typeof record.name === 'string' ? record.name : '';
    if (name === '') return sendJson(res, 422, { message: 'Label name is required' });
    if (repo.labels.has(name)) return sendJson(res, 422, { message: `Label ${name} already exists` });
    const color = typeof record.color === 'string' ? record.color : 'ededed';
    repo.labels.set(name, { name, color });
    return sendJson(res, 201, { name, color });
  }

  // /issues
  if (head === 'issues') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? undefined;
        const sort = query.get('sort') ?? undefined;
        const direction = query.get('direction') ?? undefined;
        const issues = listIssues(repo, state, sort, direction);
        const { page, hasNext, pageNumber, perPage } = paginate(issues, query);
        const headers = hasNext ? linkHeader(req, path, query, pageNumber, perPage) : {};
        return sendJson(res, 200, page.map((issue) => issueJson(repo, issue)), headers);
      }
      if (method === 'POST') {
        let body: unknown;
        try {
          body = parseJsonBody(await readBody(req));
        } catch {
          return sendJson(res, 400, { message: 'Malformed JSON body' });
        }
        const record = toRecord(body);
        const title = typeof record.title === 'string' ? record.title : '';
        if (title === '') return sendJson(res, 422, { message: 'Issue title is required' });
        const labels = Array.isArray(record.labels) ? record.labels.filter((label): label is string => typeof label === 'string') : [];
        try {
          const issue = storeCreateIssue(repo, title, typeof record.body === 'string' ? record.body : '', labels);
          return sendJson(res, 201, issueJson(repo, issue));
        } catch (err) {
          if (err instanceof ForgeError) return sendJson(res, err.status, { message: err.message });
          throw err;
        }
      }
      return sendJson(res, 404, { message: 'Not Found' });
    }
    const number = Number(tail[1]);
    if (!Number.isInteger(number) || number < 1) return sendJson(res, 404, { message: 'Not Found' });
    const issue = getIssue(repo, number);
    if (tail.length === 2) {
      if (issue === undefined) return sendJson(res, 404, { message: 'Not Found' });
      if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
      if (method === 'PATCH') {
        let body: unknown;
        try {
          body = parseJsonBody(await readBody(req));
        } catch {
          return sendJson(res, 400, { message: 'Malformed JSON body' });
        }
        const record = toRecord(body);
        if (typeof record.title === 'string') issue.title = record.title;
        if (typeof record.body === 'string') issue.body = record.body;
        if (typeof record.state === 'string' && (record.state === 'open' || record.state === 'closed')) issue.state = record.state;
        if (Array.isArray(record.labels)) {
          const labels = record.labels.filter((label): label is string => typeof label === 'string');
          for (const label of labels) if (!repo.labels.has(label)) return sendJson(res, 422, { message: `label ${label} does not exist` });
          issue.labels = labels;
        }
        return sendJson(res, 200, issueJson(repo, issue));
      }
      return sendJson(res, 404, { message: 'Not Found' });
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (issue === undefined) return sendJson(res, 404, { message: 'Not Found' });
      if (method === 'GET') {
        return sendJson(res, 200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, created_at: comment.createdAt, user: { login: VIEWER_LOGIN, id: VIEWER_ID } })));
      }
      if (method === 'POST') {
        let body: unknown;
        try {
          body = parseJsonBody(await readBody(req));
        } catch {
          return sendJson(res, 400, { message: 'Malformed JSON body' });
        }
        const record = toRecord(body);
        const commentBody = typeof record.body === 'string' ? record.body : '';
        repo.commentSeq += 1;
        const comment = {
          id: repo.commentSeq,
          gid: '',
          body: commentBody,
          createdAt: trialNow().iso,
        };
        comment.gid = Buffer.from(`IssueComment:${repo.path}#${issue.number}:${comment.id}`, 'utf8').toString('base64url');
        issue.comments.push(comment);
        return sendJson(res, 201, { id: comment.id, body: comment.body, created_at: comment.createdAt, user: { login: VIEWER_LOGIN, id: VIEWER_ID } });
      }
      return sendJson(res, 404, { message: 'Not Found' });
    }
    return sendJson(res, 404, { message: 'Not Found' });
  }

  // /pulls
  if (head === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = repo.pulls;
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        const { page } = paginate(pulls, query);
        return sendJson(res, 200, page.map((pull) => pullJson(repo, pull)));
      }
      if (method === 'POST') {
        let body: unknown;
        try {
          body = parseJsonBody(await readBody(req));
        } catch {
          return sendJson(res, 400, { message: 'Malformed JSON body' });
        }
        const record = toRecord(body);
        const headRef = typeof record.head === 'string' ? record.head : '';
        const baseRef = typeof record.base === 'string' ? record.base : '';
        const title = typeof record.title === 'string' ? record.title : '';
        if (headRef === '' || baseRef === '' || title === '') return sendJson(res, 422, { message: 'A pull request needs head, base and title' });
        try {
          const pull = storeCreatePull(repo, headRef, baseRef, title, typeof record.body === 'string' ? record.body : '');
          return sendJson(res, 201, pullJson(repo, pull));
        } catch (err) {
          if (err instanceof ForgeError) return sendJson(res, err.status, { message: err.message });
          throw err;
        }
      }
      return sendJson(res, 404, { message: 'Not Found' });
    }
    const number = Number(tail[1]);
    if (!Number.isInteger(number) || number < 1) return sendJson(res, 404, { message: 'Not Found' });
    const pull = getPull(repo, number);
    if (tail.length === 2) {
      if (pull === undefined) return sendJson(res, 404, { message: 'Not Found' });
      if (method !== 'GET') return sendJson(res, 404, { message: 'Not Found' });
      return sendJson(res, 200, pullJson(repo, pull));
    }
    if (tail.length === 3 && tail[2] === 'files') {
      if (pull === undefined) return sendJson(res, 404, { message: 'Not Found' });
      if (method !== 'GET') return sendJson(res, 404, { message: 'Not Found' });
      return sendJson(res, 200, pullFiles(repo, pull));
    }
    if (tail.length === 3 && tail[2] === 'merge') {
      if (pull === undefined) return sendJson(res, 404, { message: 'Not Found' });
      if (method !== 'PUT') return sendJson(res, 404, { message: 'Not Found' });
      try {
        await readBody(req); // the merge body is read and ignored beyond its JSON shape
      } catch {
        return sendJson(res, 400, { message: 'Malformed JSON body' });
      }
      try {
        const { sha } = mergePull(repo, pull);
        return sendJson(res, 200, { sha, merged: true, message: 'Pull request successfully merged' });
      } catch (err) {
        if (err instanceof ForgeError) return sendJson(res, err.status, { message: err.message });
        throw err;
      }
    }
    return sendJson(res, 404, { message: 'Not Found' });
  }

  // /contents/{path...}
  if (head === 'contents') {
    const contentPath = tail.slice(1).join('/');
    if (method === 'GET') {
      return handleContentsGet(res, repo, contentPath, query.get('ref') ?? undefined);
    }
    if (method === 'PUT') {
      let body: unknown;
      try {
        body = parseJsonBody(await readBody(req));
      } catch {
        return sendJson(res, 400, { message: 'Malformed JSON body' });
      }
      const record = toRecord(body);
      const message = typeof record.message === 'string' ? record.message : '';
      const contentB64 = typeof record.content === 'string' ? record.content : '';
      const branch = typeof record.branch === 'string' ? record.branch : undefined;
      const sha = typeof record.sha === 'string' ? record.sha : undefined;
      let content: Buffer;
      try {
        content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
      } catch {
        return sendJson(res, 400, { message: 'content is not valid base64' });
      }
      try {
        if (sha !== undefined) {
          const result = updateFile(repo, branch, contentPath, content, message, sha);
          return sendJson(res, 200, {
            content: { name: contentPath.split('/').pop() ?? '', path: contentPath, sha: result.contentSha, size: content.length, type: 'file', encoding: 'base64' },
            commit: { sha: result.commitSha, message },
          });
        }
        // A create without a sha on a file that already exists is GitHub's 422.
        const existingTip = resolveRef(repo, branch);
        if (existingTip !== undefined) {
          const existingCommit = repo.get(existingTip);
          if (existingCommit !== undefined && existingCommit.type === 'commit') {
            const flat = flattenTree(repo, parseCommit(existingCommit.data).tree);
            if (flat.has(contentPath)) return sendJson(res, 422, { message: `file ${contentPath} already exists` });
          }
        }
        const result = commitFile(repo, branch, contentPath, content, message);
        return sendJson(res, result.created ? 201 : 200, {
          content: { name: contentPath.split('/').pop() ?? '', path: contentPath, sha: result.contentSha, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: result.commitSha, message },
        });
      } catch (err) {
        if (err instanceof ForgeError) return sendJson(res, err.status, { message: err.message });
        throw err;
      }
    }
    if (method === 'DELETE') {
      let body: unknown;
      try {
        body = parseJsonBody(await readBody(req));
      } catch {
        return sendJson(res, 400, { message: 'Malformed JSON body' });
      }
      const record = toRecord(body);
      const message = typeof record.message === 'string' ? record.message : '';
      const branch = typeof record.branch === 'string' ? record.branch : undefined;
      const sha = typeof record.sha === 'string' ? record.sha : undefined;
      try {
        const { commitSha } = deleteFile(repo, branch, contentPath, message, sha);
        return sendJson(res, 200, { commit: { sha: commitSha, message } });
      } catch (err) {
        if (err instanceof ForgeError) return sendJson(res, err.status, { message: err.message });
        throw err;
      }
    }
    return sendJson(res, 404, { message: 'Not Found' });
  }

  // /git/refs — create a ref; /git/refs/heads/{branch} — read one ref.
  if (head === 'git' && tail[1] === 'refs') {
    if (tail.length === 2 && method === 'POST') {
      let body: unknown;
      try {
        body = parseJsonBody(await readBody(req));
      } catch {
        return sendJson(res, 400, { message: 'Malformed JSON body' });
      }
      const record = toRecord(body);
      const ref = typeof record.ref === 'string' ? record.ref : '';
      const sha = typeof record.sha === 'string' ? record.sha : '';
      if (!ref.startsWith('refs/')) return sendJson(res, 422, { message: 'ref must start with refs/' });
      if (repo.refs.has(ref)) return sendJson(res, 422, { message: `ref ${ref} already exists` });
      const obj = repo.get(sha);
      if (obj === undefined) return sendJson(res, 422, { message: `object ${sha} does not exist` });
      repo.refs.set(ref, sha);
      repo.touchGit();
      return sendJson(res, 201, { ref, object: { sha, type: obj.type }, url: `/api/v3/repos/${repo.path}/git/refs/${encodeURIComponent(ref)}` });
    }
    if (tail.length === 4 && tail[2] === 'heads' && method === 'GET') {
      const branch = tail[3] as string;
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return sendJson(res, 404, { message: 'Not Found' });
      return sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
    }
    return sendJson(res, 404, { message: 'Not Found' });
  }

  // /branches — list; /branches/{branch} — one.
  if (head === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches: Array<{ name: string; commit: { sha: string } }> = [];
      for (const [ref, sha] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
      return sendJson(res, 200, branches.map((branch) => ({ ...branch, protected: false })));
    }
    if (tail.length === 2 && method === 'GET') {
      const branch = tail[1] as string;
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return sendJson(res, 404, { message: 'Not Found' });
      return sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
    }
    return sendJson(res, 404, { message: 'Not Found' });
  }

  // /commits — list, newest first; ?sha=<branch or oid> selects the tip.
  if (head === 'commits' && tail.length === 1) {
    if (method !== 'GET') return sendJson(res, 404, { message: 'Not Found' });
    const tip = resolveRef(repo, query.get('sha') ?? undefined);
    const commits = listCommits(repo, tip).map((entry) => ({
      sha: entry.sha,
      commit: { message: entry.message, author: { name: VIEWER_LOGIN, email: VIEWER_EMAIL }, committer: { name: VIEWER_LOGIN, email: VIEWER_EMAIL } },
    }));
    return sendJson(res, 200, commits);
  }

  return sendJson(res, 404, { message: 'Not Found' });
}

/** GET /contents/{path}[?ref=]: a file object, a directory listing, or a 404. */
function handleContentsGet(res: ServerResponse, repo: Repo, contentPath: string, ref: string | undefined): void {
  const tip = resolveRef(repo, ref);
  if (tip === undefined) return sendJson(res, 404, { message: 'Not Found' });
  const commit = repo.get(tip);
  if (commit === undefined || commit.type !== 'commit') return sendJson(res, 404, { message: 'Not Found' });
  const treeOid = parseCommit(commit.data).tree;
  const lookup = lookupPath(repo, treeOid, contentPath);
  if (lookup === undefined) return sendJson(res, 404, { message: 'Not Found' });
  if (lookup.kind === 'file') {
    const blob = repo.get(lookup.oid);
    if (blob === undefined) return sendJson(res, 404, { message: 'Not Found' });
    return sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: contentPath.split('/').pop() ?? '',
      path: contentPath,
      content: blob.data.toString('base64'),
      sha: lookup.oid,
    });
  }
  const entries: Array<Record<string, unknown>> = [];
  for (const entry of lookup.entries) {
    const childPath = contentPath === '' ? entry.name : `${contentPath}/${entry.name}`;
    if (entry.mode === '40000') {
      entries.push({ type: 'dir', name: entry.name, path: childPath, sha: entry.oid });
    } else {
      const blob = repo.get(entry.oid);
      entries.push({ type: 'file', name: entry.name, path: childPath, sha: entry.oid, size: blob?.data.length ?? 0 });
    }
  }
  return sendJson(res, 200, entries);
}

type LookupResult =
  | { kind: 'file'; oid: string }
  | { kind: 'dir'; entries: Array<{ mode: string; name: string; oid: string }> };

/** Resolve a path inside a tree: a blob, a subtree's entries, or undefined. */
function lookupPath(repo: Repo, treeOid: string, path: string): LookupResult | undefined {
  if (path === '') {
    return { kind: 'dir', entries: parseTreeEntries(repo, treeOid) };
  }
  const parts = path.split('/');
  let currentOid = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const entries = parseTreeEntries(repo, currentOid);
    const entry = entries.find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return undefined;
    if (i === parts.length - 1) {
      if (entry.mode === '40000') return { kind: 'dir', entries: parseTreeEntries(repo, entry.oid) };
      return { kind: 'file', oid: entry.oid };
    }
    if (entry.mode !== '40000') return undefined;
    currentOid = entry.oid;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP

interface AdvertisedRef {
  oid: string;
  name: string;
  peeled?: string;
}

/** All refs of a repo, HEAD first, then branches and tags sorted by name. */
/**
 * Look a memoized git smart-HTTP response up on the repo, or build and store it.
 * The response is a pure function of the repo's refs/objects plus the cache key
 * (the request's parsed arguments), and every mutation clears the map, so a hit
 * is always the answer a fresh computation would give. Bounded so a repo that
 * sees many distinct fetches cannot grow the map without limit.
 */
const GIT_CACHE_MAX = 64;
function gitCached(repo: Repo, key: string, build: () => Buffer): Buffer {
  const hit = repo.gitCache.get(key);
  if (hit !== undefined) return hit;
  const built = build();
  if (repo.gitCache.size >= GIT_CACHE_MAX) repo.gitCache.clear();
  repo.gitCache.set(key, built);
  return built;
}

/** The v2 info/refs advertisement never depends on repo state: build it once. */
const INFO_REFS_V2_BODY = Buffer.concat([
  ...[
    '# service=git-upload-pack\n',
    'version 2\n',
    'agent=github-core-forge/1.0.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
  ].map((line) => pktLine(line)),
  flushPkt(),
]);

function advertisementRefs(repo: Repo): AdvertisedRef[] {
  const refs: AdvertisedRef[] = [];
  const tip = repo.refs.get(repo.defaultRef());
  refs.push({ oid: tip ?? ZERO_OID, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const obj = repo.get(oid);
    let peeled: string | undefined;
    if (obj !== undefined && obj.type === 'tag') peeled = parseTag(obj.data).object;
    refs.push({ oid, name, peeled });
  }
  return refs;
}

function v0CapabilityLine(service: 'git-upload-pack' | 'git-receive-pack'): string {
  if (service === 'git-upload-pack') {
    return 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack shallow agent=github-core-forge/1.0.0';
  }
  return 'report-status side-band-64k delete-refs ofs-delta agent=github-core-forge/1.0.0';
}

/** The info/refs advertisement: v2 when the client asked for it, v0 otherwise. */
function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): void {
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const contentType = `application/x-${service}-advertisement`;
  if (wantsV2) {
    return sendBuffer(res, 200, INFO_REFS_V2_BODY, contentType);
  }
  // The v0 advertisement is a pure function of the refs (and tag objects); the
  // 50 concurrent clones of one repo all ask for the same one.
  const body = gitCached(repo, `info0|${service}`, () => {
    const refs = advertisementRefs(repo);
    const caps = v0CapabilityLine(service);
    const chunks: Buffer[] = [pktLine(`# service=${service}\n`)];
    const tip = repo.refs.get(repo.defaultRef());
    if (tip === undefined) {
      // An unborn repo: the capabilities^{} pseudo-ref carries the capabilities, HEAD is zero.
      chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
      chunks.push(pktLine(`${ZERO_OID} HEAD\n`));
    } else {
      chunks.push(pktLine(`${refs[0]?.oid ?? ZERO_OID} HEAD\0${caps}\n`));
      for (const ref of refs.slice(1)) {
        chunks.push(pktLine(`${ref.oid} ${ref.name}\n`));
        if (ref.peeled !== undefined) chunks.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
      }
    }
    chunks.push(flushPkt());
    return Buffer.concat(chunks);
  });
  return sendBuffer(res, 200, body, contentType);
}

interface FetchPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
}

/**
 * The commits a client actually holds for its haves: the ancestors of each have, except that
 * the walk stops at a shallow boundary — the client holds the boundary commit itself, but not
 * the boundary's parents (that is what makes a deepen fetch deliver them).
 */
function heldCommits(repo: Repo, haves: readonly string[], shallowBoundaries: ReadonlySet<string>): Set<string> {
  const held = new Set<string>();
  const stack: string[] = [];
  for (const have of haves) {
    const obj = repo.get(have);
    if (obj === undefined) continue;
    if (obj.type === 'tag') stack.push(parseTag(obj.data).object);
    else if (obj.type === 'commit') stack.push(have);
  }
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (held.has(oid)) continue;
    const obj = repo.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    held.add(oid);
    if (shallowBoundaries.has(oid)) continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return held;
}

/**
 * The object set a fetch sends: the closure of the wanted commits (within `depth` generations
 * when given), minus everything reachable from the client's haves. A tag named by a want is
 * itself part of the pack; a tag named by a have is held. The shallow-info lines are the
 * depth boundary and the client's former boundaries that are now covered.
 */
function computeFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  const haveCommits = heldCommits(repo, haves, shallowSet);
  let included: Set<string>;
  let boundary: Set<string> = new Set();
  if (depth !== null) {
    const walked = walkCommits(repo, wants, depth);
    included = walked.included;
    boundary = walked.boundary;
  } else {
    included = walkCommits(repo, wants, null, haveCommits).included;
  }
  const unshallow = clientShallow.filter((oid) => included.has(oid));
  const wantObjects = objectsForCommits(repo, included);
  const haveObjects = objectsForCommits(repo, haveCommits);
  for (const want of wants) {
    const obj = repo.get(want);
    if (obj !== undefined && obj.type === 'tag') wantObjects.set(want, obj);
  }
  for (const have of haves) {
    const obj = repo.get(have);
    if (obj !== undefined && obj.type === 'tag') haveObjects.set(have, obj);
  }
  const packObjects: GitObject[] = [];
  for (const [oid, obj] of [...wantObjects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!haveObjects.has(oid)) packObjects.push(obj);
  }
  return { pack: writePack(packObjects), shallow: [...boundary].sort(), unshallow };
}

/** A v2 ls-refs answer: the refs (prefix-filtered), HEAD first when no prefix is given. */
function handleLsRefs(repo: Repo, args: readonly string[]): Buffer {
  // Same refs + same arguments = same answer; the clone workload asks 50 times.
  return gitCached(repo, `lsrefs\n${args.join('\n')}`, () => {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const defaultTip = repo.refs.get(repo.defaultRef());
  if (prefixes.length === 0) {
    // An unborn repo reports only its HEAD (as unborn, with the symref target): an unborn
    // branch line of its own would read as an existing ref to callers that filter by name.
    if (defaultTip !== undefined && symrefs) lines.push(`${defaultTip} HEAD symref-target:refs/heads/main\n`);
    else if (defaultTip !== undefined) lines.push(`${defaultTip} HEAD\n`);
    else if (symrefs) lines.push(`unborn HEAD symref-target:refs/heads/main\n`);
    else lines.push(`unborn HEAD\n`);
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    const obj = repo.get(oid);
    let line = `${oid} ${name}`;
    if (peel && obj !== undefined && obj.type === 'tag') line += ` peeled:${parseTag(obj.data).object}`;
    lines.push(`${line}\n`);
  }
  const chunks = lines.map((line) => pktLine(line));
  chunks.push(flushPkt());
  return Buffer.concat(chunks);
  });
}

/** A v2 fetch answer: acknowledgments, shallow-info, then the packfile section. */
function handleFetchV2(repo: Repo, args: readonly string[]): Buffer {
  // The pack for one (wants, haves, shallow, depth) on one repo state is fixed;
  // the 50 concurrent depth-1 clones of the bench all ask for the same one.
  return gitCached(repo, `fetch2\n${args.join('\n')}`, () => {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const value = Number(arg.slice(7).trim());
      if (Number.isInteger(value) && value > 0) depth = value;
    }
  }
  const plan = computeFetch(repo, wants, haves, clientShallow, depth);
  const chunks: Buffer[] = [];
  chunks.push(pktLine('acknowledgments\n'));
  chunks.push(pktLine('NAK\n'));
  chunks.push(flushPkt());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    chunks.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
    chunks.push(flushPkt());
  }
  chunks.push(pktLine('packfile\n'));
  chunks.push(...sidebandChunks(1, plan.pack));
  chunks.push(flushPkt());
  return Buffer.concat(chunks);
  });
}

/** A v0 fetch answer: NAK / shallow lines, then the sideband pack. */
function handleFetchV0(repo: Repo, lines: readonly string[]): Buffer {
  return gitCached(repo, `fetch0\n${lines.join('\n')}`, () => {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7).trim());
      if (Number.isInteger(value) && value > 0) depth = value;
    }
  }
  const plan = computeFetch(repo, wants, haves, clientShallow, depth);
  const chunks: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  chunks.push(...sidebandChunks(1, plan.pack));
  chunks.push(flushPkt());
  return Buffer.concat(chunks);
  });
}

/** Strip one trailing '\n' from a pkt-line payload: the same as .replace(/\n$/, '') without a regex run per line. */
function stripNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { message: 'Request body too large' });
  }
  const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  try {
    if (wantsV2) {
      const { packets } = parsePktLines(body);
      const lines = packets.filter((packet) => packet.kind === 'data').map((packet) => stripNewline(packet.payload.toString('utf8')));
      const commandLine = lines[0] ?? '';
      if (commandLine === 'command=ls-refs') {
        const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
        const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : [];
        const args = argPackets
          .filter((packet) => packet.kind === 'data')
          .map((packet) => stripNewline(packet.payload.toString('utf8')));
        return sendBuffer(res, 200, handleLsRefs(repo, args), 'application/x-git-upload-pack-result');
      }
      if (commandLine === 'command=fetch') {
        const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
        const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : [];
        const args = argPackets
          .filter((packet) => packet.kind === 'data')
          .map((packet) => stripNewline(packet.payload.toString('utf8')));
        return sendBuffer(res, 200, handleFetchV2(repo, args), 'application/x-git-upload-pack-result');
      }
      return sendJson(res, 400, { message: `Unknown git command ${JSON.stringify(commandLine)}` });
    }
    // v0: wants (with shallow/deepen) up to the first flush, then haves and done.
    const { packets } = parsePktLines(body);
    const lines = packets.filter((packet) => packet.kind === 'data').map((packet) => stripNewline(packet.payload.toString('utf8')));
    if (lines.length === 0 || !lines[0]?.startsWith('want ')) return sendJson(res, 400, { message: 'Expected a want line' });
    return sendBuffer(res, 200, handleFetchV0(repo, lines), 'application/x-git-upload-pack-result');
  } catch (err) {
    return sendJson(res, 400, { message: err instanceof Error ? err.message : 'Malformed git request' });
  }
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { message: 'Request body too large' });
  }
  const { packets, rest } = parsePktLines(body);
  const commandLines = packets
    .filter((packet) => packet.kind === 'data')
    .map((packet) => stripNewline(packet.payload.toString('utf8')));
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const line of commandLines) {
    const nul = line.indexOf('\0');
    const text = nul >= 0 ? line.slice(0, nul) : line;
    const parts = text.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  let unpackError: string | null = null;
  if (rest.length > 0) {
    try {
      const { objects } = readPack(rest, (oid) => repo.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const report: string[] = [];
  if (unpackError !== null) {
    report.push(`unpack ${unpackError}\n`);
    for (const command of commands) report.push(`ng ${command.ref} unpacker error\n`);
  } else {
    report.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete: removing a ref that is already gone is still ok.
        if (current !== undefined) repo.refs.delete(command.ref);
        report.push(`ok ${command.ref}\n`);
        continue;
      }
      const newObj = repo.get(command.newOid);
      if (newObj === undefined) {
        report.push(`ng ${command.ref} object not found\n`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) {
          report.push(`ng ${command.ref} already exists\n`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        report.push(`ok ${command.ref}\n`);
        continue;
      }
      if (current === undefined || current !== command.oldOid) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      if (!isAncestorFastForward(repo, current, command.newOid)) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}\n`);
    }
  }
  // Objects were inserted above and refs moved: any memoized git response is stale.
  repo.touchGit();
  const reportText = Buffer.from(report.join(''), 'utf8');
  const chunks = sidebandChunks(1, reportText);
  chunks.push(flushPkt());
  return sendBuffer(res, 200, Buffer.concat(chunks), 'application/x-git-receive-pack-result');
}

/** Fast-forward: the new tip must descend from the current tip (or be the same commit). */
function isAncestorFastForward(repo: Repo, current: string, next: string): boolean {
  if (current === next) return true;
  const nextObj = repo.get(next);
  if (nextObj === undefined) return false;
  // Walk the new tip's ancestry looking for the current tip.
  const seen = new Set<string>();
  const stack = [next];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
      continue;
    }
    if (obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === current) return true;
      stack.push(parent);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// server

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await dispatch(req, res);
      } catch (err) {
        if (!res.headersSent) {
          try {
            sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
          } catch {
            // The socket is gone; there is nothing left to answer.
          }
        }
      }
    })();
  });
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const path = pathOf(req);

  // The env's boot check calls this twice: 200 {"ok":true}. No token needed.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Everything else authenticates first: no token is a 401, before any dispatch.
  if (!isAuthed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  // MCP: POST /mcp, JSON-RPC 2.0 Streamable HTTP.
  if (method === 'POST' && path === '/mcp') {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { message: 'Request body too large' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const outcome = handleMcp(store, parsed);
    if (outcome.body === null) {
      sendNoContent(res, outcome.status);
      return;
    }
    sendJson(res, outcome.status, outcome.body);
    return;
  }

  // GraphQL: POST /api/graphql (single operation or a batch array).
  if (method === 'POST' && path === '/api/graphql') {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { message: 'Request body too large' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      sendJson(res, 400, { message: 'Malformed JSON body' });
      return;
    }
    sendJson(res, 200, executeGraphQLBody(store, parsed));
    return;
  }

  // REST v3 (segments split once here and reused by the git branch below).
  const segs = segments(path);
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(req, res, path, segs);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack.
  if (segs.length >= 3 && segs[1]?.endsWith('.git') === true) {
    const owner = segs[0] as string;
    const repoName = (segs[1] as string).slice(0, -4);
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (method === 'GET' && segs[2] === 'info' && segs[3] === 'refs') {
      const service = queryOf(req).get('service');
      if (service === 'git-upload-pack' || service === 'git-receive-pack') {
        handleInfoRefs(req, res, repo, service);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (method === 'POST' && segs[2] === 'git-upload-pack' && segs.length === 3) {
      await handleUploadPack(req, res, repo);
      return;
    }
    if (method === 'POST' && segs[2] === 'git-receive-pack' && segs.length === 3) {
      await handleReceivePack(req, res, repo);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Everything else, every method: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}
