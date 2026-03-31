---
title: AgentMail Remote MCP Server
description: TypeScript MCP server wrapping agentmail-toolkit, hosted on Manufact Cloud. Uses the standard MCP SDK with Streamable HTTP transport (not the mcp-use server framework).
overview: Remote MCP server for the AgentMail API. Run `pnpm run build && pnpm run start` to start locally, or deploy to Manufact Cloud via CLI or GitHub repo.
version: '1.0.0'
---

# AGENTS.md

Welcome to the **AgentMail Remote MCP Server**!

This is the remote (HTTP-hosted) MCP server for the AgentMail API, hosted on [Manufact Cloud](https://manufact.com) as a container deployment. It wraps `agentmail-toolkit` and exposes all AgentMail tools via the standard MCP protocol over Streamable HTTP transport.

**Important**: This server uses the **standard `@modelcontextprotocol/sdk`** and Express directly, not the Manufact/mcp-use server framework (`mcp-use/server`). Manufact is used purely as a hosting/deployment platform for the Docker container. This is intentional: it avoids an extra framework dependency and keeps the server as a thin, portable wrapper around `agentmail-toolkit`.

There is a separate **local** MCP server at [agentmail-mcp](https://github.com/agentmail-to/agentmail-mcp) that uses stdio transport and is distributed as an npm package (`npx agentmail-mcp`).

## Table of Contents

- [Project Structure](#project-structure)
- [Quick Start Commands](#quick-start-commands)
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
├── pnpm-lock.yaml         # Lockfile (committed, used with --frozen-lockfile)
├── tsconfig.json          # TypeScript config, outputs to ./build
├── Dockerfile             # Container build for deployment
├── src/
│   └── index.ts           # Main server implementation (Express + standard MCP SDK)
├── AGENTS.md
└── README.md
```

## Quick Start Commands

```bash
# Install dependencies
pnpm install

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

## Configuration

### API Key

This server needs an AgentMail API key to make API calls. The key is read per-request from three sources (highest to lowest priority):

1. **URL query parameter**: `http://localhost:3000/mcp?apiKey=YOUR_KEY`
2. **HTTP header**: `x-api-key: YOUR_KEY`
3. **Environment variable**: `AGENTMAIL_API_KEY`

Note: The `initialize` and `tools/list` MCP methods do not require an API key. Only `tools/call` (actually executing a tool) checks for a valid key.

**Why this design:**

- **Multi-user support**: Different users connect with different API keys via query params
- **Security**: API keys are per-request, not stored server-wide
- **Flexibility**: Users can configure at connection time without code changes

### Port

The server port is configured via the `PORT` environment variable (default: `3000`). Manufact injects this automatically during deployment.

### x402 Pay-Per-Use (Not Yet Supported)

AgentMail also supports [x402](https://docs.agentmail.to/integrations/x402), an open payment protocol that lets agents pay for API usage directly over HTTP without API keys. This server currently only supports API key authentication. x402 support would require passing an `x402` client to `AgentMailClient` instead of an `apiKey`, which is a potential future addition.

## Architecture

### How It Works

`src/index.ts` is the only source file. It defines a `createMcpServer(apiKey)` function that:

1. Creates an `McpServer` instance (standard MCP SDK)
2. Initializes an `AgentMailClient` with the provided API key
3. Wraps it in an `AgentMailToolkit` and registers all tools

The Express server calls this function on each request to `/mcp`, then connects the MCP server to a `StreamableHTTPServerTransport` to handle the JSON-RPC message.

**All tool logic lives in the `agentmail-toolkit` npm package.** This server has zero custom tool implementations: it is purely a hosting/transport wrapper.

### Why Standard MCP SDK Instead of mcp-use Framework

We use `@modelcontextprotocol/sdk` directly instead of Manufact's `mcp-use/server` framework because:

- **No extra dependency**: Fewer moving parts, fewer things to break
- **Portability**: If we ever move off Manufact, zero code changes needed
- **Compatibility**: `agentmail-toolkit` already targets the standard MCP SDK's `McpServer.registerTool` API
- **Simplicity**: The server is a thin wrapper, it does not need the mcp-use framework's inspector, HMR, or session management features

### Key Dependencies

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | Standard MCP server SDK (McpServer, StreamableHTTPServerTransport) |
| `agentmail` | AgentMail API client |
| `agentmail-toolkit` | Provides all MCP tools (list_inboxes, send_message, etc.) |
| `express` | HTTP framework for serving the MCP endpoint |
| `zod` | Schema validation (used by MCP SDK and toolkit) |

All dependency versions are **pinned** (no `^` prefix) to prevent supply chain attacks from affecting builds.

## Concepts

### What This Server Exposes

This server registers all tools from `agentmail-toolkit`. It currently does **not** register any resources or prompts (these are MCP features that could be added in the future).

The tool registration pattern:

```typescript
const toolkit = new AgentMailToolkit(client)

for (const tool of toolkit.getTools()) {
    server.registerTool(tool.name, tool, async (args, extra) => {
        if (!apiKey) return apiKeyMessage
        return tool.callback(args, extra)
    })
}
```

### MCP Components Reference

For context, MCP servers can expose three types of components. This server only uses tools, but here is a reference for future additions:

- **Tools**: Executable functions that AI applications invoke to perform actions (e.g., send_message, list_inboxes). This is what `agentmail-toolkit` provides.
- **Resources**: Read-only data sources that give AI applications context without side effects (e.g., documentation, reference data). Not currently used.
- **Prompts**: Reusable message templates that help structure conversations (e.g., "compose an email to X about Y"). Not currently used.

### Transport

This server uses **Streamable HTTP transport** from the standard MCP SDK.

```typescript
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
res.on('close', () => transport.close())
await server.connect(transport)
await transport.handleRequest(req, res, req.body)
```

The `/mcp` endpoint handles GET (SSE connections), POST (JSON-RPC messages), and DELETE (session close) via `app.all`. `sessionIdGenerator: undefined` means stateless mode: each request is independent.

**Why stateless**: This server is a thin API proxy. All state lives in the AgentMail API backend. No session tracking is needed.

**Comparison with local server**: The [agentmail-mcp](https://github.com/agentmail-to/agentmail-mcp) package uses **stdio transport** instead, communicating via stdin/stdout when spawned as a local process by Claude Desktop, Cursor, etc.

## Development Workflow

### Testing Your Server: Three Approaches

All approaches require running `pnpm run build && pnpm run start` first.

#### MCP Inspector

Use the official MCP Inspector to test interactively:

```bash
npx @modelcontextprotocol/inspector http://localhost:3000/mcp?apiKey=YOUR_KEY
```

Opens a browser UI where you can test tools, explore capabilities, and view request/response details.

**Best for:** Quick iteration, UI testing, tool validation

#### Custom Clients

Connect any MCP client to `http://localhost:3000/mcp` with config as URL parameters:

```
http://localhost:3000/mcp?apiKey=YOUR_KEY
```

For remote testing, use a tunnel like ngrok:

```bash
ngrok http 3000
# Then connect to: https://your-ngrok-id.ngrok.io/mcp?apiKey=YOUR_KEY
```

**Best for:** Testing with Claude Desktop, Cursor, or other MCP clients

#### Direct Protocol Testing (curl)

For deep debugging or understanding the MCP protocol:

1. Initialize connection:

```bash
curl -X POST "http://localhost:3000/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"clientInfo":{"name":"test-client","version":"1.0.0"}}}'
```

2. List available tools:

```bash
curl -X POST "http://localhost:3000/mcp?apiKey=YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

3. Call a tool:

```bash
curl -X POST "http://localhost:3000/mcp?apiKey=YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_inboxes","arguments":{}}}'
```

**Best for:** Protocol debugging, understanding MCP internals, automated testing scripts

### Customizing the Server

1. **Add new tools**: Either add them to `agentmail-toolkit` (shared with the local server) or register them directly in `src/index.ts` inside `createMcpServer()`
2. **Add resources or prompts**: Register them on the `server` object inside `createMcpServer()` before returning
3. **Update toolkit tools**: Bump `agentmail-toolkit` version in `package.json`, run `pnpm install`, rebuild

## Deployment & CI/CD

This server is deployed to [Manufact Cloud](https://manufact.com). There are two deployment methods:

### Option A: CLI Deployment

```bash
# Install the mcp-use CLI
npm install -g @mcp-use/cli

# Login to Manufact
mcp-use login

# Deploy
mcp-use deploy
```

### Option B: GitHub Repo Connection

Connect your GitHub repo on [manufact.com](https://manufact.com) for automatic deployments with observability, metrics, logs, and branch-deployments.

### Post-Deployment

After deployment, your MCP server is accessible at the URL provided by Manufact (e.g., `https://your-deployment-id.deploy.mcp-use.com/mcp`).

**DNS/CNAME**: If migrating from a previous host, update your CNAME records to point to the new Manufact URL.

### Environment Variables

Set these in Manufact's dashboard:

- `PORT`: Automatically injected by Manufact
- `AGENTMAIL_API_KEY`: Optional fallback API key (users typically pass their own via query params)
- `AGENTMAIL_BASE_URL`: Optional, only if targeting a non-production AgentMail API

## Troubleshooting

### Port Issues

- Default port is **3000**
- Kill existing process: `lsof -ti:3000 | xargs kill`

### Build Issues

```bash
# Check for TypeScript errors without emitting
npx tsc --noEmit

# Clean rebuild
rm -rf build && pnpm run build
```

### Import Issues

- Ensure you're in the project root directory
- Run `pnpm install` to install dependencies
- Check that your TypeScript configuration is correct
- Verify Node.js version is 18 or higher

### TypeScript Issues

- Ensure all imports use `.js` extensions (TypeScript + ESM requirement for NodeNext module resolution)
- Check that `package.json` has `"type": "module"`

### API Key Issues

- Verify your API key is valid at [console.agentmail.to](https://console.agentmail.to)
- Check that the key is being passed correctly (query param, header, or env var)
- `initialize` and `tools/list` do not require an API key; only `tools/call` does

### Dependency Security

- All versions are pinned (no `^`) to prevent supply chain attacks
- Always audit after install: `pnpm audit`
- Use `pnpm install --frozen-lockfile` in CI/CD (the Dockerfile already does this)
- Check for unwanted transitive dependencies: `pnpm ls <package-name>`

## Resources

- **AgentMail Docs**: [docs.agentmail.to](https://docs.agentmail.to)
- **AgentMail Console**: [console.agentmail.to](https://console.agentmail.to)
- **MCP Protocol**: [modelcontextprotocol.io](https://modelcontextprotocol.io)
- **MCP TypeScript SDK**: [github.com/modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- **Manufact Cloud**: [manufact.com](https://manufact.com)
- **mcp-use CLI**: [npmjs.com/package/@mcp-use/cli](https://www.npmjs.com/package/@mcp-use/cli)
- **Local MCP Server**: [github.com/agentmail-to/agentmail-mcp](https://github.com/agentmail-to/agentmail-mcp)
