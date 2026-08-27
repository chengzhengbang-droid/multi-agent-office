/**
 * Providers the workbench can configure on its own.
 *
 * Pi resolves credentials from `auth.json` first and environment variables
 * second, so a provider is usable from this app as soon as the app can write
 * the environment variable pi reads for it. The table therefore mirrors pi's
 * own `env-api-keys` map: every entry here is a provider whose API Key the user
 * can paste into the first-run page or the roster editor, instead of leaving
 * the app to run `pi` in a terminal.
 *
 * `featured` entries are the ones the first-run page shows without expanding;
 * the rest stay one click away. Third-party and self-hosted deployments are not
 * listed here at all — those are user-defined and live in `custom-providers.ts`.
 */
export interface ApiProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Environment variable pi reads for this provider's API key. */
  readonly envKey: string;
  /** Default model for a new Agent on this provider; must exist in pi's catalog. */
  readonly model: string;
  readonly keyPlaceholder: string;
  /** Offered on the first-run page before the full list is expanded. */
  readonly featured?: boolean;
}

export const API_PROVIDER_PRESETS = [
  {
    id: "zai-coding-cn",
    label: "Z.AI 中国区",
    description: "智谱 Coding Plan，中国大陆用户推荐",
    envKey: "ZAI_CODING_CN_API_KEY",
    model: "glm-5.2",
    keyPlaceholder: "请输入 Z.AI Coding Plan API Key",
    featured: true,
  },
  {
    id: "zai",
    label: "Z.AI 全球版",
    description: "Z.AI 国际站 API",
    envKey: "ZAI_API_KEY",
    model: "glm-5.2",
    keyPlaceholder: "请输入 Z.AI API Key",
    featured: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "使用 DeepSeek 官方 API，默认选择高性价比 Flash 模型",
    envKey: "DEEPSEEK_API_KEY",
    model: "deepseek-v4-flash",
    keyPlaceholder: "请输入 DeepSeek API Key",
    featured: true,
  },
  {
    id: "moonshotai-cn",
    label: "Kimi 中国区开放平台",
    description: "api.moonshot.cn/v1，使用 Moonshot 开放平台 Key",
    envKey: "MOONSHOT_API_KEY",
    model: "kimi-k3",
    keyPlaceholder: "请输入 Moonshot API Key",
    featured: true,
  },
  {
    id: "moonshotai",
    label: "Kimi 全球版开放平台",
    description: "api.moonshot.ai/v1，使用 Moonshot 国际站 Key",
    envKey: "MOONSHOT_API_KEY",
    model: "kimi-k3",
    keyPlaceholder: "请输入 Moonshot API Key",
  },
  {
    id: "kimi-coding",
    label: "Kimi For Coding",
    description: "api.kimi.com/coding 编程订阅，不与 Moonshot 开放平台 Key 混用",
    envKey: "KIMI_API_KEY",
    model: "kimi-for-coding",
    keyPlaceholder: "请输入 Kimi For Coding API Key",
  },
  {
    id: "qwen-token-plan-cn",
    label: "通义千问 Token Plan 中国区",
    description: "阿里云百炼 Token 套餐（中国大陆）",
    envKey: "QWEN_TOKEN_PLAN_CN_API_KEY",
    model: "qwen3.7-max",
    keyPlaceholder: "请输入 Qwen Token Plan API Key",
    featured: true,
  },
  {
    id: "qwen-token-plan",
    label: "通义千问 Token Plan",
    description: "阿里云百炼 Token 套餐（国际站）",
    envKey: "QWEN_TOKEN_PLAN_API_KEY",
    model: "qwen3.7-max",
    keyPlaceholder: "请输入 Qwen Token Plan API Key",
  },
  {
    id: "qwen-token-plan-individual",
    label: "通义千问 Token Plan 个人版",
    description: "阿里云百炼个人套餐，模型清单较少",
    envKey: "QWEN_TOKEN_PLAN_API_KEY",
    model: "qwen3.7-max",
    keyPlaceholder: "请输入 Qwen Token Plan API Key",
  },
  {
    id: "minimax-cn",
    label: "MiniMax 中国区",
    description: "MiniMax 开放平台（中国大陆）",
    envKey: "MINIMAX_CN_API_KEY",
    model: "MiniMax-M2.7",
    keyPlaceholder: "请输入 MiniMax API Key",
  },
  {
    id: "minimax",
    label: "MiniMax 全球版",
    description: "MiniMax 开放平台国际站",
    envKey: "MINIMAX_API_KEY",
    model: "MiniMax-M2.7",
    keyPlaceholder: "请输入 MiniMax API Key",
  },
  {
    id: "xiaomi",
    label: "小米 MiMo",
    description: "小米 MiMo 开放平台",
    envKey: "XIAOMI_API_KEY",
    model: "mimo-v2.5-pro",
    keyPlaceholder: "请输入小米 MiMo API Key",
  },
  {
    id: "xiaomi-token-plan-cn",
    label: "小米 MiMo Token Plan 中国区",
    description: "小米 MiMo Token 套餐（中国大陆节点）",
    envKey: "XIAOMI_TOKEN_PLAN_CN_API_KEY",
    model: "mimo-v2.5-pro",
    keyPlaceholder: "请输入小米 MiMo Token Plan API Key",
  },
  {
    id: "xiaomi-token-plan-sgp",
    label: "小米 MiMo Token Plan 新加坡",
    description: "小米 MiMo Token 套餐（新加坡节点）",
    envKey: "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
    model: "mimo-v2.5-pro",
    keyPlaceholder: "请输入小米 MiMo Token Plan API Key",
  },
  {
    id: "xiaomi-token-plan-ams",
    label: "小米 MiMo Token Plan 阿姆斯特丹",
    description: "小米 MiMo Token 套餐（欧洲节点）",
    envKey: "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
    model: "mimo-v2.5-pro",
    keyPlaceholder: "请输入小米 MiMo Token Plan API Key",
  },
  {
    id: "ant-ling",
    label: "蚂蚁百灵 Ling",
    description: "蚂蚁集团百灵大模型",
    envKey: "ANT_LING_API_KEY",
    model: "Ling-2.6-1T",
    keyPlaceholder: "请输入百灵 API Key",
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "使用 OpenAI API Key 调用模型",
    envKey: "OPENAI_API_KEY",
    model: "gpt-5.5",
    keyPlaceholder: "sk-...",
    featured: true,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    description: "使用 Anthropic API Key 调用 Claude",
    envKey: "ANTHROPIC_API_KEY",
    model: "claude-sonnet-5",
    keyPlaceholder: "sk-ant-...",
    featured: true,
  },
  {
    id: "google",
    label: "Google Gemini",
    description: "使用 Gemini API Key 调用模型",
    envKey: "GEMINI_API_KEY",
    model: "gemini-3.6-flash",
    keyPlaceholder: "请输入 Gemini API Key",
    featured: true,
  },
  {
    id: "xai",
    label: "xAI Grok",
    description: "xAI 官方 API",
    envKey: "XAI_API_KEY",
    model: "grok-4.6",
    keyPlaceholder: "xai-...",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "一个 Key 聚合数百个模型，模型名形如 provider/model",
    envKey: "OPENROUTER_API_KEY",
    model: "anthropic/claude-sonnet-5",
    keyPlaceholder: "sk-or-...",
    featured: true,
  },
  {
    id: "vercel-ai-gateway",
    label: "Vercel AI Gateway",
    description: "Vercel 聚合网关，模型名形如 provider/model",
    envKey: "AI_GATEWAY_API_KEY",
    model: "anthropic/claude-sonnet-5",
    keyPlaceholder: "请输入 Vercel AI Gateway API Key",
  },
  {
    id: "mistral",
    label: "Mistral",
    description: "Mistral 官方 API",
    envKey: "MISTRAL_API_KEY",
    model: "mistral-medium-latest",
    keyPlaceholder: "请输入 Mistral API Key",
  },
  {
    id: "groq",
    label: "Groq",
    description: "Groq 高速推理",
    envKey: "GROQ_API_KEY",
    model: "openai/gpt-oss-120b",
    keyPlaceholder: "gsk_...",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    description: "Cerebras 高速推理",
    envKey: "CEREBRAS_API_KEY",
    model: "gpt-oss-120b",
    keyPlaceholder: "请输入 Cerebras API Key",
  },
  {
    id: "together",
    label: "Together AI",
    description: "Together 托管的开源模型",
    envKey: "TOGETHER_API_KEY",
    model: "deepseek-ai/DeepSeek-V4-Pro",
    keyPlaceholder: "请输入 Together API Key",
  },
  {
    id: "fireworks",
    label: "Fireworks",
    description: "Fireworks 托管的开源模型",
    envKey: "FIREWORKS_API_KEY",
    model: "accounts/fireworks/models/deepseek-v4-pro",
    keyPlaceholder: "请输入 Fireworks API Key",
  },
  {
    id: "baseten",
    label: "Baseten",
    description: "Baseten 托管的开源模型",
    envKey: "BASETEN_API_KEY",
    model: "deepseek-ai/DeepSeek-V4-Pro",
    keyPlaceholder: "请输入 Baseten API Key",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    description: "NVIDIA build.nvidia.com 推理服务",
    envKey: "NVIDIA_API_KEY",
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    keyPlaceholder: "nvapi-...",
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    description: "Hugging Face Inference Providers",
    envKey: "HF_TOKEN",
    model: "deepseek-ai/DeepSeek-V4-Pro",
    keyPlaceholder: "hf_...",
  },
  {
    id: "opencode",
    label: "OpenCode Zen",
    description: "OpenCode 聚合网关",
    envKey: "OPENCODE_API_KEY",
    model: "claude-sonnet-5",
    keyPlaceholder: "请输入 OpenCode API Key",
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    description: "OpenCode Go 套餐",
    envKey: "OPENCODE_API_KEY",
    model: "glm-5.2",
    keyPlaceholder: "请输入 OpenCode API Key",
  },
  {
    id: "azure-openai-responses",
    label: "Azure OpenAI",
    description: "还需按 pi 文档设置 Azure 资源地址等环境变量",
    envKey: "AZURE_OPENAI_API_KEY",
    model: "gpt-5.5",
    keyPlaceholder: "请输入 Azure OpenAI API Key",
  },
  {
    id: "amazon-bedrock",
    label: "Amazon Bedrock",
    description: "使用 Bedrock Bearer Token；IAM/Profile 方式请配置 AWS 环境变量",
    envKey: "AWS_BEARER_TOKEN_BEDROCK",
    model: "anthropic.claude-sonnet-5",
    keyPlaceholder: "请输入 Bedrock Bearer Token",
  },
  {
    id: "google-vertex",
    label: "Google Vertex AI",
    description: "使用 Vertex API Key；ADC 方式请配置 gcloud 凭据",
    envKey: "GOOGLE_CLOUD_API_KEY",
    model: "gemini-3.6-flash",
    keyPlaceholder: "请输入 Google Cloud API Key",
  },
] as const satisfies readonly ApiProviderPreset[];

export type ApiProviderId = (typeof API_PROVIDER_PRESETS)[number]["id"];

/** The same table seen through the shared shape, so optional fields read. */
const PRESETS: readonly ApiProviderPreset[] = API_PROVIDER_PRESETS;

export const FEATURED_API_PROVIDERS: readonly ApiProviderPreset[] = PRESETS.filter(
  (provider) => provider.featured,
);

export function findApiProvider(
  id: string,
): (typeof API_PROVIDER_PRESETS)[number] | undefined {
  return API_PROVIDER_PRESETS.find((provider) => provider.id === id);
}

/**
 * Every environment variable that can make a preset provider routable, keyed by
 * provider. Several providers share one variable (Moonshot cn/global, OpenCode
 * Zen/Go), which is pi's own behaviour and not a mistake here.
 */
export function providerEnvKeys(): Record<string, string[]> {
  const keys: Record<string, string[]> = {};
  for (const provider of PRESETS) {
    keys[provider.id] = [provider.envKey];
  }
  // Pi accepts either variable for Gemini.
  keys.google = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];
  return keys;
}
