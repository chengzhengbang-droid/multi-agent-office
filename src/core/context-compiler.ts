import type {
  AgentDefinition,
  CompiledContext,
  Id,
  ThreadMessage,
} from "./types.js";

export interface ContextCompilerInput {
  agent: AgentDefinition;
  incoming: ThreadMessage;
  threadMessages: ThreadMessage[];
  lastDeliveredMessageId?: Id;
}

export interface ContextCompiler {
  compile(input: ContextCompilerInput): Promise<CompiledContext>;
}

export interface RecentContextCompilerOptions {
  maxMessages?: number;
  maxCharacters?: number;
}

export class RecentContextCompiler implements ContextCompiler {
  private readonly maxMessages: number;
  private readonly maxCharacters: number;

  public constructor(options: RecentContextCompilerOptions = {}) {
    this.maxMessages = options.maxMessages ?? 20;
    this.maxCharacters = options.maxCharacters ?? 24_000;
  }

  public async compile(input: ContextCompilerInput): Promise<CompiledContext> {
    const incomingIndex = input.threadMessages.findIndex(
      (message) => message.id === input.incoming.id,
    );
    const upperBound = incomingIndex >= 0 ? incomingIndex : input.threadMessages.length;
    const deliveredIndex = input.lastDeliveredMessageId
      ? input.threadMessages.findIndex(
          (message) => message.id === input.lastDeliveredMessageId,
        )
      : -1;
    const isContinuation = deliveredIndex >= 0 && deliveredIndex < upperBound;
    const allCandidates = input.threadMessages
      .slice(isContinuation ? deliveredIndex + 1 : 0, upperBound)
      .filter(
        (message) =>
          message.id !== input.incoming.id &&
          (!isContinuation ||
            message.sender.type !== "agent" ||
            message.sender.id !== input.agent.id),
      );
    const candidates = isContinuation
      ? allCandidates
      : allCandidates.slice(-this.maxMessages);

    const selected: ThreadMessage[] = [];
    let usedCharacters = 0;
    for (const message of [...candidates].reverse()) {
      if (selected.length >= this.maxMessages) break;
      if (usedCharacters + message.content.length > this.maxCharacters) continue;
      selected.push(message);
      usedCharacters += message.content.length;
    }

    return {
      incoming: input.incoming,
      recentMessages: selected.reverse(),
      deliveryCursor: input.incoming.id,
      truncated: selected.length < allCandidates.length,
    };
  }
}
