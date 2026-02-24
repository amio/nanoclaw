# NanoClaw Research: Agent Architecture & OpenCode Integration

## 1. Current Architecture Overview

NanoClaw's architecture is built on a host-guest model with strong isolation.

### 1.1 Host-Guest Communication
- **Host**: Orchestrates message queues, manages state (SQLite), and spawns containers.
- **Guest (Agent Runner)**: A Node.js process running inside a Docker/Apple Container.
- **Protocol**:
    - **Initial Input**: JSON via `stdin` containing the prompt, session ID, secrets, and group info.
    - **Live Communication**:
        - **Inbound (User -> Agent)**: NanoClaw host writes `.json` files to `/workspace/ipc/input/`. The agent runner polls this directory.
        - **Outbound (Agent -> User)**: The agent uses a custom MCP (Model Context Protocol) server (`ipc-mcp-stdio.ts`) which writes `.json` files to `/workspace/ipc/messages/`. The host watches this directory.
        - **Command Output**: The agent runner wraps results in `---NANOCLAW_OUTPUT_START---` and `---NANOCLAW_OUTPUT_END---` markers in `stdout`.

### 1.2 SDK & CLI Integration
- Currently, NanoClaw is tightly coupled with the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`).
- The `agent-runner` specifically uses the `query` function from this SDK to manage the agent's reasoning loop, tool use, and MCP connections.
- The `Dockerfile` installs `@anthropic-ai/claude-code` globally, which provides the necessary binaries and environment.

### 1.3 Isolation & Persistence
- **Filesystem Isolation**: Each group has its own directory mounted at `/workspace/group`.
- **Session Persistence**: For Claude, sessions are stored in `/home/node/.claude`, which is mounted from a per-group directory on the host. This ensures that `claude-code` can resume conversations.
- **Secrets**: Secrets (like `ANTHROPIC_API_KEY`) are passed via `stdin` to the `agent-runner` and then to the SDK's environment, ensuring they never touch the container's disk or general process environment.

---

## 2. Why it only supports Claude Code (CloudCode)

The current limitation is due to several hardcoded dependencies and design choices:

1.  **Hardcoded SDK**: `container/agent-runner/src/index.ts` is written directly against the `claude-agent-sdk`. Switching agents would require a different way to invoke the agent's query loop.
2.  **Specific Tooling**: The `Dockerfile` only installs Anthropic's tools.
3.  **Persistence Logic**: The mounting and management of the `.claude` directory is specific to how Claude Code manages sessions.
4.  **Secrets Management**: Only `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are explicitly allowed and passed through.
5.  **MCP Integration**: While MCP is a standard, the way the `claude-agent-sdk` connects to the local `ipc-mcp-stdio.js` server is configured specifically in the `query()` options.

---

## 3. Technical Details of OpenCode

OpenCode is an open-source alternative to Claude Code with the following characteristics:
- **Written in Go**: It is a binary-first CLI tool.
- **Multi-model**: Supports various providers (OpenRouter, OpenAI, Anthropic, etc.) and local models.
- **CLI Interface**: Supports commands like `opencode run "prompt"`, `--session <id>`, and `--mcp <command>`.
- **MCP Support**: Compatible with the Model Context Protocol, meaning it can use NanoClaw's existing MCP tools.
- **Session Management**: Uses a local directory (likely `.opencode`) to store session state.

---

## 4. Proposed Solution: Generic Agent Support

To add support for OpenCode and other agents, we should move towards a "Driver" architecture in the `agent-runner`.

### 4.1 Implementation Plan

1.  **Environment Configuration**:
    - Add `AGENT_TYPE` to `.env` (values: `claude` | `opencode`).
    - Add support for generic secrets like `AGENT_API_KEY` or provider-specific ones.

2.  **Container Updates**:
    - Update `container/Dockerfile` to install the `opencode` binary.
    - Abstract `container/agent-runner/src/index.ts` to use an `AgentDriver` interface.

3.  **AgentDriver Interface**:
    ```typescript
    interface AgentDriver {
      run(prompt: string, options: AgentOptions): Promise<void>;
      // Handles the message loop, MCP connection, and IPC polling
    }
    ```

4.  **OpenCode Driver**:
    - Since OpenCode is a CLI, the `OpenCodeDriver` will `spawn` the `opencode run` process.
    - It will pass the NanoClaw MCP server via the `--mcp` flag: `opencode run --mcp "node /app/dist/ipc-mcp-stdio.js"`.
    - It will handle session persistence by mounting a `.opencode` directory similarly to how `.claude` is mounted.

5.  **Streamlined Host Changes**:
    - Modify `src/container-runner.ts` to mount the appropriate session directory based on the selected agent.
    - Pass the `AGENT_TYPE` to the container via the initial JSON input.

### 4.2 Benefits
- **Extensibility**: Adding a new agent like `aider` or `open-interpreter` just requires implementing a new driver.
- **Maintainability**: The core NanoClaw logic remains unchanged; only the "bridge" in the container evolves.
- **Flexibility**: Users can choose between official Claude Code for the best reasoning or OpenCode for privacy and model variety.
