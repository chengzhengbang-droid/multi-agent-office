import type {
  AgentDefinition,
  CompiledContext,
  ThreadMessage,
} from "./types.js";

export interface ContextCompilerInput {
  agent: AgentDefinition;
  incoming: ThreadMessage;
  threadMessages: ThreadMessage[];
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
    this.maxMessages = options.maxMessages ?? 12;
    this.maxCharacters = options.maxCharacters ?? 24_000;
  }

  public async compile(input: ContextCompilerInput): Promise<CompiledContext> {
    const candidates = input.threadMessages
      .filter((message) => message.id !== input.incoming.id)
      .slice(-this.maxMessages);

    const selected: ThreadMessage[] = [];
    let usedCharacters = 0;

    for (const message of candidates.reverse()) {
      if (usedCharacters + message.content.length > this.maxCharacters) {
        continue;
      }
      selected.push(message);
      usedCharacters += message.content.length;
    }

    return {
      incoming: input.incoming,
      recentMessages: selected.reverse(),
    };
  }
}
