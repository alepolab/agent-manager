import type { Peer } from 'crossws'
import { providerRegistry } from '../../../utils/providers/registry'
import { cleanupPeer } from '../../../utils/providers/claudeProvider'
import type { ChatV2WebSocketMessage, NormalizedMessage } from '~/types'

export default defineWebSocketHandler({
  open(peer: Peer) {
    console.log('[Chat v2 WS] Client connected', peer.id)

    peer.send(JSON.stringify({
      type: 'connected',
    }))
  },

  async message(peer: Peer, message) {
    try {
      const msg: ChatV2WebSocketMessage = JSON.parse(message.text())

      switch (msg.type) {
        case 'start': {
          const providerName = msg.provider || 'claude'
          const provider = providerRegistry.get(providerName)

          if (!provider) {
            peer.send(JSON.stringify({
              kind: 'error',
              id: `error-${Date.now()}`,
              // A permission_response carries no sessionId - the socket's peer
              // id IS the session for this exchange, which the `||` fallback
              // already relied on.
              sessionId: peer.id,
              timestamp: new Date().toISOString(),
              content: `Provider '${providerName}' not found`,
              isError: true,
            }))
            return
          }

          // Create user message for immediate display
          // Note: We don't save the user message here - the provider will save it
          // with the correct sessionId (SDK's session_id for new sessions)
          const userMessage: NormalizedMessage = {
            kind: 'text',
            id: `user-${Date.now()}`,
            sessionId: msg.sessionId || 'pending', // Will be updated by session_created event
            timestamp: new Date().toISOString(),
            role: 'user',
            content: msg.message,
            images: msg.images,
            provider: providerName,
            metadata: {
              agentSlug: msg.agentSlug,
              workingDir: msg.workingDir,
              permissionMode: msg.permissionMode,
              outputStyleId: msg.outputStyleId,
            },
          }

          // Send user message back to client for immediate display
          // The client will update the sessionId when it receives session_created
          peer.send(JSON.stringify(userMessage))

          // Load agent instructions if agent specified
          let agentInstructions: string | undefined
          if (msg.agentSlug && provider.loadAgentInstructions) {
            const instructions = await provider.loadAgentInstructions(msg.agentSlug)
            if (instructions) {
              agentInstructions = instructions
            }
          }

          // Query provider - provider will handle saving all messages with correct sessionId
          await provider.query(
            msg.message,
            {
              sessionId: msg.sessionId,
              agentSlug: msg.agentSlug,
              agentInstructions,
              workingDir: msg.workingDir,
              permissionMode: msg.permissionMode,
              model: msg.model,
              effort: msg.effort,
              outputStyleId: msg.outputStyleId,
              images: msg.images,
              // Pass user message for provider to save with correct sessionId
              userMessage,
            },
            peer
          )

          break
        }

        case 'abort': {
          // Try to interrupt with all providers (start with default)
          const provider = providerRegistry.getDefault()
          const interrupted = await provider.interrupt(msg.sessionId)

          if (interrupted) {
            peer.send(JSON.stringify({
              kind: 'status',
              id: `status-${Date.now()}`,
              sessionId: msg.sessionId,
              timestamp: new Date().toISOString(),
              content: 'Interrupted',
            }))
          }

          break
        }

        case 'permission_response': {
          const provider = providerRegistry.getDefault()

          if (provider.respondToPermission) {
            await provider.respondToPermission(msg.permissionId, msg.decision, msg.updatedInput)

            peer.send(JSON.stringify({
              kind: 'status',
              id: `status-${Date.now()}`,
              sessionId: peer.id,
              timestamp: new Date().toISOString(),
              content: `Permission ${msg.decision === 'allow' ? 'granted' : 'denied'}`,
            }))
          } else {
            peer.send(JSON.stringify({
              kind: 'error',
              id: `error-${Date.now()}`,
              sessionId: peer.id,
              timestamp: new Date().toISOString(),
              content: `Provider does not support permissions`,
              isError: true,
            }))
          }

          break
        }

        case 'interactive_response': {
          // Handle interactive prompt responses (future feature)
          console.log('[Chat v2 WS] Interactive response:', msg.promptId, msg.value)
          break
        }

        default: {
          peer.send(JSON.stringify({
            kind: 'error',
            id: `error-${Date.now()}`,
            sessionId: peer.id,
            timestamp: new Date().toISOString(),
            content: `Unknown message type: ${(msg as any).type}`,
            isError: true,
          }))
        }
      }
    } catch (error: any) {
      console.error('[Chat v2 WS] Error handling message:', error)
      peer.send(JSON.stringify({
        kind: 'error',
        id: `error-${Date.now()}`,
        sessionId: peer.id,
        timestamp: new Date().toISOString(),
        content: error.message || 'Internal server error',
        isError: true,
      }))
    }
  },

  async close(peer: Peer) {
    console.log('[Chat v2 WS] Client disconnected', peer.id)
    await cleanupPeer(peer.id)
  },

  error(peer: Peer, error) {
    console.error('[Chat v2 WS] Error:', error)
  },
})
