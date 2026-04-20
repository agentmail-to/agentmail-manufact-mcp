# AgentMail MCP Server (Remote)

Remote MCP server for the AgentMail API, deployed via [Manufact](https://manufact.com) at <https://mcp.agentmail.to>.

## Auth

Two paths supported, checked in this order:

1. **API key (legacy)** — pass `?apiKey=am_...` query param, `x-api-key` header, or set `AGENTMAIL_API_KEY` env var.
2. **Clerk OAuth (modern)** — clients that follow the [MCP 2025-06-18 OAuth spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) (Claude Desktop, Claude Code, Claude Web) auto-discover OAuth via `/.well-known/*`, dynamically register themselves against our Clerk instance, and arrive with `Authorization: Bearer <Clerk JWT>`. The server bridges that to a per-org console JWT and calls the AgentMail backend.

If neither is present, the server returns 401 + `WWW-Authenticate` to bootstrap the OAuth discovery flow.

## Setup

### Local Development

```bash
pnpm install
cp .env.example .env  # fill in CLERK_* and CONSOLE_JWT_PRIVATE_KEY
pnpm run build
pnpm run start
```

The server runs at `http://localhost:3000/mcp`.

### Environment Variables

| Variable                     | Required for                | Notes                                                              |
| ---------------------------- | --------------------------- | ------------------------------------------------------------------ |
| `PORT`                       | always                      | Manufact injects this in production                                |
| `CLERK_PUBLISHABLE_KEY`      | OAuth path                  | `pk_test_...` (dev) or `pk_live_...` (prod)                        |
| `CLERK_SECRET_KEY`           | OAuth path                  | `sk_test_...` or `sk_live_...`                                     |
| `CONSOLE_JWT_PRIVATE_KEY`    | OAuth path                  | Same ES256 PEM the console uses for `agentmail-api` audience JWTs  |
| `AGENTMAIL_API_URL`          | OAuth path                  | e.g. `https://api.agentmail.sh` (staging), `https://api.agentmail.to` (prod) |
| `AGENTMAIL_API_KEY`          | API key path (server-wide)  | Optional fallback if no per-request key is provided                |

If `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` are absent, OAuth is disabled and the server only serves the API key path (legacy behavior).

### Deployment

This server is deployed to [Manufact](https://manufact.com) via GitHub App integration. Push to `main` triggers automatic production deployment to `mcp.agentmail.to`. Branch pushes get preview deploys.

## Related

- [agentmail-mcp](https://github.com/agentmail-to/agentmail-mcp): Local MCP server (stdio transport, via `npx agentmail-mcp`)
- [AgentMail Docs](https://docs.agentmail.to)
- [@clerk/mcp-tools](https://github.com/clerk/mcp-tools): Clerk's MCP OAuth helpers
