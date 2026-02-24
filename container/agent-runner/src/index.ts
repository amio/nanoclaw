/**
 * NanoClaw Agent Runner
 * Multi-driver agent execution orchestrator
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ContainerInput, AgentDriver } from './driver.js';
import { ClaudeDriver } from './claude-driver.js';
import { OpenCodeDriver } from './opencode-driver.js';
import {
  readStdin,
  writeOutput,
  log,
  drainIpcInput,
  waitForIpcMessage,
  IPC_INPUT_DIR,
  IPC_INPUT_CLOSE_SENTINEL
} from './utils.js';

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder} (Agent: ${containerInput.agentType || 'claude'})`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK/Driver only.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Select driver
  let driver: AgentDriver;
  const agentType = containerInput.agentType || 'claude';

  if (agentType === 'opencode') {
    driver = new OpenCodeDriver(containerInput, sdkEnv, mcpServerPath);
  } else {
    // Default to Claude
    driver = new ClaudeDriver(containerInput, sdkEnv, mcpServerPath);
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run driver → wait for IPC message → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query loop (agent: ${agentType}, session: ${sessionId || 'new'})...`);

      const queryResult = await driver.run(prompt, sessionId, resumeAt);

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
