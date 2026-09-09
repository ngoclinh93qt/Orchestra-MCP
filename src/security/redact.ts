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

const SECRET_KEY_FRAGMENT = "[\\w.-]*(?:token|secret|password|api[_-]?key|authorization|cookie)[\\w.-]*";

const SECRET_LINE_PATTERN = new RegExp(`\\b(${SECRET_KEY_FRAGMENT})(\\s*[:=]{1}(?!=)\\s*)(["'])((?:(?!\\3).)+)\\3`, "gi");

/**
 * Unquoted assignment shapes — env files outside `.env*`, YAML, `.npmrc`-style config. Deliberately
 * narrower than the quoted pattern in two ways, both needed to keep ordinary source code from being
 * corrupted:
 *
 *  - The value's character class is restricted to plausible bare-token characters (letters, digits,
 *    `_ - . / : +`), optionally followed by `=` or `==` base64 padding. Parens, commas, brackets, and
 *    braces are excluded because those only show up in code syntax (`path.join(dir, name)`,
 *    `line.split(",")`), never in a bare secret value.
 *  - The value must be immediately followed by a natural statement-ending context — optional
 *    whitespace then `;`, `,`, `)`, `]`, `}`, a `#` or `//` comment marker, or end of line — rather
 *    than matching mid-expression. This is what rejects `secretPath = path.join(dir, name)`: the
 *    greedy value run stops before the `(`, and `(` is not an accepted terminator, so the whole
 *    match is rejected.
 *
 * The `(?!=)` lookahead in the separator is what stops `===` matching.
 */
const UNQUOTED_SECRET_PATTERN = new RegExp(
  `\\b(${SECRET_KEY_FRAGMENT})(\\s*[:=]{1}(?!=)\\s*)([A-Za-z0-9_.\\-/:+]{8,}={0,2})(?=\\s*(?:[;,)\\]}]|#|//|$))`,
  "gi",
);

const SAFE_UNQUOTED_LITERALS = new Set(["true", "false", "null", "undefined"]);

/**
 * Best-effort redaction of an assignment-shaped secret in one line of arbitrary text.
 *
 * Heuristic, not a guarantee: it recognizes common `key = value` shapes with a secret-looking key,
 * both quoted and unquoted. Secrets that are not assignment-shaped (a bare token on its own line,
 * a base64 blob) are not detected.
 */
export function redactTextLine(line: string): string {
  let result = line.replace(SECRET_LINE_PATTERN, (_match, key, sep, quote) => `${key}${sep}${quote}${REDACTED}${quote}`);
  result = result.replace(UNQUOTED_SECRET_PATTERN, (match, key, sep, value: string) => {
    if (SAFE_UNQUOTED_LITERALS.has(value.toLowerCase()) || /^\d+$/.test(value)) return match;
    return `${key}${sep}${REDACTED}`;
  });
  return result;
}
