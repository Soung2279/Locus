
import { describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import { isUnityConnectionError, normalizeAppError } from "../services/errors";

describe("isUnityConnectionError", () => {
  it("detects Unity pipe connection failures", () => {
    expect(isUnityConnectionError(
      "Failed to connect to Unity Editor (\\\\.\\pipe\\locus_unity_native_project): 系统找不到指定的文件。 (os error 2)",
    )).toBe(true);
  });

  it("keeps asset content errors separate", () => {
    expect(isUnityConnectionError("Asset was not found: Assets/Missing.prefab")).toBe(false);
  });

  it("localizes plugin-managed View operation errors", () => {
    setLocale("zh");

    expect(normalizeAppError({
      code: "legacy.string_error",
      message: "View 'Plugin Import Hello' is managed by plugin 'com.locus.sample.asset-browser'. Uninstall the plugin to remove it.",
      retryable: false,
      severity: "error",
    }).message).toBe(
      "视图“Plugin Import Hello”由插件“com.locus.sample.asset-browser”管理。卸载该插件后再删除。",
    );
  });
});
