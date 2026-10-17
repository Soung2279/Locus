import { isMap, isNode, isScalar, isSeq, parseDocument, type Document } from "yaml";

export type PropertyType = "text" | "list" | "number" | "boolean" | "date" | "yaml";
export interface MarkdownProperty { key: string; type: PropertyType; value: unknown }
export interface PropertyEdit { key: string; newKey?: string; value?: unknown; type?: PropertyType; remove?: boolean }
export interface FrontmatterRange { from: number; to: number; yamlFrom: number; yamlTo: number; closed: boolean }

/** Accept only a delimited block at the beginning; a body rule is not metadata. */
export function frontmatterRange(source: string): FrontmatterRange | null {
  const opening = /^(\uFEFF?)[-]{3}[\t ]*\r?\n/.exec(source);
  if (!opening) return null;
  const tail = source.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[\t ]*\r?$/m.exec(tail);
  if (!closing) return { from: opening[1].length, to: source.length, yamlFrom: opening[0].length, yamlTo: source.length, closed: false };
  return { from: opening[1].length, to: opening[0].length + closing.index + closing[0].length,
    yamlFrom: opening[0].length, yamlTo: opening[0].length + closing.index, closed: true };
}

export function parseProperties(yaml: string): Document {
  const doc = parseDocument(yaml, { uniqueKeys: true, stringKeys: true, keepSourceTokens: true });
  if (doc.errors.length || doc.warnings.length) throw new Error(doc.errors[0]?.message ?? doc.warnings[0]!.message);
  if (doc.contents !== null && !isMap(doc.contents)) throw new Error("editor.properties.invalidMapping");
  return doc;
}

export function propertyRows(yaml: string): MarkdownProperty[] {
  const doc = parseProperties(yaml);
  if (!isMap(doc.contents)) return [];
  return doc.contents.items.map(({ key, value }) => {
    const name = String(isScalar(key) ? key.value : key);
    // Unusual tags, anchors and nested collections remain visible without a lossy conversion.
    const simpleScalar = isScalar(value) && !value.tag && !value.anchor;
    const simpleList = isSeq(value) && !value.tag && !value.anchor
      && value.items.every((item) => isScalar(item) && !item.tag && !item.anchor && typeof item.value === "string");
    if (simpleList) return { key: name, type: "list", value: value.items.map((item) => isScalar(item) ? item.value : "") };
    if (value === null || simpleScalar) {
      const scalar = isScalar(value) ? value.value : null;
      const type = typeof scalar === "boolean" ? "boolean" : typeof scalar === "number" && Number.isFinite(scalar) ? "number"
        : typeof scalar === "string" && value?.type === "PLAIN" && /^\d{4}-\d{2}-\d{2}$/.test(scalar) ? "date"
        : scalar === null || typeof scalar === "string" ? "text" : "yaml";
      if (type !== "yaml") return { key: name, type, value: scalar };
    }
    return { key: name, type: "yaml", value: value?.toString() ?? "null" };
  });
}

export function editProperties(yaml: string, edit: PropertyEdit): string {
  const doc = parseProperties(yaml);
  const nextKey = edit.newKey ?? edit.key;
  if (!nextKey.trim()) throw new Error("editor.properties.emptyName");
  if (nextKey !== edit.key && doc.has(nextKey)) throw new Error("editor.properties.duplicateName");
  if (edit.remove) doc.delete(edit.key);
  else {
    if (nextKey !== edit.key && isMap(doc.contents)) {
      const pair = doc.contents.items.find((item) => isScalar(item.key) && item.key.value === edit.key);
      if (pair && isScalar(pair.key)) pair.key.value = nextKey;
    }
    if (Object.prototype.hasOwnProperty.call(edit, "value")) {
      const previous = doc.get(nextKey, true);
      if (isScalar(previous) && (edit.value === null || typeof edit.value !== "object")) {
        previous.value = edit.value;
      } else {
        const node = doc.createNode(edit.value);
        if (isNode(previous)) {
          node.comment = previous.comment;
          node.commentBefore = previous.commentBefore;
        }
        doc.set(nextKey, node);
      }
      const updated = doc.get(nextKey, true);
      if (isScalar(updated) && (edit.type === "text" || edit.type === "date")) {
        updated.type = edit.type === "text" ? "QUOTE_DOUBLE" : "PLAIN";
      }
    }
  }
  return doc.toString({ lineWidth: 0 });
}

export function defaultPropertyValue(type: PropertyType): unknown {
  if (type === "date") {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }
  return type === "list" ? [] : type === "boolean" ? false : type === "number" ? 0 : "";
}

export function convertPropertyValue(value: unknown, type: PropertyType): unknown {
  const text = value === null ? "" : Array.isArray(value) ? value.join("\n") : String(value);
  if (type === "text") return text;
  if (type === "list") return text ? text.split("\n") : [];
  if (type === "boolean" && /^(true|false)?$/i.test(text)) return text.toLowerCase() === "true";
  if (type === "number" && (!text || Number.isFinite(Number(text)))) return text ? Number(text) : 0;
  if (type === "date" && (!text || /^\d{4}-\d{2}-\d{2}$/.test(text))) return text || defaultPropertyValue("date");
  throw new Error("editor.properties.invalidConversion");
}
