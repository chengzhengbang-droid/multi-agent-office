import {
  DefaultResourceLoader,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ModelRuntime,
  ProjectTrustStore,
  type ResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

export type ProjectTrustMode = "never" | "always";

/**
 * Upstream pi asks the user before loading project-local `.pi` extensions and
 * settings; its non-interactive modes decline by default. The workbench has no
 * prompt surface during a run, so the decision comes from configuration and
 * defaults to declining.
 */
export function resolveProjectTrustMode(
  environment: NodeJS.ProcessEnv = process.env,
): ProjectTrustMode {
  return environment.MAO_PI_PROJECT_TRUST === "always" ? "always" : "never";
}

export interface PiResources {
  loader: DefaultResourceLoader;
  settingsManager: SettingsManager;
}

/**
 * Process-wide Pi state shared by every Pi Agent.
 *
 * Upstream pi builds the model runtime and resource loader once per process.
 * Rebuilding them per run would re-read the credential store and recompile
 * every extension on each message, so they are cached here and keyed by the
 * working directory that scopes them.
 */
export class PiSharedRuntime {
  private modelRuntimePromise: Promise<ModelRuntime> | undefined;
  private readonly resources = new Map<string, Promise<PiResources>>();

  public constructor(
    private readonly trustMode: ProjectTrustMode = resolveProjectTrustMode(),
  ) {}

  public modelRuntime(): Promise<ModelRuntime> {
    this.modelRuntimePromise ??= ModelRuntime.create();
    return this.modelRuntimePromise;
  }

  public resourcesFor(cwd: string): Promise<PiResources> {
    const key = resolve(cwd);
    let pending = this.resources.get(key);
    if (!pending) {
      pending = this.loadResources(key);
      this.resources.set(key, pending);
    }
    return pending;
  }

  /** Whether project-local `.pi` resources under `cwd` are being loaded. */
  public projectTrustFor(cwd: string): boolean {
    const key = resolve(cwd);
    if (!hasTrustRequiringProjectResources(key)) return false;
    const saved = new ProjectTrustStore(getAgentDir()).get(key);
    return saved ?? this.trustMode === "always";
  }

  public dispose(): void {
    this.modelRuntimePromise = undefined;
    this.resources.clear();
  }

  private async loadResources(cwd: string): Promise<PiResources> {
    const agentDir = getAgentDir();
    const trusted = this.projectTrustFor(cwd);
    const settingsManager = SettingsManager.create(cwd, agentDir, {
      projectTrusted: trusted,
    });
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
    await loader.reload({ resolveProjectTrust: async () => trusted });
    return { loader, settingsManager };
  }
}

/**
 * Per-run view over a shared {@link DefaultResourceLoader}.
 *
 * Everything expensive (extensions, skills, packages, context files) is read
 * from the shared loader. Only the system prompt differs per Agent and per run,
 * so it is the one thing this proxy answers on its own — which also keeps two
 * Agents running concurrently in the same directory from overwriting each
 * other's prompt.
 */
export class RequestResourceLoader implements ResourceLoader {
  public constructor(
    private readonly base: DefaultResourceLoader,
    private readonly appendSystemPrompt: string,
  ) {}

  public getExtensions(): ReturnType<ResourceLoader["getExtensions"]> {
    return this.base.getExtensions();
  }

  public getSkills(): ReturnType<ResourceLoader["getSkills"]> {
    return this.base.getSkills();
  }

  public getPrompts(): ReturnType<ResourceLoader["getPrompts"]> {
    return this.base.getPrompts();
  }

  public getThemes(): ReturnType<ResourceLoader["getThemes"]> {
    return this.base.getThemes();
  }

  public getAgentsFiles(): ReturnType<ResourceLoader["getAgentsFiles"]> {
    return this.base.getAgentsFiles();
  }

  /**
   * Left to the base loader so a project `.pi/SYSTEM.md` still wins, and so pi's
   * own tool guidance survives when there is none. The collaboration protocol
   * is appended instead of replacing either.
   */
  public getSystemPrompt(): string | undefined {
    return this.base.getSystemPrompt();
  }

  public getSystemPromptSource(): ReturnType<ResourceLoader["getSystemPromptSource"]> {
    return this.base.getSystemPromptSource();
  }

  public getAppendSystemPrompt(): string[] {
    return [...this.base.getAppendSystemPrompt(), this.appendSystemPrompt];
  }

  public getAppendSystemPromptSources(): ReturnType<
    ResourceLoader["getAppendSystemPromptSources"]
  > {
    return this.base.getAppendSystemPromptSources();
  }

  public extendResources(paths: Parameters<ResourceLoader["extendResources"]>[0]): void {
    this.base.extendResources(paths);
  }

  public async reload(
    options?: Parameters<ResourceLoader["reload"]>[0],
  ): Promise<void> {
    await this.base.reload(options);
  }
}
