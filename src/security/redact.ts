const REDACTED_KEYS = new Set(["token", "authorization", "api_key", "cookie"]);
export const REDACTED = "[REDACTED]";

/** Recursively redacts known secret-named keys in a JSON-shaped value. Case-insensitive on keys. */
export function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? REDACTED : redactJsonValue(inner);
    }
    return out;
  }
  return value;
}

const SECRET_LINE_PATTERN =
  /\b([\w.-]*(?:token|secret|password|api[_-]?key|authorization|cookie)[\w.-]*)(\s*[:=]\s*)(['"]?)([^'"\s]+)(['"]?)/gi;

/** Best-effort redaction of an assignment-shaped secret in one line of arbitrary text. */
export function redactTextLine(line: string): string {
  return line.replace(SECRET_LINE_PATTERN, (_match, key, sep, openQuote, _value, closeQuote) => {
    return `${key}${sep}${openQuote}${REDACTED}${closeQuote}`;
  });
}
