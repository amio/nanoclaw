export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  agentType?: string;
  secrets?: Record<string, string>;
}

export interface QueryResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}

export interface AgentDriver {
  run(
    prompt: string,
    sessionId: string | undefined,
    resumeAt: string | undefined
  ): Promise<QueryResult>;
}
