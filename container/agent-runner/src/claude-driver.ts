import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { AgentDriver, ContainerInput, QueryResult } from './driver.js';
import { log, writeOutput, shouldClose, drainIpcInput } from './utils.js';

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

export class ClaudeDriver implements AgentDriver {
  constructor(
    private containerInput: ContainerInput,
    private sdkEnv: Record<string, string | undefined>,
    private mcpServerPath: string
  ) {}

  async run(
    prompt: string,
    sessionId: string | undefined,
    resumeAt: string | undefined
  ): Promise<QueryResult> {
    const stream = new MessageStream();
    stream.push(prompt);

    let ipcPolling = true;
    let closedDuringQuery = false;
    const pollIpcDuringQuery = () => {
      if (!ipcPolling) return;
      if (shouldClose()) {
        log('Close sentinel detected during query, ending stream');
        closedDuringQuery = true;
        stream.end();
        ipcPolling = false;
        return;
      }
      const messages = drainIpcInput();
      for (const text of messages) {
        log(`Piping IPC message into active query (${text.length} chars)`);
        stream.push(text);
      }
      setTimeout(pollIpcDuringQuery, 500);
    };
    setTimeout(pollIpcDuringQuery, 500);

    let newSessionId: string | undefined;
    let lastAssistantUuid: string | undefined;
    let messageCount = 0;
    let resultCount = 0;

    const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
    let globalClaudeMd: string | undefined;
    if (!this.containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
      globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
    }

    const extraDirs: string[] = [];
    const extraBase = '/workspace/extra';
    if (fs.existsSync(extraBase)) {
      for (const entry of fs.readdirSync(extraBase)) {
        const fullPath = path.join(extraBase, entry);
        if (fs.statSync(fullPath).isDirectory()) {
          extraDirs.push(fullPath);
        }
      }
    }

    for await (const message of query({
      prompt: stream,
      options: {
        cwd: '/workspace/group',
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        resume: sessionId,
        resumeSessionAt: resumeAt,
        systemPrompt: globalClaudeMd
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
          : undefined,
        allowedTools: [
          'Bash',
          'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'Task', 'TaskOutput', 'TaskStop',
          'TeamCreate', 'TeamDelete', 'SendMessage',
          'TodoWrite', 'ToolSearch', 'Skill',
          'NotebookEdit',
          'mcp__nanoclaw__*'
        ],
        env: this.sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: {
          nanoclaw: {
            command: 'node',
            args: [this.mcpServerPath],
            env: {
              NANOCLAW_CHAT_JID: this.containerInput.chatJid,
              NANOCLAW_GROUP_FOLDER: this.containerInput.groupFolder,
              NANOCLAW_IS_MAIN: this.containerInput.isMain ? '1' : '0',
            },
          },
        },
        hooks: {
          PreCompact: [{ hooks: [this.createPreCompactHook(this.containerInput.assistantName)] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [this.createSanitizeBashHook()] }],
        },
      }
    })) {
      messageCount++;
      const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
      log(`[msg #${messageCount}] type=${msgType}`);

      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
      }

      if (message.type === 'result') {
        resultCount++;
        const textResult = 'result' in message ? (message as { result?: string }).result : null;
        writeOutput({
          status: 'success',
          result: textResult || null,
          newSessionId
        });
      }
    }

    ipcPolling = false;
    log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
    return { newSessionId, lastAssistantUuid, closedDuringQuery };
  }

  private createPreCompactHook(assistantName?: string): HookCallback {
    return async (input) => {
      const preCompact = input as PreCompactHookInput;
      const transcriptPath = preCompact.transcript_path;
      const sessionId = preCompact.session_id;

      if (!transcriptPath || !fs.existsSync(transcriptPath)) return {};

      try {
        const content = fs.readFileSync(transcriptPath, 'utf-8');
        const messages = this.parseTranscript(content);
        if (messages.length === 0) return {};

        const summary = this.getSessionSummary(sessionId, transcriptPath);
        const name = summary ? this.sanitizeFilename(summary) : this.generateFallbackName();

        const conversationsDir = '/workspace/group/conversations';
        fs.mkdirSync(conversationsDir, { recursive: true });

        const date = new Date().toISOString().split('T')[0];
        const filename = `${date}-${name}.md`;
        const filePath = path.join(conversationsDir, filename);

        const markdown = this.formatTranscriptMarkdown(messages, summary, assistantName);
        fs.writeFileSync(filePath, markdown);
        log(`Archived conversation to ${filePath}`);
      } catch (err) {
        log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
      }
      return {};
    };
  }

  private createSanitizeBashHook(): HookCallback {
    const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
    return async (input) => {
      const preInput = input as PreToolUseHookInput;
      const command = (preInput.tool_input as { command?: string })?.command;
      if (!command) return {};

      const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: {
            ...(preInput.tool_input as Record<string, unknown>),
            command: unsetPrefix + command,
          },
        },
      };
    };
  }

  private getSessionSummary(sessionId: string, transcriptPath: string): string | null {
    const projectDir = path.dirname(transcriptPath);
    const indexPath = path.join(projectDir, 'sessions-index.json');
    if (!fs.existsSync(indexPath)) return null;
    try {
      const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      const entry = index.entries.find(e => e.sessionId === sessionId);
      return entry?.summary || null;
    } catch {
      return null;
    }
  }

  private sanitizeFilename(summary: string): string {
    return summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  }

  private generateFallbackName(): string {
    const time = new Date();
    return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
  }

  private parseTranscript(content: string): { role: 'user' | 'assistant'; content: string }[] {
    const messages: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user' && entry.message?.content) {
          const text = typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.map((c: any) => c.text || '').join('');
          if (text) messages.push({ role: 'user', content: text });
        } else if (entry.type === 'assistant' && entry.message?.content) {
          const text = entry.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
          if (text) messages.push({ role: 'assistant', content: text });
        }
      } catch {}
    }
    return messages;
  }

  private formatTranscriptMarkdown(messages: any[], title?: string | null, assistantName?: string): string {
    const now = new Date();
    const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${now.toLocaleString()}`, '', '---', ''];
    for (const msg of messages) {
      const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
      const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
      lines.push(`**${sender}**: ${content}`, '');
    }
    return lines.join('\n');
  }
}
