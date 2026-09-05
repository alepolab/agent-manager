# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

agents-ui is a Nuxt 3-based visual dashboard for managing Claude Code agents, commands, skills, workflows, and plugins. It provides a GUI layer on top of the `~/.claude` directory, allowing users to create, edit, and organize their Claude Code configuration without touching markdown files directly.

## Development Commands

```bash
# Development
bun run dev          # Start dev server at http://localhost:3030
npm run dev          # Alternative with npm

# Build & Production
bun run build        # Build for production
bun run preview      # Preview production build

# Type Checking
bun run typecheck    # Run TypeScript type checking
```

## Architecture

### Frontend (Nuxt 3 + Vue 3)

**Pages** (`app/pages/`):
- `/agents` - List and manage agents
- `/agents/[slug]` - Edit individual agent
- `/commands` - List and manage commands
- `/skills` - List and manage skills
- `/workflows` - Visual workflow builder
- `/graph` - Relationship visualization
- `/explore` - Browse templates and marketplace
- `/cli` - Chat with Claude Code against the working directory
- `/runs` - Pipeline runs: status, cost, restart, clone, stop
- `/watches` - Jira queues that feed the pipeline
- `/team` - Drift against the alepo-engineering plugin, Apply team standards
- `/profile` - Per-developer Jira credentials
- `/login` - GitHub sign-in (skipped when AUTH_DISABLED=1)
- `/settings` - Global settings

**Composables** (`app/composables/`):
The app uses a centralized CRUD pattern via `useCrud.ts` which provides standard `fetchAll`, `fetchOne`, `create`, `update`, `remove` operations. Domain-specific composables wrap this:
- `useAgents.ts` - Agent CRUD operations
- `useCommands.ts` - Command CRUD operations
- `useSkills.ts` - Skill CRUD operations
- `useWorkflows.ts` - Workflow CRUD operations
- `useStudioChat.ts` - Agent Studio chat with SSE streaming
- `useGithubImports.ts` - Import skills from GitHub repos
- `useMarketplace.ts` - Browse and install plugins from marketplace
- `useUser.ts` - Signed-in developer from `/api/me`
- `useContextMonitor.ts` - Real-time context metrics tracking (tokens, cost, files, tools)

**Chat/Studio System**:
The Agent Studio (`/agents/[slug]` page with test panel) uses SSE (Server-Sent Events) for streaming responses. The backend (`server/api/chat.post.ts`) uses the `@anthropic-ai/claude-agent-sdk` to query agents and stream results back as `text_delta`, `thinking_delta`, `tool_progress` events.

### Backend (Nuxt Server API)

**File System Layer** (`server/utils/`):
- `claudeDir.ts` - Resolves `~/.claude` path (respects `CLAUDE_DIR` env var)
- `frontmatter.ts` - Parse/serialize YAML frontmatter + markdown body
- `relationships.ts` - Extract relationships between agents/commands/skills by scanning frontmatter (`agent:` field) and body text for references
- `github.ts` - Clone, scan, and import skills from GitHub repos
- `marketplace.ts` - Fetch and install plugins from marketplace sources

**API Routes** (`server/api/`):
All CRUD routes follow REST conventions:
- `GET /api/agents` - List all
- `GET /api/agents/[slug]` - Get one
- `POST /api/agents` - Create
- `PUT /api/agents/[slug]` - Update
- `DELETE /api/agents/[slug]` - Delete

Special endpoints:
- `POST /api/chat` - SSE endpoint for Agent Studio, uses `@anthropic-ai/claude-agent-sdk` to execute agents with streaming
- `GET /api/relationships` - Build graph data by extracting relationships
- `GET /api/agents/[slug]/skills` - List skills assigned to an agent
- `POST /api/github/import` - Import skills from GitHub
- `POST /api/marketplace/install` - Install plugin from marketplace

### Data Model

**Agents** (`~/.claude/agents/*.md`):
```yaml
---
name: Agent Name
description: What the agent does
model: sonnet | opus | haiku
color: "#hex"
memory: user | project | none
---

Agent instructions go here...
```

**Commands** (`~/.claude/commands/**/*.md`):
```yaml
---
name: command-name
description: What the command does
argument-hint: "[optional args]"
allowed-tools: [Read, Write, Edit]
agent: agent-slug  # optional, link to agent
---

Command prompt goes here...
```

**Skills** (`~/.claude/skills/[name]/SKILL.md`):
```yaml
---
name: skill-name
description: What the skill does
context: when | always
agent: agent-slug  # optional, link to agent
---

Skill prompt goes here...
```

**Workflows** (`~/.claude/workflows/*.json`):
```json
{
  "name": "Workflow Name",
  "description": "Description",
  "steps": [
    { "id": "step-1", "agentSlug": "agent-name", "label": "Step label" }
  ],
  "createdAt": "ISO timestamp"
}
```

### Key Patterns

**Relationship Detection**:
The system automatically detects relationships between agents/commands/skills by:
1. Checking `agent:` frontmatter field (links command/skill → agent)
2. Scanning body text for `subagent_type: "agent-name"` patterns
3. Scanning for `/command-name` references in agent bodies
4. Matching direct mentions of agent slugs in text

**Studio Chat System**:
- Frontend uses `useStudioChat()` which streams SSE events
- Backend uses `@anthropic-ai/claude-agent-sdk`'s `query()` function
- System prompt is either the default "Agent Manager" prompt or the selected agent's instructions
- Session IDs enable conversation continuation across multiple messages
- Tool progress and thinking blocks are streamed incrementally

**GitHub Import Flow**:
1. User provides GitHub URL
2. Backend clones repo to temp dir
3. Scans for SKILL.md files (checks frontmatter for `type: skill`)
4. User selects which skills to import
5. Skills are copied to `~/.claude/skills/[name]/`
6. Import metadata stored in `~/.claude/.imports.json` for update tracking

**CLI page** (`/cli`): the chat interface (`ChatV2Interface`) against the global working directory. The former in-browser terminal, PTY sessions and context-monitor panel were removed on 2026-09-05; `useContextMonitor` survives as the chat's token and cost tracker.

---

**Claude Code Chat Mode** (`/cli` page - Chat tab):
The Chat mode provides a web-based chat interface that directly integrates with the Claude Code SDK for conversational interactions.

### Architecture

**Frontend Components** (`app/components/cli/chat/`):
- `ChatInterface.vue` - Main chat container with message list and input
- `ChatMessages.vue` - Message list renderer
- `MessageItem.vue` - Individual message component with markdown, tool rendering, thinking blocks
- `ChatInput.vue` - Textarea input with auto-resize and keyboard shortcuts

**Backend Infrastructure**:
- `server/api/chat/ws.ts` - WebSocket handler for bidirectional chat communication
- `server/utils/claudeSdk.ts` - Direct integration with `@anthropic-ai/claude-agent-sdk`
- `server/utils/messageNormalizer.ts` - Converts SDK events to unified NormalizedMessage format
- `server/utils/chatSessionStorage.ts` - JSONL-based session persistence
- `server/api/chat/sessions/` - REST endpoints for session CRUD

**Frontend Composables**:
- `useChatSessions.ts` - Session state management with message store
- `useWebSocketChat.ts` - WebSocket client with auto-reconnect and streaming handling

### Message System

**NormalizedMessage Format**:
All SDK events are normalized to a unified message type with different `kind` values:
- `text` - User or assistant text messages
- `thinking` - Extended thinking blocks (collapsible)
- `tool_use` - Tool being called with parameters
- `tool_result` - Tool execution result
- `stream_delta` - Streaming text chunks (accumulated in real-time)
- `stream_end` - Stream complete signal
- `complete` - Query finished
- `error` - Error occurred

**Message Flow**:
```
User types message
  ↓
WebSocket: { type: 'start', message, sessionId, agentSlug }
  ↓
Backend calls query() from SDK
  ↓
SDK events normalized to NormalizedMessage
  ↓
Sent via WebSocket to client
  ↓
Frontend accumulates streaming text
  ↓
Display in ChatMessages component
  ↓
Save to JSONL file (~/.claude/chat-sessions/{sessionId}.jsonl)
```

### Session Storage

**Format**: JSONL (JSON Lines)
- One message per line
- Append-only for performance
- Stored in `~/.claude/chat-sessions/{sessionId}.jsonl`

**Pagination**:
- Initial load: Last 50 messages
- "Load more" button fetches older messages
- Pagination managed by backend

### Streaming Implementation

**Buffered Updates**:
- Stream deltas accumulated in `streamingText` ref
- Real-time display with cursor animation
- Finalized to permanent message on `stream_end`

**Performance**:
- No batching (immediate display)
- Single streaming message at a time
- Auto-scroll to bottom on new messages

### UI Features

**Message Display**:
- User messages: Right-aligned, blue background
- Assistant messages: Left-aligned, markdown rendering
- Tool use: Collapsible sections with parameters/results
- Thinking blocks: Collapsed by default, expandable
- Errors: Red highlighted banners

**Input Composer**:
- Auto-resizing textarea (max 200px height)
- Enter to send, Shift+Enter for newline
- Character counter
- Disabled during streaming

**Status Indicators**:
- Connected/Disconnected badge
- "Generating..." indicator during streaming
- Animated thinking dots before text appears

### Agent Integration

**Agent-Aware Mode**:
- Agent selector in top bar
- Agent instructions passed as `systemPrompt` to SDK
- Agent slug saved with session
- Sessions linked to agents in history

**Standalone Mode**:
- No agent selection required
- Default SDK behavior
- Quicker access for ad-hoc queries

### Identity and team

`server/utils/session.ts` holds the sealed-cookie session (`authSession`, `currentUser`, `requireUser`); `server/middleware/auth.ts` rejects `/api/*` without one unless `AUTH_DISABLED=1`. `server/utils/users.ts` stores per-developer profiles with AES-256-GCM sealed tokens and builds the env a run's agents get (`envForUser`). `server/utils/teamSync.ts` compares the config directory with the plugin and templates; `server/plugins/teamSeed.ts` applies it at boot.

## Testing

When adding new features:
- Test file CRUD operations by checking files are created/updated/deleted in `~/.claude/`
- Test relationship detection by creating agents/commands with cross-references
- Test Studio chat by verifying SSE events stream correctly
- Test GitHub imports with real repos (e.g., public skill repos)
- Run the plain-node tests: `for t in scripts/test-*.mjs engineering/scripts/test-*.mjs; do node "$t" || break; done`
- A UI change is verified in the running app with agent-browser, not by the build

## Environment Variables

```bash
CLAUDE_DIR="~/.claude"  # Override default Claude config directory
```

## Component Organization

Components in `app/components/` are auto-imported with special prefixing:
- `chat/*` - Chat UI components (no prefix)
- `studio/*` - Agent Studio components (no prefix)
- `cli/*` - Chat page components (no prefix)
- Everything else - Standard component naming

## Type Definitions

All TypeScript types are centralized in `app/types/index.ts`. Key types:
- `Agent`, `Command`, `Skill`, `Workflow` - Core entities
- `Relationship` - Links between entities
- `ChatMessage`, `StreamActivity` - Studio chat
- `GithubImport`, `Plugin` - External integrations
- `ContextMetrics`, `TokenUsage`, `ToolCall` - Chat token and cost tracking
- `NormalizedMessage`, `ChatSession`, `ChatSessionSummary` - Chat mode types
- `ChatWebSocketMessage`, `ChatWebSocketEvent` - Chat WebSocket types

## Model Registry Design

All model-related data is centralized in **two canonical files**. Never inline model colors, labels, pricing, option lists, or model string comparisons elsewhere.

### Frontend — `app/utils/models.ts`

Single source of truth for all UI-facing model metadata:

```typescript
// ✅ Use these in all .vue files and app/utils/
import {
  MODEL,               // { OPUS, SONNET, HAIKU } — named constants for comparisons/defaults
  MODEL_IDS,           // ['opus', 'sonnet', 'haiku'] — canonical list for iteration
  MODEL_META,          // Full per-model metadata (label, description, colors, etc.)
  MODEL_OPTIONS,       // Options array for picker UIs (includes "Default" entry)
  MODEL_OPTIONS_COMPACT, // Compact options for toggle-button pickers
  MODEL_OPTIONS_CHAT,  // Options with { value, label, description } for chat selectors
  DEFAULT_MODEL,       // 'sonnet' — default when no model is specified
  getModelLabel,       // Human-readable label
  getModelTagline,     // One-liner ("Balanced", "Most capable", ...)
  getModelColor,       // Hex color for charts/bars
  getModelBadgeClasses, // Tailwind bg+text classes for badges
  getModelBadgeStyle,  // Inline style object (use in templates with dynamic binding)
} from '~/utils/models'
```

**Comparisons and defaults — always use constants, never raw strings:**

```typescript
// ✅ Correct
import { MODEL, DEFAULT_MODEL } from '~/utils/models'
const selectedModel = ref(DEFAULT_MODEL)           // not ref('sonnet')
if (model === MODEL.SONNET) { ... }               // not if (model === 'sonnet')
frontmatter.model = MODEL.OPUS                    // not frontmatter.model = 'opus'

// ✅ Iterating all models
import { MODEL_IDS } from '~/utils/models'
MODEL_IDS.map(id => ({ value: id, label: MODEL_META[id].label }))

// ❌ Never
const selectedModel = ref('sonnet')
if (model === 'opus') { ... }
```

Each `ModelMeta` entry contains: `label`, `tagline`, `description`, `badgeBg`, `badgeText`, `color`, `contextWindow`.

**Adding a new model**: add one entry to `MODEL`, `MODEL_IDS`, and `MODEL_META`. All downstream UI automatically picks it up.

### Server — `server/utils/models.ts`

Server-side mirror with pricing and API model IDs:

```typescript
import {
  MODEL_ALIAS_KEY,      // { OPUS, SONNET, HAIKU } — named alias key constants
  DEFAULT_MODEL_ALIAS,  // 'sonnet' — server-side default
  SERVER_MODEL_META,    // Full pricing + context window per model id
  MODEL_ALIAS,          // 'sonnet' → 'claude-sonnet-4' mapping (full ids)
  getModelPricing,      // Pricing for cost calculation
  getModelContextWindow, // Context window for utilization tracking
  resolveModelMeta,     // Resolve alias OR full id → ServerModelMeta
} from './models'       // (relative import from server/utils/)
```

```typescript
// ✅ Correct (server-side)
import { MODEL_ALIAS_KEY } from '../models'
models: Object.values(MODEL_ALIAS_KEY)   // not ['sonnet', 'opus', 'haiku']
if (model === MODEL_ALIAS_KEY.SONNET)    // not if (model === 'sonnet')
```

**Updating pricing**: edit `SERVER_MODEL_META` in `server/utils/models.ts` only.

### Design Principles

1. **One edit = one place**: Adding a model → edit `MODEL`/`MODEL_IDS`/`MODEL_META` (frontend) and `MODEL_ALIAS_KEY`/`MODEL_ALIAS`/`SERVER_MODEL_META` (server). All consumers update automatically.
2. **No raw string literals in logic**: String literals (`'sonnet'`, `'opus'`) live only in `models.ts` definitions. Every comparison and default elsewhere is a `MODEL.X` constant.
3. **No inline model data**: No hardcoded `rgba()` per model in templates. No `{ opus: '...', sonnet: '...', haiku: '...' }` spread across components.
4. **Frontend/server split**: App utils cannot be imported server-side (different module context). Each layer has its own registry file.
5. **Backwards compat**: Legacy helpers (e.g., `getFriendlyModelName` in `terminology.ts`) are kept with `@deprecated` JSDoc and delegate to the new helpers.
