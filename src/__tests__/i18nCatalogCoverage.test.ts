import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../language/en.json";
import zh from "../language/zh.json";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__tests__") return [];
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.(ts|vue)$/.test(entry.name) ? [path] : [];
  });
}

// A complete literal key: t("a.b") or t("a.b", ...). Concatenated or
// interpolated keys are resolved at runtime and cannot be checked here.
const LITERAL_KEY_CALL = /(?<![\w.$])t\(\s*(["'`])([\w.-]+)\1\s*[,)]/g;

const enCatalog: Record<string, string> = en;
const zhCatalog: Record<string, string> = zh;

describe("i18n catalogs", () => {
  it("define the same keys in every locale", () => {
    expect(Object.keys(enCatalog).filter((key) => !(key in zhCatalog))).toEqual([]);
    expect(Object.keys(zhCatalog).filter((key) => !(key in enCatalog))).toEqual([]);
  });

  it("define every literal key passed to t()", () => {
    const missing = new Set<string>();
    let checked = 0;
    for (const file of sourceFiles(resolve("src"))) {
      const path = relative(process.cwd(), file).replaceAll("\\", "/");
      for (const match of readFileSync(file, "utf8").matchAll(LITERAL_KEY_CALL)) {
        checked += 1;
        if (!(match[2] in enCatalog)) missing.add(`${path}: ${match[2]}`);
      }
    }
    // Guard against a scanner that silently matches nothing.
    expect(checked).toBeGreaterThan(1000);
    expect([...missing]).toEqual([]);
  });
});
