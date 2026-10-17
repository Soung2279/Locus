import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSettingsState } from "../composables/useSettingsState";
import { useAuthStore } from "../stores/auth";
import { useModelStore } from "../stores/model";
import type { CodexRateLimitsResponse } from "../services/auth";
import type { ModelOption } from "../types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), addNotice: vi.fn() }));

vi.mock("../services/ipc", () => ({ ipcInvoke: mocks.invoke }));
vi.mock("../stores/notification", () => ({
  useNotificationStore: () => ({ addNotice: mocks.addNotice }),
}));
vi.mock("vue", async (importOriginal) => ({
  ...await importOriginal<typeof import("vue")>(),
  onMounted: vi.fn(),
  onUnmounted: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const existingModel: ModelOption = {
  id: "openai/gpt-existing",
  name: "GPT Existing",
  provider: "openai_codex",
};
const newModel: ModelOption = {
  id: "openai/gpt-new",
  name: "GPT New",
  provider: "openai_codex",
};
const quota: CodexRateLimitsResponse = {
  fetchedAtMs: 1_735_689_600_000,
  rateLimits: { limitId: "codex" },
  rateLimitsByLimitId: {},
};

function setup() {
  useAuthStore().codexAuthenticated = true;
  const models = useModelStore();
  models.codexRemoteModels = [existingModel];
  models.selectedModelId = existingModel.id;
  const state = useSettingsState(vi.fn());
  state.codexStatus.value = {
    authenticated: true,
    accountId: "account-1",
    validationFailed: false,
    validationError: null,
  };
  const modelRequest = deferred<ModelOption[]>();
  const quotaRequest = deferred<CodexRateLimitsResponse>();
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "get_codex_available_models") return modelRequest.promise;
    if (command === "codex_rate_limits") return quotaRequest.promise;
    throw new Error(`Unexpected IPC command: ${command}`);
  });
  return { state, models, modelRequest, quotaRequest };
}

describe("Codex subscription refresh", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("refreshes quota and models together, waits for both, and ignores duplicate clicks", async () => {
    const { state, models, modelRequest, quotaRequest } = setup();
    const refresh = state.refreshCodexSubscription();

    expect(mocks.invoke).toHaveBeenCalledWith("codex_rate_limits");
    expect(mocks.invoke).toHaveBeenCalledWith("get_codex_available_models", { forceRefresh: true });
    expect(state.codexRefreshing.value).toBe(true);

    quotaRequest.resolve(quota);
    await vi.waitFor(() => expect(state.codexQuota.value.loaded).toBe(true));
    expect(state.codexRefreshing.value).toBe(true);
    await state.refreshCodexSubscription();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);

    modelRequest.resolve([existingModel, newModel]);
    await refresh;

    expect(models.availableModels.map((model) => model.id)).toContain(newModel.id);
    expect(models.selectedModelId).toBe(existingModel.id);
    expect(state.codexRefreshing.value).toBe(false);
    expect(mocks.addNotice).not.toHaveBeenCalled();
  });

  it("preserves the model list and reports a failed refresh after quota finishes", async () => {
    const { state, models, modelRequest, quotaRequest } = setup();
    const refresh = state.refreshCodexSubscription();
    modelRequest.reject(new Error("Codex models request failed"));
    await vi.waitFor(() => expect(state.codexQuota.value.loading).toBe(true));
    expect(state.codexRefreshing.value).toBe(true);

    quotaRequest.resolve(quota);
    await refresh;

    expect(models.codexRemoteModels).toEqual([existingModel]);
    expect(models.selectedModelId).toBe(existingModel.id);
    expect(state.codexQuota.value.loaded).toBe(true);
    expect(state.codexRefreshing.value).toBe(false);
    expect(mocks.addNotice).toHaveBeenCalledWith("error", "Codex models request failed", {
      code: "unknown",
      operation: "codexModelsRefresh",
    });
  });

  it("still updates models when the quota request fails", async () => {
    const { state, models, modelRequest, quotaRequest } = setup();
    const refresh = state.refreshCodexSubscription();
    quotaRequest.reject(new Error("Quota unavailable"));
    modelRequest.resolve([existingModel, newModel]);
    await refresh;

    expect(models.availableModels.map((model) => model.id)).toContain(newModel.id);
    expect(state.codexQuota.value.error).toBe("Quota unavailable");
    expect(state.codexRefreshing.value).toBe(false);
  });

  it("keeps ordinary model loading cache-aware", async () => {
    const { models, modelRequest } = setup();
    modelRequest.resolve([existingModel]);
    await models.loadCodexAvailableModels();
    expect(mocks.invoke).toHaveBeenCalledWith("get_codex_available_models", { forceRefresh: false });
  });

  it("defaults automatic client versions on and preserves an explicitly disabled choice", async () => {
    const { state } = setup();
    expect(state.codexModelConfig.value.autoUpdateClientVersion).toBe(true);
    mocks.invoke.mockResolvedValueOnce({ transport: "http" });
    await state.loadCodexModelConfig();
    expect(state.codexModelConfig.value.autoUpdateClientVersion).toBe(true);
    mocks.invoke.mockResolvedValueOnce({ transport: "http", autoUpdateClientVersion: false });
    await state.loadCodexModelConfig();
    expect(state.codexModelConfig.value.autoUpdateClientVersion).toBe(false);
    mocks.invoke.mockResolvedValueOnce({ transport: "http", autoUpdateClientVersion: true });
    await state.loadCodexModelConfig();
    expect(state.codexModelConfig.value.autoUpdateClientVersion).toBe(true);
  });

  it.each([true, false])("saves automatic versions=%s before refreshing models and blocks overlapping refreshes", async (enabled) => {
    const { state, models, modelRequest } = setup();
    state.codexModelConfig.value.autoUpdateClientVersion = !enabled;
    const saved = deferred<void>();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "save_codex_model_config") return saved.promise;
      if (command === "get_codex_available_models") return modelRequest.promise;
      throw new Error(`Unexpected IPC command: ${command}`);
    });

    const change = state.setCodexAutoUpdateClientVersion(enabled);
    expect(state.codexClientVersionBusy.value).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("save_codex_model_config", {
      config: expect.objectContaining({ autoUpdateClientVersion: enabled }),
    });
    await state.setCodexAutoUpdateClientVersion(!enabled);
    await state.refreshCodexSubscription();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    saved.resolve();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("get_codex_available_models", { forceRefresh: true }));
    modelRequest.resolve([existingModel, newModel]);
    await change;
    expect(state.codexModelConfig.value.autoUpdateClientVersion).toBe(enabled);
    expect(models.codexRemoteModels.map((model) => model.id)).toContain(newModel.id);
    expect(state.codexClientVersionBusy.value).toBe(false);
  });

  it("rolls back the switch when saving fails, without fetching models", async () => {
    const { state } = setup();
    mocks.invoke.mockRejectedValueOnce(new Error("Disk unavailable"));
    await state.setCodexAutoUpdateClientVersion(false);
    expect(state.codexModelConfig.value.autoUpdateClientVersion).toBe(true);
    expect(state.codexClientVersionBusy.value).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.addNotice).toHaveBeenCalledWith("error", expect.stringContaining("Disk unavailable"), {
      code: "unknown", operation: "saveCodexModelConfig",
    });
  });

  it("keeps a saved switch and the previous models when its immediate refresh fails", async () => {
    const { state, models } = setup();
    state.codexModelConfig.value.autoUpdateClientVersion = false;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "save_codex_model_config") return Promise.resolve();
      if (command === "get_codex_available_models") return Promise.reject(new Error("Models unavailable"));
      throw new Error(`Unexpected IPC command: ${command}`);
    });
    await state.setCodexAutoUpdateClientVersion(true);
    expect(state.codexModelConfig.value.autoUpdateClientVersion).toBe(true);
    expect(state.codexClientVersionBusy.value).toBe(false);
    expect(models.codexRemoteModels).toEqual([existingModel]);
    expect(mocks.addNotice).toHaveBeenCalledWith("error", "Models unavailable", {
      code: "unknown", operation: "codexModelsRefresh",
    });
  });

  it("can save the setting before login without requesting a subscription catalog", async () => {
    const { state } = setup();
    state.codexStatus.value.authenticated = false;
    mocks.invoke.mockResolvedValueOnce(undefined);
    await state.setCodexAutoUpdateClientVersion(false);
    expect(state.codexModelConfig.value.autoUpdateClientVersion).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(state.codexClientVersionBusy.value).toBe(false);
  });
});
