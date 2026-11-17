# github-core-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/maming000/github-core-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/maming000/github-core-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process, standard library only: git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4 and MCP, all on one deterministic in-memory store. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. There is nothing to install: the program imports `node:http` and its own modules only, and the trial has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL` (`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with `server.address().port`. Never bind 8080.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers `{"done":false}` while the suite runs and `{"done":true}` once its export is written. Poll it; never exit before it says `true`.
4. **Exit 0** when it does.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list and tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` (own pack/object implementation, no git binary) |
| anything else | 404 `{"message":"Not Found"}` |

## Determinism

No wall clock and no unseeded randomness anywhere in state: timestamps come from `MAKEFUN_TRIAL_NOW`, ids from counters, so a live trial and its replay leave byte-identical state.

---

<sub>Entered on [make.fun](https://make.fun/?ref=nmadvdx0&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
