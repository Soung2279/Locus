export const punctuationPairs: Readonly<Record<string, string>> = {
  "(": ")", "[": "]", "{": "}", '"': '"', "'": "'",
  "（": "）", "［": "］", "｛": "｝", "【": "】", "〖": "〗",
  "「": "」", "『": "』", "“": "”", "‘": "’", "《": "》", "〈": "〉",
};

const alternatingQuotes: Readonly<Record<string, string>> = { "」": "「", "』": "『", "”": "“", "’": "‘" };
export const punctuationContextLimit = 512;
export const isPairingCharacter = (text: string): boolean => text.length === 1 && !!(punctuationPairs[text] || alternatingQuotes[text]);

/** An IME may remember its last quote in another field or application. */
export function resolvePunctuation(text: string, before: string): string {
  const open = alternatingQuotes[text];
  if (!open) return text;
  let depth = 0;
  // Bounded, backwards scan within the current line. Matched quotes do not
  // count as an opening for this input; nested quotes balance independently.
  for (let i = before.length - 1, min = Math.max(0, before.length - punctuationContextLimit); i >= min; i--) {
    const char = before[i];
    if (char === "\n" || char === "\r") break;
    if (char === text) depth++;
    else if (char === open) {
      if (depth === 0) return text;
      depth--;
    }
  }
  return open;
}

export function canPairPunctuation(text: string, before: string, after: string, selected: boolean): boolean {
  if (!punctuationPairs[text]) return false;
  if (selected || text.charCodeAt(0) > 127) return true;
  // Apostrophes in words and manually closed English quotes stay literal.
  if ((text === "'" || text === '"') && /[\p{L}\p{N}_]/u.test(before.slice(-1))) return false;
  return !after || /[\s)\]}:;,.!?，。！？；：）】」』》〉”’]/u.test(after[0]);
}
