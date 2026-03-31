import { AgentMailClient } from 'agentmail'
import { AgentMailToolkit } from 'agentmail-toolkit/mcp'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import express from 'express'

const PORT = parseInt(process.env.PORT || '3000', 10)

const app = express()
app.use(express.json())

app.all('/mcp', async (req, res) => {
    const apiKey = (req.query.apiKey as string) || (req.headers['x-api-key'] as string) || process.env.AGENTMAIL_API_KEY

    const server = new McpServer({ name: 'AgentMail', version: '1.0.0' })
    const client = new AgentMailClient({ apiKey })
    const toolkit = new AgentMailToolkit(client)

    const apiKeyMessage = {
        content: [{ type: 'text' as const, text: 'Please set your API key for AgentMail. You can get it at console.agentmail.to' }],
    }

    for (const tool of toolkit.getTools()) {
        server.registerTool(tool.name, tool, async (args, extra) => {
            if (!apiKey) return apiKeyMessage
            return tool.callback(args, extra)
        })
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => transport.close())
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
})

app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
})

app.listen(PORT, () => {
    console.log(`AgentMail MCP server running on port ${PORT}`)
    console.log(`MCP endpoint: http://localhost:${PORT}/mcp`)
})
