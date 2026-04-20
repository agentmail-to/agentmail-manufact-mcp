---
title: AgentMail Remote MCP Server
description: TypeScript MCP server wrapping agentmail-toolkit, hosted on Manufact Cloud. Supports both API-key auth (legacy) and Clerk OAuth (modern, MCP 2025-06-18 spec).
overview: Remote MCP server for the AgentMail API. Run `pnpm run build && pnpm run start` to start locally, or deploy to Manufact Cloud via CLI or GitHub repo.
version: '1.1.0'
---

# AGENTS.md

Welcome to the **AgentMail Remote MCP Server**!

This is the remote (HTTP-hosted) MCP server for the AgentMail API, hosted on [Manufact Cloud](https://manufact.com). It wraps `agentmail-toolkit` and exposes all AgentMail tools via the standard MCP protocol over Streamable HTTP transport.

**Important**: This server uses the **standard `@modelcontextprotocol/sdk`** and Express directly, not the Manufact/mcp-use server framework (`mcp-use/server`). Manufact runs the app from `package.json` (`build` / `start`); there is no committed `Dockerfile` so Manufact generates the build image (avoids Docker Hub pull issues on some builders). This keeps the repo a thin, portable wrapper around `agentmail-toolkit`.

There is a separate **local** MCP server at [agentmail-mcp](https://github.com/agentmail-to/agentmail-mcp) that uses stdio transport and is distributed as an npm package (`npx agentmail-mcp`).

## Table of Contents

- [Project Structure](#project-structure)
- [Quick Start Commands](#quick-start-commands)
- [Authentication](#authentication)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Concepts](#concepts)
- [Development Workflow](#development-workflow)
- [Deployment & CI/CD](#deployment--cicd)
- [Troubleshooting](#troubleshooting)
- [Resources](#resources)

### Project Structure

```
agentmail-manufact-mcp/
├── package.json           # Dependencies (pinned versions, no ^)
├── pnpm-lock.yaml         # Lockfile (committed; Manufact uses frozen-lockfile)
├── tsconfig.json          # TypeScript config, outputs to ./build
├── src/
│   └── index.ts           # Main server implementation (Express + standard MCP SDK + Clerk OAuth)
├── .env.example           # Local dev env template
├── AGENTS.md
└── README.md
```

## Quick Start Commands

```bash
# Install dependencies
pnpm install

# First time: copy env template and fill in Clerk + console JWT secrets
cp .env.example .env

# Build TypeScript to ./build
pnpm run build

# Start the server (default port 3000)
pnpm run start

# Development mode with watch (rebuilds + restarts on file changes)
pnpm run dev

# Run on a custom port
PORT=8080 pnpm run start

# Kill existing process if port 3000 is in use
lsof -ti:3000 | xargs kill
```

## Authentication

Two paths are supported, checked in order on every request:

### 1. API key (legacy fast path)

Sources, in priority order:

- URL query parameter: `http://localhost:3000/mcp?apiKey=YOUR_KEY`
- HTTP header: `x-api-key: YOUR_KEY`
- Environment variable: `AGENTMAIL_API_KEY`

If any of these is present, the server skips Clerk entirely and hands the key straight to `AgentMailClient`. This preserves the original behavior so existing Cursor users don't break.

### 2. Clerk OAuth (modern MCP 2025-06-18 path)

For clients that follow the [MCP OAuth spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) (Claude Desktop, Claude Code, Claude Web, MCP Inspector):

1. Client hits `/mcp` with no auth → server returns 401 + `WWW-Authenticate: Bearer resource_metadata=...`
2. Client fetches `/.well-known/oauth-protected-resource/mcp` → discovers our Clerk authorization server
3. Client fetches Clerk's `/.well-known/openid-configuration` → discovers DCR + auth + token endpoints
4. Client self-registers via Clerk Dynamic Client Registration (`POST /oauth/register`)
5. User goes through Clerk login + consent in browser
6. Client exchanges authorization code for a Clerk OAuth access token (JWT)
7. Client sends `Authorization: Bearer <Clerk JWT>` on subsequent MCP calls
8. Server validates the Clerk JWT (via `mcpAuthClerk` from `@clerk/mcp-tools`), extracts the user ID
9. Per tool call: server looks up the user's first Clerk org → resolves to AgentMail `internalOrgId` (from Clerk org metadata cache, or via `GET /v0/auth/internal-org`) → signs an ES256 console JWT scoped to that org → uses it to call the AgentMail backend

Both paths land in the same `agentmail-toolkit` tool set; only the `AgentMailClient` construction differs.

### When neither auth source is present

Clerk's middleware returns 401 + `WWW-Authenticate`, which prompts MCP-aware clients to start the OAuth discovery flow. Pre-OAuth clients (curl, custom scripts) just see 401 with an `Unauthorized` body.

## Configuration

### Environment variables

| Variable                  | Used by                  | Notes                                                                            |
| ------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `PORT`                    | always                   | Manufact injects this in production (default 3000 locally)                       |
| `CLERK_PUBLISHABLE_KEY`   | OAuth path               | `pk_test_...` (dev Clerk instance) or `pk_live_...` (prod). Both required for OAuth. |
| `CLERK_SECRET_KEY`        | OAuth path               | `sk_test_...` or `sk_live_...`                                                   |
| `CONSOLE_JWT_PRIVATE_KEY` | OAuth path               | Same ES256 PEM as `agentmail-web/apps/console/.env.local` for that environment   |
| `AGENTMAIL_API_URL`       | OAuth path (recommended) | e.g. `https://api.agentmail.sh` (staging), `https://api.agentmail.to` (prod)     |
| `AGENTMAIL_API_KEY`       | API key path (optional)  | Server-wide fallback API key. Most users pass per-request keys instead.          |

If `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` are both unset, the OAuth path is **disabled** and the server runs in legacy API-key-only mode. This is intentional so the server still boots with no Clerk config (e.g. local quick-test).

### Clerk dashboard setup (one-time, per Clerk instance)

Required for the OAuth path:

1. Go to <https://dashboard.clerk.com/> → select the AgentMail instance
2. Navigate to **OAuth applications → Settings**
3. Toggle **Dynamic client registration** ON (required for Claude Desktop / Claude Web / Inspector self-registration)
4. Toggle **Generate access tokens as JWTs** ON (required so `mcpAuthClerk` can validate the token signature locally)

Repeat for both dev and prod Clerk instances.

## Architecture

### How a request flows

```
Client → /mcp
  ↓
authRouter middleware:
  - Extract API key from query/header/env. If present:
      → req.authSource = { kind: 'apiKey', apiKey }
      → next()
  - Otherwise (and Clerk is configured):
      → run mcpAuthClerk middleware (validates Clerk JWT or returns 401)
      → if userId resolved:
          req.authSource = { kind: 'clerk', clerkUserId }
        else:
          req.authSource = { kind: 'none' }
      → next()
  ↓
mcpHandler:
  - createMcpServer(req.authSource)
      Each tool callback resolves the AgentMailClient at call time:
        - kind: 'apiKey' → new AgentMailClient({ apiKey })
        - kind: 'clerk'  → resolve user's first org → console JWT → AgentMailClient
        - kind: 'none'   → return "please authenticate" message
  - Connect server to a fresh StreamableHTTPServerTransport
  - Handle the request
```

### Why per-call client construction

The OAuth path needs to:

1. Look up the user's Clerk org membership (network call)
2. Maybe call `/v0/auth/internal-org` (network call)
3. Sign a fresh ES256 JWT

We don't want to do this on `tools/list` (every client does this on connect — adds latency for nothing). We only do it inside `tools/call`.

### Why standard MCP SDK instead of mcp-use framework

Same reasons as before: no extra dependency, portability if we move off Manufact, compatibility with how `agentmail-toolkit` registers tools, and simplicity.

### Key Dependencies

| Package                       | Purpose                                                             |
| ----------------------------- | ------------------------------------------------------------------- |
| `@modelcontextprotocol/sdk`   | Standard MCP server SDK                                             |
| `agentmail`                   | AgentMail API client                                                |
| `agentmail-toolkit`           | Provides all MCP tools                                              |
| `@clerk/express`              | Clerk middleware for Express (`clerkMiddleware`, `clerkClient`)     |
| `@clerk/mcp-tools`            | Clerk's MCP OAuth helpers (`mcpAuthClerk`, metadata handlers)       |
| `express`                     | HTTP framework                                                      |
| `cors`                        | Required so MCP clients can read the `WWW-Authenticate` header      |
| `jose`                        | JWT signing for the console JWT                                     |
| `zod`                         | Schema validation (used by MCP SDK and toolkit)                     |

All dependency versions are **pinned** (no `^` prefix) to prevent supply chain attacks.

The `pnpm.peerDependencyRules.ignoreMissing` block in `package.json` silences warnings about `pg`, `redis`, and `better-sqlite3` peer deps from `@clerk/mcp-tools`. Those are storage backends for the MCP **client** side; we use the server side only.

## Concepts

(unchanged from previous version — see git history for the original tools/resources/prompts reference)

## Development Workflow

### Testing locally (API key path)

```bash
pnpm run build && pnpm run start
npx @modelcontextprotocol/inspector http://localhost:3000/mcp?apiKey=YOUR_KEY
```

### Testing locally (Clerk OAuth path)

1. Make sure `.env` has `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CONSOLE_JWT_PRIVATE_KEY`, `AGENTMAIL_API_URL`
2. `pnpm run build && pnpm run start`
3. Inspector:
   ```bash
   npx @modelcontextprotocol/inspector
   ```
   - Transport: Streamable HTTP
   - URL: `http://localhost:3000/mcp` (no `?apiKey=`)
   - Click Connect → Open Auth Settings → Quick OAuth Flow
   - Sign in with Clerk, approve consent
   - List Tools, run any tool

### Testing with Claude Desktop locally

Claude Desktop requires HTTPS. Tunnel via ngrok:

```bash
npx ngrok http 3000
```

Then in Claude Desktop: Settings → Connectors → Add → URL = `https://YOUR-NGROK.ngrok-free.dev/mcp`. Claude Desktop will run the OAuth flow automatically.

## Deployment & CI/CD

### Branch deploys (preview)

Push to any non-main branch → Manufact creates a preview deployment at a unique URL. Use these to verify changes before merging.

### Production deploy

Push to `main` → automatic deploy to `mcp.agentmail.to`.

### Required production env vars in Manufact dashboard

For the OAuth path to work in prod, set these on the production deployment:

- `CLERK_PUBLISHABLE_KEY` (prod `pk_live_...`)
- `CLERK_SECRET_KEY` (prod `sk_live_...`)
- `CONSOLE_JWT_PRIVATE_KEY` (prod ES256 PEM)
- `AGENTMAIL_API_URL=https://api.agentmail.to`

`PORT` is auto-injected. `AGENTMAIL_API_KEY` is optional (most users pass per-request).

## Troubleshooting

### OAuth path returns 500

- Check `CONSOLE_JWT_PRIVATE_KEY` is set and is valid ES256 PEM (multi-line).
- Check `AGENTMAIL_API_URL` is set and reachable.
- Check the Clerk user has at least one org membership.
- `/health` endpoint reports whether Clerk is enabled and which AgentMail URL is in use.

### `/v0/auth/internal-org` 401 / 404

- 401: `CONSOLE_JWT_PRIVATE_KEY` doesn't match the backend's expected public key for that environment. Verify you're using the right key for staging vs prod.
- 404: The Clerk org has never been registered with the AgentMail backend. The user needs to log into the console (any environment) at least once to bootstrap.

### Existing API-key clients suddenly broken after this version

They shouldn't be — the API key path takes priority over OAuth. If a request has `?apiKey=` or `x-api-key`, Clerk is never consulted. If you see breakage, file a bug with the request URL + headers.

### Other issues

- Port: default 3000, kill via `lsof -ti:3000 | xargs kill`
- Build: `npx tsc --noEmit` to check TS errors without emit
- Imports: use `.js` extensions in imports (NodeNext / ESM requirement)
- Pin all deps; audit after install: `pnpm audit`

## Resources

- **AgentMail Docs**: [docs.agentmail.to](https://docs.agentmail.to)
- **AgentMail Console**: [console.agentmail.to](https://console.agentmail.to)
- **MCP Protocol**: [modelcontextprotocol.io](https://modelcontextprotocol.io)
- **MCP OAuth spec (2025-06-18)**: [authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- **MCP TypeScript SDK**: [github.com/modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- **@clerk/mcp-tools**: [github.com/clerk/mcp-tools](https://github.com/clerk/mcp-tools)
- **Clerk MCP guide (Express)**: [clerk.com/docs/expressjs/guides/ai/mcp/build-mcp-server](https://clerk.com/docs/expressjs/guides/ai/mcp/build-mcp-server)
- **Manufact Cloud**: [manufact.com](https://manufact.com)
- **Local MCP Server**: [github.com/agentmail-to/agentmail-mcp](https://github.com/agentmail-to/agentmail-mcp)
- **Spike that proved this design**: `~/Desktop/AgentMail_Workplace/mcp-oauth-spike/`
