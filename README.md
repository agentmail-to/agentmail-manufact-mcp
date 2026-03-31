# AgentMail MCP Server (Remote)

Remote MCP server for the AgentMail API, deployed via [Manufact](https://manufact.com).

## Setup

### Local Development

```bash
pnpm install
pnpm run build
pnpm run start
```

The server runs at `http://localhost:3000/mcp`.

### Configuration

Pass your API key as a URL query parameter:

```
http://localhost:3000/mcp?apiKey=YOUR_API_KEY
```

Or set the `AGENTMAIL_API_KEY` environment variable, or pass an `x-api-key` header.

### Deployment

This server is deployed to [Manufact](https://manufact.com) via GitHub App integration. Push to `main` triggers automatic deployment.

## Related

- [agentmail-mcp](https://github.com/agentmail-to/agentmail-mcp): Local MCP server (stdio transport, via `npx agentmail-mcp`)
- [AgentMail Docs](https://docs.agentmail.to)
