export const API_PROVIDER_PRESETS = [
  {
    id: "zai-coding-cn",
    label: "Z.AI 中国区",
    description: "智谱 Coding Plan，中国大陆用户推荐",
    envKey: "ZAI_CODING_CN_API_KEY",
    model: "glm-5.2",
    keyPlaceholder: "请输入 Z.AI Coding Plan API Key",
  },
  {
    id: "zai",
    label: "Z.AI 全球版",
    description: "Z.AI 国际站 API",
    envKey: "ZAI_API_KEY",
    model: "glm-5.2",
    keyPlaceholder: "请输入 Z.AI API Key",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "使用 DeepSeek 官方 API，默认选择高性价比 Flash 模型",
    envKey: "DEEPSEEK_API_KEY",
    model: "deepseek-v4-flash",
    keyPlaceholder: "请输入 DeepSeek API Key",
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "使用 OpenAI API Key 调用模型",
    envKey: "OPENAI_API_KEY",
    model: "gpt-5.5",
    keyPlaceholder: "sk-...",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    description: "使用 Anthropic API Key 调用 Claude",
    envKey: "ANTHROPIC_API_KEY",
    model: "claude-sonnet-5",
    keyPlaceholder: "sk-ant-...",
  },
  {
    id: "google",
    label: "Google Gemini",
    description: "使用 Gemini API Key 调用模型",
    envKey: "GEMINI_API_KEY",
    model: "gemini-3.6-flash",
    keyPlaceholder: "请输入 Gemini API Key",
  },
] as const;

export type ApiProviderId = (typeof API_PROVIDER_PRESETS)[number]["id"];

export function findApiProvider(id: string) {
  return API_PROVIDER_PRESETS.find((provider) => provider.id === id);
}
