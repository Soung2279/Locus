/** Stable references are stored as ordinary Markdown in the message text. */
const SESSION_URL = /^locus:\/\/session\/([A-Za-z0-9_-]+)$/;

export interface SessionReferenceAttachment {
  sessionId: string;
  title: string;
}

export function normalizeSessionReferences(values: unknown): SessionReferenceAttachment[] {
  if (!Array.isArray(values)) return [];
  const unique = new Map<string, SessionReferenceAttachment>();
  for (const value of values) {
    if (!value || typeof value !== "object" || typeof value.sessionId !== "string"
      || !/^[A-Za-z0-9_-]+$/.test(value.sessionId)) continue;
    unique.set(value.sessionId, {
      sessionId: value.sessionId,
      title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : value.sessionId,
    });
  }
  return [...unique.values()];
}

export function sessionIdFromReference(value: string): string | null {
  return SESSION_URL.exec(value)?.[1] ?? null;
}

export function sessionReferenceUrl(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("Invalid session ID");
  return `locus://session/${sessionId}`;
}

export function formatSessionReference(sessionId: string, title: string): string {
  const label = (title.trim() || sessionId).replace(/[\r\n]+/g, " ").replace(/[\\`*_{}\[\]<>&@]/g,
    (char) => `&#${char.charCodeAt(0)};`);
  return `[${label}](${sessionReferenceUrl(sessionId)})`;
}

export type SessionReferenceSegment =
  | { type: "text"; value: string }
  | { type: "session"; value: string; sessionId: string };

export function parseSessionReferences(text: string): SessionReferenceSegment[] {
  const segments: SessionReferenceSegment[] = [];
  const pattern = /\[([^\]\r\n]*)\]\(locus:\/\/session\/([A-Za-z0-9_-]+)\)/g;
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > end) segments.push({ type: "text", value: text.slice(end, match.index) });
    segments.push({ type: "session", sessionId: match[2]!, value: match[1]!.replace(/&#(\d+);/g,
      (entity, digits) => Number(digits) <= 0x10ffff ? String.fromCodePoint(Number(digits)) : entity) });
    end = match.index + match[0].length;
  }
  if (end < text.length) segments.push({ type: "text", value: text.slice(end) });
  return segments;
}

export function extractSessionReferences(text: string): { text: string; sessionRefs: SessionReferenceAttachment[] } {
  const segments = parseSessionReferences(text);
  return {
    text: segments.filter((segment) => segment.type === "text").map((segment) => segment.value).join(""),
    sessionRefs: normalizeSessionReferences(segments.flatMap((segment) => segment.type === "session"
      ? [{ sessionId: segment.sessionId, title: segment.value }] : [])),
  };
}

export function appendSessionReferences(text: string, references: SessionReferenceAttachment[]): string {
  const block = normalizeSessionReferences(references)
    .map(({ sessionId, title }) => formatSessionReference(sessionId, title)).join("\n");
  return !block ? text : text.trim() ? `${text}\n\n${block}` : block;
}
