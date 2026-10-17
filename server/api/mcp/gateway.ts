import { toWebRequest } from 'h3'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { currentRole, requireUser, authDisabled } from '../../utils/session.ts'
import { createGateway } from '../../utils/mcpGateway.ts'
import { capabilitiesFor } from '../../../shared/types/role.ts'

/**
 * The alepo-mcp gateway over MCP Streamable HTTP: `POST /api/mcp/gateway`.
 *
 * Stateless, one transport and one McpServer per request: a Claude Code
 * session or a sandbox runner sends `initialize` and then each tool call as its
 * own POST, which is what the stateless mode of the transport is for. Nothing
 * is kept between requests here, so a restart loses nothing and two instances
 * behind one address need no shared session table. Streaming is not used
 * (`enableJsonResponse`): every tool answers in one JSON body.
 *
 * Authentication is the instance's own: the `/api/*` middleware has already
 * refused an anonymous call, and a bearer `AGENT_MANAGER_API_TOKEN` acts as the
 * developer configured beside it (session.ts). The caller's role capabilities
 * travel into the gateway so the three writing tools can refuse a role that
 * could not do the same thing through the UI.
 *
 * No GET: this gateway sends no server-initiated notifications, and the
 * transport answers a GET with 405 itself.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const via = /^Bearer /.test(getRequestHeader(event, 'authorization') ?? '') ? 'api-token' : 'session'
  const role = await currentRole(event)
  const server = createGateway({
    caller: { login: user.login, via, capabilities: authDisabled() ? undefined : capabilitiesFor(role) },
  })
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(toWebRequest(event))
  } finally {
    // Close after the response has been produced; the transport has no
    // connection to keep in stateless mode.
    void server.close().catch(() => {})
  }
})
