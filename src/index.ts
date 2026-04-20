/**
 * AgentMail Remote MCP Server
 * ===========================
 *
 * Hosted on Manufact at https://mcp.agentmail.to.
 *
 * Auth model: dual-path, OAuth-or-API-key.
 *
 *   1. Clerk OAuth (preferred, modern clients like Claude Desktop):
 *      Client follows MCP 2025-06-18 OAuth discovery, registers itself via
 *      DCR against our Clerk instance, and arrives with an Authorization:
 *      Bearer <Clerk JWT>. We bridge that to a per-org console JWT and call
 *      the AgentMail backend with it (same path the console uses).
 *
 *   2. API key (legacy, existing Cursor users):
 *      Client passes ?apiKey=am_... or x-api-key header. We hand the key
 *      straight to AgentMailClient. No Clerk involvement.
 *
 * The two paths are checked in order. If neither is present, mcpAuthClerk
 * returns 401 + WWW-Authenticate to bootstrap the OAuth flow.
 */

import express from 'express'
import cors from 'cors'
import { clerkClient, clerkMiddleware } from '@clerk/express'
import {
    mcpAuthClerk,
    protectedResourceHandlerClerk,
    authServerMetadataHandlerClerk,
    streamableHttpHandler,
} from '@clerk/mcp-tools/express'
import { AgentMailClient } from 'agentmail'
import { AgentMailToolkit } from 'agentmail-toolkit/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { SignJWT } from 'jose'
import crypto from 'node:crypto'

// ============================================================================
// Config
// ============================================================================

const PORT = parseInt(process.env.PORT || '3000', 10)
const DOCS_URL = 'https://docs.agentmail.to/integrations/mcp'

// Where the AgentMail backend lives. Manufact env var should set this per
// deployment (staging vs prod). The previous behavior was an unset URL =
// SDK default; we keep that as the fallback.
const AGENTMAIL_API_URL = process.env.AGENTMAIL_API_URL
const AGENTMAIL_WS_URL = AGENTMAIL_API_URL?.replace('https://api.', 'wss://ws.')

const CLERK_ENABLED = Boolean(process.env.CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY)

// ============================================================================
// Console JWT signer
// (ported from agentmail-web/apps/console/app/lib/agentmail-jwt.server.ts)
//
// The AgentMail backend trusts ES256 JWTs signed by CONSOLE_JWT_PRIVATE_KEY
// with issuer=agentmail-console, audience=agentmail-api, subject=<orgId>.
// This is the same auth path the console uses every request.
//
// The env var CONSOLE_JWT_PRIVATE_KEY accepts EITHER:
//   - A raw multi-line PEM string (works for local .env files where
//     newlines are preserved)
//   - A single-line base64-encoded PEM (works for hosting platforms like
//     Manufact whose env var UI doesn't accept multi-line values)
// We auto-detect by sniffing for the PEM header.
// ============================================================================

function decodeConsoleJwtPem(envValue: string): string {
    // Raw PEM: starts with "-----BEGIN" (after possible whitespace).
    if (envValue.trimStart().startsWith('-----BEGIN')) {
        return envValue
    }
    // Otherwise treat as base64. Decode and validate the result looks like a PEM.
    let decoded: string
    try {
        decoded = Buffer.from(envValue, 'base64').toString('utf8')
    } catch (error) {
        throw new Error(`CONSOLE_JWT_PRIVATE_KEY is not raw PEM and base64 decode failed: ${error}`)
    }
    if (!decoded.trimStart().startsWith('-----BEGIN')) {
        throw new Error(
            'CONSOLE_JWT_PRIVATE_KEY does not look like raw PEM or base64-encoded PEM. ' +
                'Expected the decoded value to start with "-----BEGIN".'
        )
    }
    return decoded
}

function getConsoleJwtKeyObject() {
    const raw = process.env.CONSOLE_JWT_PRIVATE_KEY
    if (!raw) {
        throw new Error('CONSOLE_JWT_PRIVATE_KEY env var is required to use OAuth path')
    }
    const pem = decodeConsoleJwtPem(raw)
    try {
        return crypto.createPrivateKey({ key: pem, format: 'pem' })
    } catch (error) {
        throw new Error(`Failed to import CONSOLE_JWT_PRIVATE_KEY: ${error}`)
    }
}

/**
 * Sign a JWT the AgentMail backend will trust.
 *
 * @param organizationId  Either an AgentMail internal org id (normal request
 *                        path) OR a Clerk org id (bootstrap path for the
 *                        /v0/auth/internal-org lookup itself).
 */
async function signConsoleJwt(organizationId: string): Promise<string> {
    const privateKey = getConsoleJwtKeyObject()
    const now = Math.floor(Date.now() / 1000)

    return await new SignJWT({ organizationId })
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuer('agentmail-console')
        .setAudience('agentmail-api')
        .setSubject(organizationId)
        .setIssuedAt(now)
        .setExpirationTime(now + 24 * 60 * 60)
        .setJti(crypto.randomUUID())
        .sign(privateKey)
}

/**
 * Resolve AgentMail internal org id from a Clerk org id.
 * Mirrors console/app/lib/agentmail-jwt.server.ts getInternalOrganizationId.
 */
async function getInternalOrganizationId(clerkOrgId: string): Promise<string> {
    const bootstrapJwt = await signConsoleJwt(clerkOrgId)
    const apiUrl = AGENTMAIL_API_URL
    if (!apiUrl) {
        throw new Error('AGENTMAIL_API_URL env var is required to use OAuth path')
    }

    const response = await fetch(`${apiUrl}/v0/auth/internal-org`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${bootstrapJwt}` },
    })

    if (!response.ok) {
        const body = await response.text()
        throw new Error(`/v0/auth/internal-org failed: ${response.status} ${body}`)
    }

    const data = (await response.json()) as { organization_id?: string }
    if (!data.organization_id) {
        throw new Error('No organization_id in /v0/auth/internal-org response')
    }
    return data.organization_id
}

/**
 * Build an AgentMailClient backed by a console JWT for the user's first org.
 *
 * Clerk OAuth access tokens are user-scoped (no orgId), so we look up the
 * user's org memberships server-side and pick the first one. Per product
 * invariant, every user belongs to 1-2 orgs; multi-org selection is left
 * to a later iteration.
 */
async function buildClientFromClerkUser(clerkUserId: string): Promise<AgentMailClient> {
    const memberships = await clerkClient.users.getOrganizationMembershipList({
        userId: clerkUserId,
    })
    if (!memberships.data || memberships.data.length === 0) {
        throw new Error(
            `User ${clerkUserId} has no Clerk organization memberships. ` +
                `Every AgentMail user is expected to belong to at least one org.`
        )
    }
    const firstOrg = memberships.data[0]!.organization
    const meta = firstOrg.publicMetadata as Record<string, unknown>

    let internalOrgId = meta?.internalOrgId as string | undefined
    if (!internalOrgId) {
        internalOrgId = await getInternalOrganizationId(firstOrg.id)
    }

    const consoleJwt = await signConsoleJwt(internalOrgId)
    return new AgentMailClient({
        environment: AGENTMAIL_API_URL
            ? { http: AGENTMAIL_API_URL, websockets: AGENTMAIL_WS_URL || '' }
            : undefined,
        apiKey: consoleJwt,
    })
}

/**
 * Build an AgentMailClient from a raw API key (legacy path).
 */
function buildClientFromApiKey(apiKey: string): AgentMailClient {
    return new AgentMailClient({
        environment: AGENTMAIL_API_URL
            ? { http: AGENTMAIL_API_URL, websockets: AGENTMAIL_WS_URL || '' }
            : undefined,
        apiKey,
    })
}

// ============================================================================
// MCP server factory
//
// One server per request, parameterized by the auth source. We DO NOT eagerly
// build the AgentMailClient here because for tools/list we don't need it; we
// only build it inside the tool callback when the tool is actually invoked.
// ============================================================================

type AuthSource =
    | { kind: 'clerk'; clerkUserId: string }
    | { kind: 'apiKey'; apiKey: string }
    | { kind: 'none' }

function createMcpServer(auth: AuthSource): McpServer {
    const server = new McpServer({ name: 'AgentMail', version: '1.0.0' })

    // Build a placeholder client just so the toolkit can enumerate tools.
    // We swap in a real client per tool call below.
    const placeholderClient = new AgentMailClient({ apiKey: 'placeholder' })
    const toolkit = new AgentMailToolkit(placeholderClient)

    const noAuthMessage = {
        content: [
            {
                type: 'text' as const,
                text:
                    'Not authenticated. Sign in via OAuth, or provide an API key via ' +
                    '?apiKey=YOUR_KEY query param or x-api-key header. ' +
                    'Get an API key at https://console.agentmail.to.',
            },
        ],
    }

    for (const tool of toolkit.getTools()) {
        server.registerTool(tool.name, tool, async (args, extra) => {
            try {
                let client: AgentMailClient
                if (auth.kind === 'clerk') {
                    client = await buildClientFromClerkUser(auth.clerkUserId)
                } else if (auth.kind === 'apiKey') {
                    client = buildClientFromApiKey(auth.apiKey)
                } else {
                    return noAuthMessage
                }

                // Re-bind the tool's callback to our per-call client. The
                // toolkit's tools were created with the placeholder client;
                // we need to call them with the real one. We do this by
                // creating a fresh toolkit + tool for this call.
                const realToolkit = new AgentMailToolkit(client)
                const realTool = realToolkit.getTools().find((t) => t.name === tool.name)
                if (!realTool) {
                    return {
                        content: [{ type: 'text' as const, text: `Tool ${tool.name} not found in toolkit` }],
                        isError: true,
                    }
                }
                return realTool.callback(args, extra)
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                console.error(`[mcp] tool ${tool.name} failed:`, error)
                return {
                    content: [{ type: 'text' as const, text: `Error: ${message}` }],
                    isError: true,
                }
            }
        })
    }

    return server
}

// ============================================================================
// Auth detection middleware
//
// Decides which auth path a request is on, BEFORE Clerk's mcpAuthClerk gets
// to reject it. Sets req.authSource for downstream use.
//
//   1. Has ?apiKey or x-api-key or env AGENTMAIL_API_KEY  → AuthSource.apiKey
//      (skip Clerk entirely; this is the legacy fast path)
//   2. CLERK_ENABLED and request has Authorization header → run mcpAuthClerk
//      (it will validate the Clerk JWT and stash userId in authInfo)
//   3. Neither: still run mcpAuthClerk so it 401s with WWW-Authenticate,
//      bootstrapping the OAuth discovery flow
// ============================================================================

// Module augmentation: @types/express re-exports Request from
// express-serve-static-core, so the augmentation has to target the
// underlying module name, not 'express'. This is a known @types/express
// gotcha — augmenting 'express' attaches the prop to the wrong Request
// interface and tsc doesn't see it on actual req objects.
declare module 'express-serve-static-core' {
    interface Request {
        authSource?: AuthSource
    }
}

function extractApiKey(req: express.Request): string | undefined {
    const fromQuery = req.query.apiKey as string | undefined
    const fromHeader = req.headers['x-api-key'] as string | undefined
    const fromEnv = process.env.AGENTMAIL_API_KEY
    return fromQuery || fromHeader || fromEnv
}

const authRouter: express.RequestHandler = async (req, res, next) => {
    const apiKey = extractApiKey(req)
    if (apiKey) {
        req.authSource = { kind: 'apiKey', apiKey }
        return next()
    }

    // No API key. If Clerk is configured, hand off to mcpAuthClerk for OAuth.
    if (CLERK_ENABLED) {
        return mcpAuthClerk(req, res, (err) => {
            if (err) return next(err)
            // mcpAuthClerk attaches authInfo to req via the MCP SDK's
            // streamableHttpHandler convention. The userId is also visible
            // through Clerk's req.auth() helper because clerkMiddleware ran.
            const auth = (req as unknown as { auth?: () => { userId?: string | null } }).auth?.()
            const userId = auth?.userId
            if (userId) {
                req.authSource = { kind: 'clerk', clerkUserId: userId }
            } else {
                req.authSource = { kind: 'none' }
            }
            next()
        })
    }

    // No API key, no Clerk. Tools will return the noAuthMessage when called.
    req.authSource = { kind: 'none' }
    next()
}

// ============================================================================
// Express app
// ============================================================================

const app = express()

app.use(cors({ exposedHeaders: ['WWW-Authenticate'] }))
if (CLERK_ENABLED) {
    app.use(clerkMiddleware())
}
app.use(express.json())

// MCP request handler. We don't use streamableHttpHandler here because it
// pre-binds an MCP server; we want to construct ours per-request based on
// the resolved auth source.
const mcpHandler: express.RequestHandler = async (req, res) => {
    if (req.method === 'GET' && req.headers.accept?.includes('text/html')) {
        return res.redirect(302, DOCS_URL)
    }

    try {
        const authSource = req.authSource ?? { kind: 'none' }
        const server = createMcpServer(authSource)
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on('close', () => transport.close())
        await server.connect(transport)
        await transport.handleRequest(req, res, req.body)
    } catch (error) {
        console.error('[mcp] request error:', error)
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null,
            })
        }
    }
}

// MCP endpoints. authRouter runs first to decide OAuth vs API key.
app.all('/mcp', authRouter, mcpHandler)
app.all('/', authRouter, mcpHandler)

// OAuth discovery metadata endpoints. Only mounted when Clerk is configured.
if (CLERK_ENABLED) {
    app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceHandlerClerk({ scopes_supported: ['email', 'profile'] }))
    app.get('/.well-known/oauth-protected-resource', protectedResourceHandlerClerk({ scopes_supported: ['email', 'profile'] }))
    app.get('/.well-known/oauth-authorization-server', authServerMetadataHandlerClerk)
}

app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        clerk_enabled: CLERK_ENABLED,
        agentmail_api_url: AGENTMAIL_API_URL ?? '(SDK default)',
    })
})

// ============================================================================
// Env var diagnostic (prints on boot to help debug Manufact injection issues).
// We never print full secret values — only presence + length + prefix when
// safe — so this is OK to leave in production.
// ============================================================================

function maskEnvVar(name: string): string {
    const val = process.env[name]
    if (!val) return `${name}: <missing>`
    // Safe prefix for keys that have a documented public prefix (pk_, sk_, am_).
    // For everything else we just report length.
    const firstChars = val.slice(0, 7)
    const safePrefix = /^(pk_|sk_|am_)/.test(firstChars) ? firstChars : '***'
    return `${name}: present (len=${val.length}, prefix=${safePrefix})`
}

app.listen(PORT, () => {
    console.log(`AgentMail MCP server running on port ${PORT}`)
    console.log(`MCP endpoints: http://localhost:${PORT}/ and http://localhost:${PORT}/mcp`)
    console.log(`Clerk OAuth: ${CLERK_ENABLED ? 'enabled' : 'disabled (no CLERK_* env vars)'}`)
    console.log(`AgentMail API: ${AGENTMAIL_API_URL ?? '(SDK default)'}`)
    console.log('--- env var diagnostic ---')
    console.log(maskEnvVar('CLERK_PUBLISHABLE_KEY'))
    console.log(maskEnvVar('CLERK_SECRET_KEY'))
    console.log(maskEnvVar('CONSOLE_JWT_PRIVATE_KEY'))
    console.log(maskEnvVar('AGENTMAIL_API_URL'))
    console.log(maskEnvVar('AGENTMAIL_API_KEY'))
    console.log('--------------------------')
})
