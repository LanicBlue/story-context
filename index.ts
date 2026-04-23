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
  if (!config.summaryEnabled) return undefined;

  // Try runtime mode first (use OpenClaw's configured model/provider)
  if (config.summaryMode === "runtime" && api.complete) {
    const model = config.summaryModel || "";
    return new RuntimeSummarizer(api.complete, model, config.summaryCustomInstructions);
  }

  // Fallback to HTTP mode (Ollama, LM Studio, etc.)
  return new HttpSummarizer({
    baseUrl: config.summaryBaseUrl,
    model: config.summaryModel || "qwen2.5",
    apiKey: config.summaryApiKey,
    timeoutMs: config.summaryTimeoutMs,
    customInstructions: config.summaryCustomInstructions,
  });
}

const smartContextPlugin = {
  id: "story-context",
  name: "Smart Context Engine",
  description:
    "Dedup-aware sliding window context engine with LLM summarization for OpenClaw",

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
