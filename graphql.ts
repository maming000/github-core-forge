// A small GraphQL executor for the exact surface the suite exercises: viewer, repository,
// node, __type, the issue/pull-request connections and the five mutations. It parses the
// query documents the suite sends (operations, variables, aliases, inline fragments, input
// objects, enums) and resolves them against the shared store — the same objects REST serves.

import {
  createIssue as storeCreateIssue,
  createPull as storeCreatePull,
  decodeGlobalId,
  getIssue,
  getPull,
  globalId,
  listIssues,
  mergePull,
  pullFiles,
  pullMergeable,
  trialNow,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  type: 'query' | 'mutation';
  selectionSet: SelectionNode[];
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$=@![]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const next = source[j + 1] as string;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: text.includes('.') ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document, got ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value} in GraphQL document, got ${token.value}`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek() !== undefined) {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('empty GraphQL document');
    return operations;
  }

  private parseOperation(): OperationNode {
    let type: 'query' | 'mutation' = 'query';
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
      const after = this.peek();
      if (after?.kind === 'name') this.next(); // operation name
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipVariableDefinitions();
    }
    const selectionSet = this.parseSelectionSet();
    return { type, selectionSet };
  }

  /** Skip `($x: Type, ...)` — types are discarded; only the values the caller passes matter. */
  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
      else if (token.kind === 'punct' && token.value === '=') this.parseValue();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (true) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      let typeCondition: string | null = null;
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      // Named fragments (`...Name`) are not used by the suite; skip the name if present.
      if (typeCondition === null && this.peek()?.kind === 'name') this.next();
      return { kind: 'fragment', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (true) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    // Directives are not used by the suite; skip any `@...` block.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          else if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    const selectionSet = this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (true) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ']') {
          this.next();
          return { kind: 'list', values };
        }
        values.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (true) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === '}') {
          this.next();
          return { kind: 'object', fields };
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
    }
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected token ${token.value} as a GraphQL value`);
  }
}

// ---------------------------------------------------------------------------------------------
// values

type Json = string | number | boolean | null | Record<string, unknown> | unknown[];

interface TypedValue {
  __type: string;
  [key: string]: unknown;
}

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
  variables: Record<string, unknown>;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, ctx: Ctx): unknown {
  const arg = field.args.find((candidate) => candidate.name === name);
  if (arg === undefined) return undefined;
  return resolveValue(arg.value, ctx.variables);
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function encodeCursor(kind: string, number: number): string {
  return Buffer.from(`${kind}:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { kind: string; number: number } | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    const number = Number(text.slice(colon + 1));
    if (!Number.isInteger(number)) return null;
    return { kind: text.slice(0, colon), number };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// field tables

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body'];
const REPOSITORY_FIELDS = [
  'id',
  'databaseId',
  'name',
  'nameWithOwner',
  'owner',
  'defaultBranchRef',
  'viewerPermission',
  'hasIssuesEnabled',
  'issue',
  'issues',
  'pullRequests',
  'pullRequest',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'];

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoValue(repo: Repo): TypedValue {
  return { __type: 'Repository', repo };
}

function issueValue(repo: Repo, issue: Issue): TypedValue {
  return { __type: 'Issue', repo, issue };
}

function pullValue(repo: Repo, pull: Pull): TypedValue {
  return { __type: 'PullRequest', repo, pull };
}

function resolveObjectByGlobalId(store: Store, gid: string): TypedValue | null {
  const decoded = decodeGlobalId(gid);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const slash = decoded.key.indexOf('/');
    if (slash < 0) return null;
    const repo = store.getRepo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1));
    return repo === undefined ? null : repoValue(repo);
  }
  if (decoded.kind === 'Issue') {
    const hash = decoded.key.indexOf('#');
    if (hash < 0) return null;
    const repo = store.getRepo(decoded.key.slice(0, decoded.key.indexOf('/')), decoded.key.slice(decoded.key.indexOf('/') + 1, hash));
    if (repo === undefined) return null;
    const issue = getIssue(repo, Number(decoded.key.slice(hash + 1)));
    return issue === undefined ? null : issueValue(repo, issue);
  }
  if (decoded.kind === 'PullRequest') {
    const hash = decoded.key.indexOf('#');
    if (hash < 0) return null;
    const repo = store.getRepo(decoded.key.slice(0, decoded.key.indexOf('/')), decoded.key.slice(decoded.key.indexOf('/') + 1, hash));
    if (repo === undefined) return null;
    const pull = getPull(repo, Number(decoded.key.slice(hash + 1)));
    return pull === undefined ? null : pullValue(repo, pull);
  }
  return null;
}

function executeSelection(value: TypedValue | null, selections: SelectionNode[], ctx: Ctx): Record<string, unknown> | null {
  if (value === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== value.__type) continue;
      const nested = executeSelection(value, selection.selectionSet, ctx);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(value, selection, ctx);
  }
  return out;
}

function fieldError(ctx: Ctx, typeName: string, fieldName: string): null {
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
  return null;
}

function resolveField(value: TypedValue, field: FieldNode, ctx: Ctx): unknown {
  const typeName = value.__type;
  if (field.name === '__typename') return typeName;
  switch (typeName) {
    case 'Query':
      return resolveQueryField(value, field, ctx);
    case 'Mutation':
      return resolveMutationField(value, field, ctx);
    case 'Viewer': {
      if (field.name === 'login') return VIEWER_LOGIN;
      return fieldError(ctx, typeName, field.name);
    }
    case 'User': {
      if (field.name === 'login') return value.login as string;
      return fieldError(ctx, typeName, field.name);
    }
    case 'Repository':
      return resolveRepositoryField(value, field, ctx);
    case 'Issue': {
      const issue = value.issue as Issue;
      if (field.name === 'id') return issue.gid;
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issueState(issue);
      if (field.name === 'body') return issue.body;
      return fieldError(ctx, typeName, field.name);
    }
    case 'PullRequest': {
      const pull = value.pull as Pull;
      const repo = value.repo as Repo;
      if (field.name === 'id') return pull.gid;
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'body') return pull.body;
      if (field.name === 'state') return pullState(pull);
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'headRefName') return pull.headRef;
      if (field.name === 'baseRefName') return pull.baseRef;
      if (field.name === 'mergeable') return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      if (field.name === 'files') {
        const first = argValue(field, 'first', ctx) as number | undefined;
        const files = pullFiles(repo, pull).map((file) => ({ __type: 'ChangedFile', path: file.filename }));
        const nodes = first === undefined ? files : files.slice(0, first);
        return executeSelection({ __type: 'FileConnection', nodes } as TypedValue, field.selectionSet ?? [], ctx);
      }
      return fieldError(ctx, typeName, field.name);
    }
    case 'IssueConnection': {
      const nodes = value.nodes as TypedValue[];
      if (field.name === 'nodes') {
        if (field.selectionSet === null) return nodes.map(() => null);
        return nodes.map((node) => executeSelection(node, field.selectionSet as SelectionNode[], ctx));
      }
      if (field.name === 'edges') {
        if (field.selectionSet === null) return [];
        return nodes.map((node) => {
          const edge: TypedValue = { __type: 'IssueEdge', node, cursor: (node as unknown as { __cursor: string }).__cursor ?? '' };
          return executeSelection(edge, field.selectionSet as SelectionNode[], ctx);
        });
      }
      if (field.name === 'pageInfo') {
        return executeSelection({ __type: 'PageInfo', hasNextPage: value.hasNextPage, endCursor: value.endCursor } as TypedValue, field.selectionSet ?? [], ctx);
      }
      if (field.name === 'totalCount') return nodes.length;
      return fieldError(ctx, typeName, field.name);
    }
    case 'PullRequestConnection': {
      const nodes = value.nodes as TypedValue[];
      if (field.name === 'nodes') {
        if (field.selectionSet === null) return nodes.map(() => null);
        return nodes.map((node) => executeSelection(node, field.selectionSet as SelectionNode[], ctx));
      }
      if (field.name === 'pageInfo') {
        return executeSelection({ __type: 'PageInfo', hasNextPage: false, endCursor: null } as TypedValue, field.selectionSet ?? [], ctx);
      }
      if (field.name === 'totalCount') return nodes.length;
      return fieldError(ctx, typeName, field.name);
    }
    case 'FileConnection': {
      const nodes = value.nodes as TypedValue[];
      if (field.name === 'nodes') {
        if (field.selectionSet === null) return nodes.map(() => null);
        return nodes.map((node) => executeSelection(node, field.selectionSet as SelectionNode[], ctx));
      }
      return fieldError(ctx, typeName, field.name);
    }
    case 'ChangedFile': {
      if (field.name === 'path') return value.path as string;
      return fieldError(ctx, typeName, field.name);
    }
    case 'IssueEdge': {
      if (field.name === 'node') return executeSelection(value.node as TypedValue, field.selectionSet ?? [], ctx);
      if (field.name === 'cursor') return value.cursor as string;
      return fieldError(ctx, typeName, field.name);
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return value.hasNextPage as boolean;
      if (field.name === 'endCursor') return value.endCursor as string | null;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      return fieldError(ctx, typeName, field.name);
    }
    case 'Ref': {
      if (field.name === 'name') return value.name as string;
      return fieldError(ctx, typeName, field.name);
    }
    case 'Type': {
      if (field.name === 'name') return value.name as string;
      if (field.name === 'fields') {
        const fields = value.fields as string[];
        if (field.selectionSet === null) return fields.map((name) => ({ name }));
        return fields.map((name) => executeSelection({ __type: 'TypeField', name } as TypedValue, field.selectionSet as SelectionNode[], ctx));
      }
      if (field.name === 'enumValues') {
        const values = (value.enumValues as string[]) ?? [];
        if (field.selectionSet === null) return values.map((name) => ({ name }));
        return values.map((name) => executeSelection({ __type: 'TypeField', name } as TypedValue, field.selectionSet as SelectionNode[], ctx));
      }
      return fieldError(ctx, typeName, field.name);
    }
    case 'TypeField': {
      if (field.name === 'name') return value.name as string;
      return fieldError(ctx, typeName, field.name);
    }
    case 'Comment': {
      const comment = value.comment as { gid: string; body: string };
      if (field.name === 'id') return comment.gid;
      if (field.name === 'body') return comment.body;
      return fieldError(ctx, typeName, field.name);
    }
    case 'CommentEdge': {
      if (field.name === 'node') return executeSelection(value.node as TypedValue, field.selectionSet ?? [], ctx);
      return fieldError(ctx, typeName, field.name);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return executeSelection(value.issue as TypedValue, field.selectionSet ?? [], ctx);
      return fieldError(ctx, typeName, field.name);
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return executeSelection(value.pullRequest as TypedValue, field.selectionSet ?? [], ctx);
      return fieldError(ctx, typeName, field.name);
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return executeSelection(value.commentEdge as TypedValue, field.selectionSet ?? [], ctx);
      return fieldError(ctx, typeName, field.name);
    }
    default:
      return fieldError(ctx, typeName, field.name);
  }
}

function resolveQueryField(value: TypedValue, field: FieldNode, ctx: Ctx): unknown {
  if (field.name === 'viewer') {
    return executeSelection({ __type: 'Viewer' } as TypedValue, field.selectionSet ?? [], ctx);
  }
  if (field.name === 'repository') {
    const owner = argValue(field, 'owner', ctx) as string | undefined;
    const name = argValue(field, 'name', ctx) as string | undefined;
    if (owner === undefined || name === undefined) return null;
    const repo = ctx.store.getRepo(owner, name);
    if (repo === undefined) return null;
    return executeSelection(repoValue(repo), field.selectionSet ?? [], ctx);
  }
  if (field.name === 'node') {
    const id = argValue(field, 'id', ctx) as string | undefined;
    if (id === undefined) return null;
    const resolved = resolveObjectByGlobalId(ctx.store, id);
    if (resolved === null) return null;
    return executeSelection(resolved, field.selectionSet ?? [], ctx);
  }
  if (field.name === '__type') {
    const name = argValue(field, 'name', ctx) as string | undefined;
    const typeValue = introspectionType(name);
    if (typeValue === null) return null;
    return executeSelection(typeValue, field.selectionSet ?? [], ctx);
  }
  return fieldError(ctx, 'Query', field.name);
}

function introspectionType(name: string | undefined): TypedValue | null {
  switch (name) {
    case 'Issue':
      return { __type: 'Type', name: 'Issue', fields: ISSUE_FIELDS, enumValues: [] };
    case 'PullRequest':
      return { __type: 'Type', name: 'PullRequest', fields: PULL_REQUEST_FIELDS, enumValues: [] };
    case 'Repository':
      return { __type: 'Type', name: 'Repository', fields: REPOSITORY_FIELDS, enumValues: [] };
    case 'SearchType':
      return { __type: 'Type', name: 'SearchType', fields: [], enumValues: SEARCH_TYPE_VALUES };
    default:
      return null;
  }
}

function resolveRepositoryField(value: TypedValue, field: FieldNode, ctx: Ctx): unknown {
  const repo = value.repo as Repo;
  switch (field.name) {
    case 'id':
      return repo.gid;
    case 'databaseId':
      return repo.databaseId;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return repo.fullName;
    case 'owner':
      return executeSelection({ __type: 'User', login: repo.owner } as TypedValue, field.selectionSet ?? [], ctx);
    case 'defaultBranchRef': {
      const tip = repo.refs.get(repo.defaultRef());
      if (tip === undefined) return null;
      return executeSelection({ __type: 'Ref', name: repo.defaultBranch } as TypedValue, field.selectionSet ?? [], ctx);
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'issue': {
      const number = argValue(field, 'number', ctx) as number | undefined;
      if (number === undefined) return null;
      const issue = getIssue(repo, number);
      if (issue === undefined) return null;
      return executeSelection(issueValue(repo, issue), field.selectionSet ?? [], ctx);
    }
    case 'issues': {
      const first = argValue(field, 'first', ctx) as number | undefined;
      const after = argValue(field, 'after', ctx) as string | undefined;
      const states = argValue(field, 'states', ctx) as string[] | undefined;
      const orderBy = toRecord(argValue(field, 'orderBy', ctx));
      const direction = (orderBy.direction as string | undefined) ?? 'DESC';
      const wanted = states === undefined || states.length === 0 ? 'all' : states.includes('OPEN') && !states.includes('CLOSED') ? 'open' : states.includes('CLOSED') && !states.includes('OPEN') ? 'closed' : 'all';
      const sorted = listIssues(repo, wanted === 'all' ? 'all' : wanted, 'created', direction === 'DESC' ? 'desc' : 'asc');
      let start = 0;
      if (after !== undefined) {
        const cursor = decodeCursor(after);
        if (cursor !== null) {
          const index = sorted.findIndex((issue) => issue.number === cursor.number);
          if (index >= 0) start = index + 1;
        }
      }
      const page = sorted.slice(start, first === undefined ? undefined : start + first);
      const hasNextPage = start + page.length < sorted.length;
      const endCursor = page.length > 0 ? encodeCursor('issue', (page[page.length - 1] as Issue).number) : null;
      const nodes = page.map((issue) => {
        const node = issueValue(repo, issue) as TypedValue & { __cursor: string };
        node.__cursor = encodeCursor('issue', issue.number);
        return node;
      });
      const connection: TypedValue = { __type: 'IssueConnection', nodes, hasNextPage, endCursor };
      return executeSelection(connection, field.selectionSet ?? [], ctx);
    }
    case 'pullRequests': {
      const first = argValue(field, 'first', ctx) as number | undefined;
      const pulls = [...repo.pulls].sort((a, b) => a.seq - b.seq);
      const page = first === undefined ? pulls : pulls.slice(0, first);
      const nodes = page.map((pull) => pullValue(repo, pull));
      return executeSelection({ __type: 'PullRequestConnection', nodes } as TypedValue, field.selectionSet ?? [], ctx);
    }
    case 'pullRequest': {
      const number = argValue(field, 'number', ctx) as number | undefined;
      if (number === undefined) return null;
      const pull = getPull(repo, number);
      if (pull === undefined) return null;
      return executeSelection(pullValue(repo, pull), field.selectionSet ?? [], ctx);
    }
    default:
      return fieldError(ctx, 'Repository', field.name);
  }
}

function resolveMutationField(value: TypedValue, field: FieldNode, ctx: Ctx): unknown {
  void value;
  const input = toRecord(argValue(field, 'input', ctx));
  if (field.name === 'createIssue') {
    const repositoryId = input.repositoryId as string | undefined;
    const title = input.title as string | undefined;
    const body = (input.body as string | undefined) ?? '';
    if (repositoryId === undefined || title === undefined) {
      ctx.errors.push({ message: 'createIssue requires repositoryId and title.' });
      return null;
    }
    const repo = ctx.store.repoByGlobalId(repositoryId);
    if (repo === undefined) {
      ctx.errors.push({ message: `no repository for id ${repositoryId}.` });
      return null;
    }
    const issue = storeCreateIssue(repo, title, body, []);
    return executeSelection(
      { __type: 'CreateIssuePayload', issue: issueValue(repo, issue) } as TypedValue,
      field.selectionSet ?? [],
      ctx,
    );
  }
  if (field.name === 'closeIssue') {
    const issueId = input.issueId as string | undefined;
    if (issueId === undefined) {
      ctx.errors.push({ message: 'closeIssue requires issueId.' });
      return null;
    }
    const resolved = resolveObjectByGlobalId(ctx.store, issueId);
    if (resolved === null || resolved.__type !== 'Issue') {
      ctx.errors.push({ message: `no issue for id ${issueId}.` });
      return null;
    }
    const issue = resolved.issue as Issue;
    issue.state = 'closed';
    return executeSelection(
      { __type: 'CloseIssuePayload', issue: issueValue(resolved.repo as Repo, issue) } as TypedValue,
      field.selectionSet ?? [],
      ctx,
    );
  }
  if (field.name === 'createPullRequest') {
    const repositoryId = input.repositoryId as string | undefined;
    const baseRefName = input.baseRefName as string | undefined;
    const headRefName = input.headRefName as string | undefined;
    const title = input.title as string | undefined;
    const body = (input.body as string | undefined) ?? '';
    if (repositoryId === undefined || baseRefName === undefined || headRefName === undefined || title === undefined) {
      ctx.errors.push({ message: 'createPullRequest requires repositoryId, baseRefName, headRefName and title.' });
      return null;
    }
    const repo = ctx.store.repoByGlobalId(repositoryId);
    if (repo === undefined) {
      ctx.errors.push({ message: `no repository for id ${repositoryId}.` });
      return null;
    }
    try {
      const pull = storeCreatePull(repo, headRefName, baseRefName, title, body);
      return executeSelection(
        { __type: 'CreatePullRequestPayload', pullRequest: pullValue(repo, pull) } as TypedValue,
        field.selectionSet ?? [],
        ctx,
      );
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }
  if (field.name === 'mergePullRequest') {
    const pullRequestId = input.pullRequestId as string | undefined;
    if (pullRequestId === undefined) {
      ctx.errors.push({ message: 'mergePullRequest requires pullRequestId.' });
      return null;
    }
    const resolved = resolveObjectByGlobalId(ctx.store, pullRequestId);
    if (resolved === null || resolved.__type !== 'PullRequest') {
      ctx.errors.push({ message: `no pull request for id ${pullRequestId}.` });
      return null;
    }
    const repo = resolved.repo as Repo;
    const pull = resolved.pull as Pull;
    try {
      mergePull(repo, pull);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      return null;
    }
    return executeSelection(
      { __type: 'MergePullRequestPayload', pullRequest: pullValue(repo, pull) } as TypedValue,
      field.selectionSet ?? [],
      ctx,
    );
  }
  if (field.name === 'addComment') {
    const subjectId = input.subjectId as string | undefined;
    const body = input.body as string | undefined;
    if (subjectId === undefined || body === undefined) {
      ctx.errors.push({ message: 'addComment requires subjectId and body.' });
      return null;
    }
    const resolved = resolveObjectByGlobalId(ctx.store, subjectId);
    if (resolved === null || resolved.__type !== 'Issue') {
      ctx.errors.push({ message: `no issue for id ${subjectId}.` });
      return null;
    }
    const repo = resolved.repo as Repo;
    const issue = resolved.issue as Issue;
    repo.commentSeq += 1;
    const comment = {
      id: repo.commentSeq,
      gid: globalId('IssueComment', `${repo.path}#${issue.number}:${repo.commentSeq}`),
      body,
      createdAt: trialNow().iso,
    };
    issue.comments.push(comment);
    const node: TypedValue = { __type: 'Comment', comment };
    const edge: TypedValue = { __type: 'CommentEdge', node };
    return executeSelection({ __type: 'AddCommentPayload', commentEdge: edge } as TypedValue, field.selectionSet ?? [], ctx);
  }
  return fieldError(ctx, 'Mutation', field.name);
}

// ---------------------------------------------------------------------------------------------
// entry points

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

/** Execute one operation document against the store. */
export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>): GraphQLResult {
  let operations: OperationNode[];
  try {
    operations = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = operations[0] as OperationNode;
  const ctx: Ctx = { store, errors: [], variables };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection({ __type: rootType } as TypedValue, operation.selectionSet, ctx);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Execute a batch (an array of operations) or a single operation, as the HTTP layer passes it. */
export function executeGraphQLBody(
  store: Store,
  body: unknown,
): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) {
    return body.map((operation) => {
      const record = toRecord(operation);
      const query = typeof record.query === 'string' ? record.query : '';
      const variables = toRecord(record.variables);
      return executeGraphQL(store, query, variables);
    });
  }
  const record = toRecord(body);
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = toRecord(record.variables);
  return executeGraphQL(store, query, variables);
}

export type { Json };
