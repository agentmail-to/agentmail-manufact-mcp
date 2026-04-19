import { AgentMailClient } from 'agentmail'
import { AgentMailToolkit } from 'agentmail-toolkit/mcp'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import express from 'express'

const PORT = parseInt(process.env.PORT || '3000', 10)
const DOCS_URL = 'https://docs.agentmail.to/integrations/mcp'

const app = express()
app.use(express.json())

function createMcpServer(apiKey: string | undefined) {
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

    return server
}

const mcpHandler: express.RequestHandler = async (req, res) => {
    // Browser GET requests: redirect to docs instead of showing raw MCP error
    if (req.method === 'GET' && req.headers.accept?.includes('text/html')) {
        return res.redirect(302, DOCS_URL)
    }

    try {
        const apiKey = (req.query.apiKey as string) || (req.headers['x-api-key'] as string) || process.env.AGENTMAIL_API_KEY

        const server = createMcpServer(apiKey)
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

        res.on('close', () => transport.close())
        await server.connect(transport)
        await transport.handleRequest(req, res, req.body)
    } catch (error) {
        console.error('MCP request error:', error)
        if (!res.headersSent) {
            res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
        }
    }
}

app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
})

app.all('/', mcpHandler)
app.all('/mcp', mcpHandler)

app.listen(PORT, () => {
    console.log(`AgentMail MCP server running on port ${PORT}`)
    console.log(`MCP endpoints: http://localhost:${PORT}/ and http://localhost:${PORT}/mcp`)
})
