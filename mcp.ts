// MCP (Model Context Protocol) over Streamable HTTP: JSON-RPC 2.0 on POST /mcp.
// Modern era 2026-07-28 (`server/discover`) plus the legacy `initialize` fallback. Every
// tool result carries both `content` (a JSON string) and `structuredContent` (the object).

import {
  createIssue as storeCreateIssue,
  createPull as storeCreatePull,
  getPull,
  issueJson,
  listIssues,
  mergePull,
  pullJson,
  repoJson,
  VIEWER_LOGIN,
  type Store,
} from './store.ts';

const SERVER_NAME = 'github-core-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

/** The six tools, static so two tools/list calls are byte-identical. */
const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from one branch to another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as ToolDef[]);

export interface McpOutcome {
  status: number;
  body: unknown | null;
}

type JsonRpcId = string | number | null;

function result(id: JsonRpcId, value: unknown): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id, result: value } };
}

function rpcError(id: JsonRpcId, code: number, message: string): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolResult(structured: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(structured);
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function toolError(message: string): Record<string, unknown> {
  const structured = { error: message };
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError: true };
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function missingArg(args: Record<string, unknown>, name: string): boolean {
  return args[name] === undefined || args[name] === null || args[name] === '';
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS.find((tool) => tool.name === name);
  if (def === undefined) return toolError(`Unknown tool: ${name}`);
  for (const required of def.inputSchema.required) {
    if (missingArg(args, required)) return toolError(`Missing required argument: ${required}`);
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = String(args.name);
        const description = typeof args.description === 'string' ? args.description : '';
        const isPrivate = args.private === true;
        const repo = store.createRepo(VIEWER_LOGIN, repoName, description, isPrivate);
        return toolResult(repoJson(repo) as Record<string, unknown>);
      }
      case 'get_repo': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (repo === undefined) return toolError(`Repository ${args.owner}/${args.repo} not found`);
        return toolResult(repoJson(repo) as Record<string, unknown>);
      }
      case 'create_issue': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (repo === undefined) return toolError(`Repository ${args.owner}/${args.repo} not found`);
        const issue = storeCreateIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
        return toolResult(issueJson(repo, issue) as Record<string, unknown>);
      }
      case 'list_issues': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (repo === undefined) return toolError(`Repository ${args.owner}/${args.repo} not found`);
        const state = typeof args.state === 'string' ? args.state : 'open';
        const issues = listIssues(repo, state, 'created', 'desc');
        const structured = {
          issues: issues.map((issue) => issueJson(repo, issue)),
          total_count: issues.length,
        };
        return toolResult(structured as Record<string, unknown>);
      }
      case 'create_pull_request': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (repo === undefined) return toolError(`Repository ${args.owner}/${args.repo} not found`);
        const pull = storeCreatePull(
          repo,
          String(args.head),
          String(args.base),
          String(args.title),
          typeof args.body === 'string' ? args.body : '',
        );
        return toolResult(pullJson(repo, pull) as Record<string, unknown>);
      }
      case 'merge_pull_request': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (repo === undefined) return toolError(`Repository ${args.owner}/${args.repo} not found`);
        const number = Number(args.pull_number);
        const pull = getPull(repo, number);
        if (pull === undefined) return toolError(`Pull request ${number} not found`);
        const { sha } = mergePull(repo, pull);
        return toolResult({ number: pull.number, merged: true, state: 'closed', sha, merge_commit_sha: sha });
      }
      default:
        return toolError(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Handle one JSON-RPC request body (already parsed). Returns the HTTP status and the JSON body
 * (null for a 202 with no body). Auth is the HTTP layer's job, before this runs.
 */
export function handleMcp(store: Store, body: unknown): McpOutcome {
  const record = toRecord(body);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const id = (record.id as JsonRpcId | undefined) ?? null;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = toRecord(record.params);

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return result(id, {
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }
  if (method === 'initialize') {
    return result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'tools/list') {
    return result(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = toRecord(params.arguments);
    if (toolName === '') return rpcError(id, -32602, 'tools/call requires a tool name');
    if (Object.keys(args).length === 0) {
      // Tolerate arguments carried directly on params.
      const { name, ...rest } = params;
      void name;
      const outcome = callTool(store, toolName, rest);
      return result(id, outcome);
    }
    return result(id, callTool(store, toolName, args));
  }
  if (method === 'ping') {
    return result(id, {});
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}
