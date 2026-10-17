
import { describe, expect, it } from "vitest";
import {
  CATALOG_ANTHROPIC_BASES,
  FEATURED_CATALOG_PROVIDERS,
  addCatalogModelRow,
  catalogModelToProviderModel,
  catalogProviderEndpoint,
  catalogProviderToCustomProvider,
  defaultReasoningParamFormat,
  isListableCatalogModel,
  isListableCatalogProvider,
  isDeepSeekV4Model,
  isRedundantModelId,
  isTrustedCatalogProvider,
  newCustomProvider,
  newCustomProviderModel,
  providerModelMatchesCatalog,
} from "../services/modelCatalog";
import type { CustomProvider, ModelCatalogModel, ModelCatalogProvider } from "../types";

const catalogModel: ModelCatalogModel = {
  name: "DeepSeek Chat",
  limit: { context: 128_000, output: 8_192 },
  reasoning: false,
  tool_call: true,
};

const deepSeekV4CatalogModel: ModelCatalogModel = {
  name: "DeepSeek V4 Pro",
  limit: { context: 1_000_000, output: 384_000 },
  reasoning: true,
  tool_call: true,
  interleaved: { field: "reasoning_content" },
  reasoning_options: [{ type: "effort", values: ["high", "max"] }],
};

function draftProvider(): CustomProvider {
  return {
    id: "p1",
    name: "DeepSeek",
    endpoint: "https://api.deepseek.com",
    apiFormat: "openai_chat",
    apiKey: "",
    catalogId: "deepseek",
    models: [],
  };
}

describe("custom provider modal helpers", () => {
  it("addCatalogModelRow appends a row without touching provider fields", () => {
    const draft = draftProvider();
    draft.endpoint = "https://my-gateway.example/v1";

    expect(addCatalogModelRow(draft, "deepseek", "deepseek-chat", catalogModel)).toBe(true);

    expect(draft.endpoint).toBe("https://my-gateway.example/v1");
    expect(draft.name).toBe("DeepSeek");
    expect(draft.catalogId).toBe("deepseek");
    expect(draft.models).toHaveLength(1);
    expect(draft.models[0].apiModel).toBe("deepseek-chat");
    expect(draft.models[0].contextLength).toBe(128_000);
  });

  it("addCatalogModelRow rejects duplicates by catalog id or api model", () => {
    const draft = draftProvider();
    addCatalogModelRow(draft, "deepseek", "deepseek-chat", catalogModel);

    expect(addCatalogModelRow(draft, "deepseek", "deepseek-chat", catalogModel)).toBe(false);
    expect(draft.models).toHaveLength(1);
  });

  it("providerModelMatchesCatalog matches by row catalog id and api model", () => {
    const row = { ...newCustomProviderModel(), apiModel: "deepseek-chat" };

    expect(providerModelMatchesCatalog(row, "deepseek-chat")).toBe(true);
    expect(providerModelMatchesCatalog(row, "deepseek-reasoner")).toBe(false);
    expect(
      providerModelMatchesCatalog(
        { ...newCustomProviderModel(), apiModel: "custom-alias", catalogModelId: "deepseek-chat" },
        "deepseek-chat",
      ),
    ).toBe(true);
  });

  it("newCustomProvider starts with one blank editable model row", () => {
    const draft = newCustomProvider();

    expect(draft.apiFormat).toBe("openai_chat");
    expect(draft.catalogId).toBeNull();
    expect(draft.models).toHaveLength(1);
    expect(draft.models[0].apiModel).toBe("");
    expect(draft.models[0].contextLength).toBe(256_000);
    expect(draft.models[0].remoteCompactionMode).toBe("disabled");
    expect(draft.models[0].supportedReasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("derives the reasoning param format per wire format", () => {
    expect(defaultReasoningParamFormat("openai_chat")).toBe("openai_chat_reasoning_effort");
    expect(defaultReasoningParamFormat("openai_responses")).toBe("openai_responses_reasoning_effort");
    expect(defaultReasoningParamFormat("anthropic_messages")).toBe("anthropic_thinking");
  });

  it("enables reasoning replay for DeepSeek V4 on the Anthropic-compatible route", () => {
    const row = catalogModelToProviderModel(
      "deepseek",
      "deepseek-v4-pro",
      deepSeekV4CatalogModel,
      "anthropic_messages",
    );

    expect(isDeepSeekV4Model(row)).toBe(true);
    expect(row.replayReasoningContent).toBe(true);
    expect(row.reasoningReplayField).toBe("reasoning_content");
  });

  it("defaults catalog adds to the vendor's Anthropic endpoint when it has one", () => {
    // Anthropic Messages is the preferred wire for custom providers (native
    // lazy tool loading), so vendors with an official Anthropic base get it.
    const deepseek = catalogProviderToCustomProvider("deepseek", {
      name: "DeepSeek",
      api: "https://api.deepseek.com",
      models: {},
    });
    expect(deepseek.apiFormat).toBe("anthropic_messages");
    expect(deepseek.endpoint).toBe("https://api.deepseek.com/anthropic/v1");

    // Vendors without a known Anthropic base keep their catalog connection.
    const openai = catalogProviderToCustomProvider("openai", {
      name: "OpenAI",
      api: "https://api.openai.com/v1",
      models: {},
    });
    expect(openai.apiFormat).toBe("openai_chat");
    expect(openai.endpoint).toBe("https://api.openai.com/v1");

    // Overrides ride on trusted ids and end in /v1 — stream_chat_native
    // appends /messages, same shape as catalog endpoints (…/anthropic/v1).
    for (const [id, base] of Object.entries(CATALOG_ANTHROPIC_BASES)) {
      expect(isTrustedCatalogProvider(id), `override ${id}`).toBe(true);
      expect(base.endsWith("/v1"), `override base ${base}`).toBe(true);
    }
  });
});

describe("custom provider modal layout", () => {
  it("keeps relay/reseller gateways (中转站) out of the catalog pickers", () => {
    // Every featured provider must survive the allowlist.
    for (const id of FEATURED_CATALOG_PROVIDERS) {
      expect(isTrustedCatalogProvider(id), `featured ${id}`).toBe(true);
    }
    // First-party creators, official clouds, and openrouter-class brands stay.
    for (const id of [
      "openrouter",
      "vercel",
      "togetherai",
      "groq",
      "moonshotai-cn",
      "zai-coding-plan",
      "amazon-bedrock",
      "github-models",
    ]) {
      expect(isTrustedCatalogProvider(id), `trusted ${id}`).toBe(true);
    }
    // Relay/reseller gateways never surface, searched or not.
    for (const id of [
      "302ai",
      "aihubmix",
      "jiekou",
      "nano-gpt",
      "zenmux",
      "kilo",
      "llmgateway",
      "poe",
      "qihang-ai",
      "anyapi",
      "fastrouter",
    ]) {
      expect(isTrustedCatalogProvider(id), `relay ${id}`).toBe(false);
    }
  });

  it("hides providers Locus cannot reach with just endpoint + key", () => {
    const provider = (extra: Partial<ModelCatalogProvider>): ModelCatalogProvider => ({
      name: "P",
      models: {},
      ...extra,
    });

    // Trusted + plain endpoint → listed.
    expect(isListableCatalogProvider("deepseek", provider({ api: "https://api.deepseek.com" }))).toBe(true);
    // Official platforms needing their own auth stack stay trusted but hidden.
    expect(isListableCatalogProvider("google-vertex", provider({ npm: "@ai-sdk/google-vertex" }))).toBe(false);
    expect(isListableCatalogProvider("amazon-bedrock", provider({ npm: "@ai-sdk/amazon-bedrock" }))).toBe(false);
    // Per-account `${VAR}` template endpoints are not directly connectable.
    expect(
      isListableCatalogProvider(
        "databricks",
        provider({ api: "https://${DATABRICKS_HOST}/ai-gateway/mlflow/v1" }),
      ),
    ).toBe(false);
    // A usable endpoint never rescues an untrusted relay.
    expect(isListableCatalogProvider("nano-gpt", provider({ api: "https://nano-gpt.com/api/v1" }))).toBe(false);

    // Majors whose models.dev entry omits `api` keep their documented
    // OpenAI-compatible base via the official fallback table.
    expect(isListableCatalogProvider("google", provider({ npm: "@ai-sdk/google" }))).toBe(true);
    expect(catalogProviderEndpoint("togetherai", provider({ npm: "@ai-sdk/togetherai" }))).toBe(
      "https://api.together.xyz/v1",
    );
    expect(catalogProviderEndpoint("cerebras", provider({ npm: "@ai-sdk/cerebras" }))).toBe(
      "https://api.cerebras.ai/v1",
    );
    expect(isListableCatalogProvider("vercel", provider({ npm: "@ai-sdk/gateway" }))).toBe(true);
  });

  it("only offers current agent-capable models and dedupes echoed model ids", () => {
    const model = (extra: Partial<ModelCatalogModel>): ModelCatalogModel => ({
      name: "M",
      limit: { context: 128_000, output: 8_192 },
      tool_call: true,
      release_date: "2026-03-01",
      ...extra,
    });

    expect(isListableCatalogModel(model({}))).toBe(true);
    // No tool calling → no agent use → hidden.
    expect(isListableCatalogModel(model({ tool_call: false }))).toBe(false);
    expect(isListableCatalogModel(model({ tool_call: undefined }))).toBe(false);
    // Pre-2026 releases and undated entries are too old for the picker.
    expect(isListableCatalogModel(model({ release_date: "2025-12-31" }))).toBe(false);
    expect(isListableCatalogModel(model({ release_date: undefined }))).toBe(false);
    expect(isListableCatalogModel(model({ status: "deprecated" }))).toBe(false);

    // "GLM-5.2" next to "glm-5.2" is noise; a genuinely different id is not.
    expect(isRedundantModelId("GLM-5.2", "glm-5.2")).toBe(true);
    expect(isRedundantModelId("", "glm-5.2")).toBe(true);
    expect(isRedundantModelId("DeepSeek V4 Flash", "deepseek-v4-flash")).toBe(true);
    expect(isRedundantModelId("Claude Fable 5", "anthropic/claude-fable-5")).toBe(false);
    expect(isRedundantModelId("Qwen Max", "qwen-max-2026-01-25")).toBe(false);
  });
});
