import { SmartContextEngine } from "./src/engine.js";
import { RuntimeSummarizer, HttpSummarizer } from "./src/summarizer.js";
import { resolveConfig } from "./src/config.js";
import type { Summarizer } from "./src/types.js";

// Minimal type for the plugin API surface.
// At runtime openclaw provides the full implementation.
type PluginApi = {
  pluginConfig?: Record<string, unknown>;
  registerContextEngine: (id: string, factory: () => unknown) => void;
  complete?: (params: {
    provider?: string;
    model?: string;
    apiKey?: string;
    messages: Array<{ role: string; content: unknown }>;
    system?: string;
    maxTokens: number;
  }) => Promise<{ content: unknown[]; error?: { message?: string } }>;
};

function createSummarizer(api: PluginApi, rawConfig: Record<string, unknown>): Summarizer | undefined {
  const config = resolveConfig(rawConfig);
  if (!config.llmEnabled) return undefined;

  // Try runtime mode first (use OpenClaw's configured model/provider)
  if (config.llmMode === "runtime" && api.complete) {
    const model = config.llmModel || "";
    return new RuntimeSummarizer(api.complete, model);
  }

  // Fallback to HTTP mode (Ollama, LM Studio, etc.)
  return new HttpSummarizer({
    baseUrl: config.llmBaseUrl,
    model: config.llmModel || "qwen2.5",
    apiKey: config.llmApiKey,
    timeoutMs: config.llmTimeoutMs,
  });
}

const smartContextPlugin = {
  id: "story-context",
  name: "Smart Context Engine",
  description:
    "Story-driven context engine with budget-aware message assembly for OpenClaw",

  configSchema: {
    parse(value: unknown) {
      const raw =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      return raw;
    },
  },

  register(api: PluginApi) {
    const pluginConfig =
      api.pluginConfig &&
      typeof api.pluginConfig === "object" &&
      !Array.isArray(api.pluginConfig)
        ? (api.pluginConfig as Record<string, unknown>)
        : {};

    const summarizer = createSummarizer(api, pluginConfig);

    api.registerContextEngine("story-context", () => {
      return new SmartContextEngine(pluginConfig, summarizer);
    });
  },
};

export default smartContextPlugin;
