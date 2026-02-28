import { spawn } from 'child_process';
import { AgentDriver, ContainerInput, QueryResult } from './driver.js';
import { log, writeOutput } from './utils.js';

export class OpenCodeDriver implements AgentDriver {
  constructor(
    private containerInput: ContainerInput,
    private sdkEnv: Record<string, string | undefined>,
    private mcpServerPath: string
  ) {}

  async run(
    prompt: string,
    sessionId: string | undefined,
    _resumeAt: string | undefined
  ): Promise<QueryResult> {
    return new Promise((resolve) => {
      log(`Starting OpenCode run (session: ${sessionId || 'new'})...`);

      const args = ['run', prompt];
      if (sessionId) {
        args.push('--session', sessionId);
      }

      // Add NanoClaw MCP server
      // OpenCode supports multiple --mcp flags
      args.push('--mcp', `node ${this.mcpServerPath}`);

      const proc = spawn('opencode', args, {
        env: {
          ...this.sdkEnv,
          NANOCLAW_CHAT_JID: this.containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: this.containerInput.groupFolder,
          NANOCLAW_IS_MAIN: this.containerInput.isMain ? '1' : '0',
        },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        // Log stderr to container stderr for debugging
        process.stderr.write(data);
      });

      proc.on('close', (code) => {
        log(`OpenCode exited with code ${code}`);

        // In opencode, session ID might be in the output or we can try to find the latest session.
        // For a first implementation, we'll try to extract it if possible,
        // but session persistence is mostly handled by opencode's own storage.
        const newSessionId = sessionId; // Fallback

        writeOutput({
          status: code === 0 ? 'success' : 'error',
          result: stdout || null,
          newSessionId: newSessionId,
          error: code !== 0 ? stderr : undefined
        });

        resolve({
          newSessionId: newSessionId,
          closedDuringQuery: false,
        });
      });

      proc.on('error', (err) => {
        log(`Failed to spawn OpenCode: ${err.message}`);
        writeOutput({
          status: 'error',
          result: null,
          error: err.message
        });
        resolve({
          closedDuringQuery: false
        });
      });
    });
  }
}
