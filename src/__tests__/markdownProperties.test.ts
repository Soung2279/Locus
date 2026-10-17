import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { convertPropertyValue, editProperties, frontmatterRange, propertyRows } from "../document/markdownProperties";
import { extractKnowledgeDocumentOutline } from "../components/knowledge/knowledgeDocumentOutline";

describe("Markdown properties", () => {
  it("recognizes Obsidian text and list fields alongside scalar types", () => {
    const rows = propertyRows("类型: 角色\n别名:\n  - 女剑士\n  - Elora\n年龄: 19\n主角: true\n日期: 2026-10-09\n空值:\n");
    expect(rows.map((row) => row.type)).toEqual(["text", "list", "number", "boolean", "date", "text"]);
    expect(rows[1]?.value).toEqual(["女剑士", "Elora"]);
  });
  it("keeps comments, order, quoting, nested values and aliases while changing a scalar", () => {
    const yaml = '# 人物\n类型: "角色" # 注释\n默认: &defaults { hp: 100 }\n战斗: *defaults\n';
    const edited = editProperties(yaml, { key: "类型", value: "主角: 艾洛拉" });
    expect(edited).toContain('# 人物\n类型: "主角: 艾洛拉" # 注释');
    expect(edited).toContain("&defaults");
    expect(edited).toContain("*defaults");
    expect(parse(edited).战斗).toEqual({ hp: 100 });
    expect(propertyRows(edited).slice(1).every((row) => row.type === "yaml")).toBe(true);
  });
  it("adds, renames, removes and updates lists without coercing strings", () => {
    let yaml = editProperties("类型: 角色\n", { key: "别名", value: ["true", "007", "a: b"] });
    yaml = editProperties(yaml, { key: "类型", newKey: "分类" });
    expect(Object.keys(parse(yaml))).toEqual(["分类", "别名"]);
    expect(parse(yaml).别名).toEqual(["true", "007", "a: b"]);
    yaml = editProperties(yaml, { key: "分类", remove: true });
    expect(parse(yaml).分类).toBeUndefined();
    expect(() => editProperties(yaml, { key: "其他", newKey: "别名" })).toThrow("duplicateName");
  });
  it.each(["key: [broken", "- list", "a: 1\na: 2", "value: !unknown text"]) ("does not rewrite unsupported or invalid YAML: %s", (yaml) => {
    expect(() => editProperties(yaml, { key: "name", value: "new" })).toThrow();
  });
  it("does not treat a body separator or fenced YAML as frontmatter", () => {
    expect(frontmatterRange("# 标题\n---\n属性: 值\n---")).toBeNull();
    expect(frontmatterRange("```yaml\n---\nkey: value\n---\n```")).toBeNull();
    expect(frontmatterRange("---\nkey: value")?.closed).toBe(false);
  });
  it("accepts BOM and CRLF without consuming body bytes", () => {
    const source = "\uFEFF---\r\n类型: 角色\r\n---\r\n\r\n# 正文\r\n";
    const range = frontmatterRange(source)!;
    expect(range.closed).toBe(true);
    expect(source.slice(range.yamlFrom, range.yamlTo)).toBe("类型: 角色\r\n");
    expect(source.slice(range.to)).toBe("\n\r\n# 正文\r\n");
  });
  it("excludes YAML setext lookalikes from the outline and keeps physical offsets", () => {
    const source = "---\n类型: 角色\n---\n\n# 正文\n";
    expect(extractKnowledgeDocumentOutline(source)).toEqual([{ id: `1:${source.indexOf("#")}`, level: 1, text: "正文", from: source.indexOf("#"), to: source.length - 1 }]);
  });
  it("rejects type conversions that would erase the existing value", () => {
    expect(convertPropertyValue(["女剑士", "Elora"], "text")).toBe("女剑士\nElora");
    expect(convertPropertyValue("007", "number")).toBe(7);
    expect(() => convertPropertyValue("女剑士", "boolean")).toThrow("invalidConversion");
  });
  it("distinguishes a date from date-shaped text when switching types", () => {
    const date = editProperties("日期: ''\n", { key: "日期", value: "2026-10-09", type: "date" });
    expect(propertyRows(date)[0]?.type).toBe("date");
    const text = editProperties(date, { key: "日期", value: "2026-10-09", type: "text" });
    expect(propertyRows(text)[0]?.type).toBe("text");
    expect(parse(text).日期).toBe("2026-10-09");
  });
});
