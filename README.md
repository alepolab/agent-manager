<p align="center">
  <img src="docs/assets/header.png" alt="agents-ui — visualize your Claude Code" width="720" />
</p>

<h1 align="center">Claude Code CLI UI <br/>
  (aka Claude Code Agents Management Studio)</h1>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &middot;
  <a href="https://github.com/Ngxba/claude-code-agents-ui/blob/main/CONTRIBUTING.md"><strong>Contributing</strong></a> &middot;
  <a href="https://github.com/Ngxba/claude-code-agents-ui"><strong>GitHub</strong></a>
</p>

<p align="center">
  <a href="https://github.com/Ngxba/claude-code-agents-ui/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="https://github.com/Ngxba/claude-code-agents-ui/stargazers"><img src="https://img.shields.io/github/stars/Ngxba/claude-code-agents-ui" alt="Stars" /></a>
</p>

<br/>

<div align="center">
  <video src="https://github.com/user-attachments/assets/734d933e-7a4f-48c0-ac0b-daaec05e5e3c" width="800" controls></video>
</div>

<br/>

## Run configuration

Environment variables read by the server. All optional; each feature is off until its variable is set.

| Variable | Effect |
|---|---|
| `AGENT_RUN_MAX_MINUTES`, `AGENT_RUN_MAX_TOKENS` | Per-run caps checked between steps (defaults 180 and 8,000,000). A run over its cap fails with the reason. |
| `AGENT_GH_TOKEN` | Becomes `GH_TOKEN` for every agent call, so pushes and PRs carry a bot identity instead of the server user's. |
| `SLACK_WEBHOOK_URL` | Incoming webhook that receives one message per run transition to paused, completed, failed, stopped or interrupted. `AGENT_MANAGER_URL` sets the link base. |
| `CI_POLL_SECONDS`, `CI_POLLER_DISABLED` | The poller that records `gh pr checks` outcomes on completed runs (default every 60s). |
| `JIRA_TICKET_SOURCE=cli` | Watches read tickets through the authenticated `jira` CLI instead of the file stub. A manual run started with a bare ticket key is expanded to the ticket text whenever the CLI can serve it. |
| `AGENT_REGISTRY_PATH` | Overrides the product registry, otherwise read from the installed alepo-engineering plugin. |

`bin/am.mjs` drives runs from a terminal: `am runs`, `am status <id>`, `am start <workflow> "<ticket>"`, `am restart <id> [step] --note "..."`, `am clone <id>`, `am stop <id>`.

## What is agents-ui?

# Open-source visual orchestration for Claude Code

**If Claude Code is the _engine_, agents-ui is the _dashboard_**

agents-ui is a Nuxt 3-based visual dashboard for managing Claude Code agents, commands, skills, workflows, and plugins. It provides a GUI layer on top of the `~/.claude` directory, allowing users to create, edit, and organize their Claude Code configuration without touching markdown files directly.

It looks like a studio — but under the hood it has relationship graphs, real-time metrics, visual workflow builders, and terminal emulation.

**Manage your agents visually, not through scattered markdown.**

|        | Step            | Example                                                            |
| ------ | --------------- | ------------------------------------------------------------------ |
| **01** | Define the agent | Create a "Senior Frontend" agent with specific instructions.       |
| **02** | Build skills    | Import or create custom tools and capabilities for your team.      |
| **03** | Run & Monitor   | Execute commands in the terminal and watch real-time metrics.      |

<br/>

> **COMING SOON: Desktop App** — Run agents-ui as a standalone desktop application for even tighter integration with your local environment.

<br/>

<div align="center">
<table>
  <tr>
    <td align="center"><strong>Works<br/>with</strong></td>
    <td align="center"><img src="https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/anthropic.svg" width="32" alt="Claude Code" /><br/><sub>Claude Code</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/anthropic.svg" width="32" alt="Anthropic SDK" /><br/><sub>Anthropic SDK</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/bun.svg" width="32" alt="Bun" /><br/><sub>Bun</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/nuxt.svg" width="32" alt="Nuxt 3" /><br/><sub>Nuxt 3</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/tailwindcss.svg" width="32" alt="Tailwind CSS" /><br/><sub>Tailwind CSS</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/gnometerminal.svg" width="32" alt="Bash" /><br/><sub>Bash</sub></td>
  </tr>
</table>

<em>If it's in your `.claude` folder, it's here.</em>

</div>

<br/>

## agents-ui is right for you if

- ✅ You want a **visual way to manage** your Claude Code agents
- ✅ You **coordinate many different commands and skills** and want to see how they connect
- ✅ You want to **monitor token usage and costs** in real-time
- ✅ You want to **build multi-step workflows** visually instead of manually chaining agents
- ✅ You want a **clean, real-time chat interface** for testing agent behaviors
- ✅ You find editing scattered `.claude` files **cumbersome or disorganized**

<br/>

## Features

<table>
<tr>
<td align="center" width="33%">
<h3>🤖 Agent Management</h3>
Visual editor for <code>.claude/agents/*.md</code>. Configure models, instructions, and memory.
</td>
<td align="center" width="33%">
<h3>🔗 Relationship Graph</h3>
Visual map of agents, commands, and skills. Identify dependencies and gaps at a glance.
</td>
<td align="center" width="33%">
<h3>⚡ Command Builder</h3>
Create reusable slash commands with argument hints and safety configurations.
</td>
</tr>
<tr>
<td align="center">
<h3>🧪 Agent Studio</h3>
Iterate faster with live testing. Inspect execution and refine prompts in real time.
</td>
<td align="center">
<h3>🔄 Workflow Builder</h3>
Build multi-step AI pipelines visually. Chain agents and control execution order.
</td>
<td align="center">
<h3>🧠 Skill Management</h3>
Centralized skill management. Import skills from GitHub or create custom ones.
</td>
</tr>
<tr>
<td align="center">
<h3>🖥️ CLI Terminal</h3>
Full PTY terminal emulator with integrated context monitoring and WebSocket streaming.
</td>
<td align="center">
<h3>📊 Real-time Metrics</h3>
Live token counting, cost tracking, and file system change monitoring.
</td>
<td align="center">
<h3>🌍 Explore & Templates</h3>
Browse and import community agent templates and marketplace resources instantly.
</td>
</tr>
</table>

<br/>

## Problems agents-ui solves

| Without agents-ui                                                                                                                     | With agents-ui                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| ❌ You edit scattered markdown files in `~/.claude` and lose track of which agent uses which skill.                                    | ✅ A single visual control layer shows you exactly how everything connects with relationship graphs.                                  |
| ❌ You have no visibility into how many tokens you're using or what the actual cost of a session is until it's over.                  | ✅ Real-time metrics surface token usage and costs as they happen, helping you stay within budget.                                     |
| ❌ Chaining agents together requires manual coordination and jumping between multiple terminal windows.                               | ✅ Visual workflow builder lets you chain agents into pipelines and inspect intermediate results easily.                               |
| ❌ Testing a new prompt or agent behavior requires re-running CLI commands and manually parsing output.                               | ✅ Agent Studio provides a clean chat interface with SSE streaming for instant feedback and debugging.                                |
| ❌ Finding and importing community skills is a manual process of cloning repos and copying files.                                     | ✅ GitHub import flow lets you point to a repo and choose which skills to import directly into your setup.                            |

<br/>

## Why agents-ui is special

agents-ui handles the visual orchestration of Claude Code correctly.

|                                   |                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Real-time Context Monitoring.** | Tracks tokens, costs, file changes, and tool calls as they happen in your terminal sessions.                  |
| **Visual Relationship Mapping.**  | Automatically detects links between agents, commands, and skills to build a live dependency graph.            |
| **Native Claude Code Integration.**| Built directly on top of the `@anthropic-ai/claude-agent-sdk` for authentic agent interactions.              |
| **SSE-powered Agent Studio.**     | Streams agent thinking, tool use, and text deltas for a responsive, real-time testing experience.            |
| **Workflow Visualization.**       | Models complex AI pipelines as nodes and edges, making multi-step processes easy to understand.               |
| **Zero-Config Data Layer.**       | Directly reads and writes to your existing `~/.claude` directory—no new database or account required.         |

<br/>

## What agents-ui is not

|                              |                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Not a replacement for CLI.**| It's a GUI *companion*. You can still use the Claude CLI alongside it whenever you want.                             |
| **Not an LLM provider.**     | We don't provide models. agents-ui uses your existing Anthropic API keys and Claude Code setup.                      |
| **Not a general-purpose IDE.**| It's specifically optimized for the Claude Code ecosystem and `.claude` configurations.                              |
| **Not a hosted service.**     | agents-ui runs locally on your machine for maximum privacy and access to your local files.                           |

<br/>

## Quickstart

Open source. Self-hosted. Use your local Claude Code setup.

```bash
git clone https://github.com/Ngxba/claude-code-agents-ui.git
cd claude-code-agents-ui
bun install
bun run dev
```

Open **http://localhost:3000** — agents-ui will automatically load your `~/.claude` setup.

> **Requirements:** [Bun](https://bun.sh) (recommended) or Node.js 18+

<br/>

## FAQ

**Where is my data stored?**
Everything is stored in your standard `~/.claude` directory. agents-ui reads and writes directly to those files.

**Do I need a separate Anthropic API key?**
agents-ui uses the same environment variables as your Claude Code setup. If `anthropic` is configured in your shell, agents-ui will find it.

**Can I still use the CLI?**
Yes! agents-ui is a companion. Changes you make in the UI reflect in your `.claude` files immediately, and vice versa.

**How does the relationship graph work?**
It scans your agent, command, and skill files for references to each other (like `agent:` in frontmatter or `/command` in text) and builds the graph dynamically.

<br/>

## Development

```bash
bun run dev          # Start dev server (Nuxt + SSE)
bun run build        # Build for production
bun run preview      # Preview production build
bun run typecheck    # Run TypeScript type checking
```

<br/>

## Roadmap

- ✅ Visual Agent Editor
- ✅ Relationship Graph
- ✅ Workflow Builder
- ✅ GitHub Skill Import
- ✅ Real-time Metrics (Tokens/Cost)
- ✅ Integrated Terminal Emulator
- ✅ Chat-based Agent Studio
- ✅ Marketplace & Plugin System
- ⚪ Desktop Application
- ⚪ Artifacts & Deployments
- ⚪ Multiple Session History

<br/>

## Community & Contributing

We welcome contributions! See the [CONTRIBUTING.md](CONTRIBUTING.md) for details.

- [GitHub Issues](https://github.com/Ngxba/claude-code-agents-ui/issues) — bugs and feature requests
- [GitHub Discussions](https://github.com/Ngxba/claude-code-agents-ui/discussions) — ideas and RFC

<br/>

## Star History

[![Star History Chart](https://api.star-history.com/image?repos=Ngxba/claude-code-agents-ui&type=date&legend=top-left)](https://star-history.com/#Ngxba/claude-code-agents-ui&Date)

<br/>

## License

MIT &copy; 2026 Ngxba, agents-ui contributors

<br/>

---

<p align="center">
  <img src="docs/assets/footer.png" alt="" width="720" />
</p>

<p align="center">
  <sub>Open source under MIT. Built for developers who want to see their agents in action.</sub>
</p>
