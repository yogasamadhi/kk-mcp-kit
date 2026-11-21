const SENSITIVE_KEY =
  /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|credential)/i;
const DEFAULT_PATTERNS = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/g,
];
const ASSIGNMENT_PATTERN =
  /((?:^|[\s,{])["']?(?:authorization|password|passwd|secret|token|api[_-]?key|credential)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi;
const FLAG_PATTERN =
  /((?:^|\s)--?(?:authorization|password|passwd|secret|token|api[_-]?key|credential)(?:=|\s+))\S+/gi;
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)[^@\s]+@/gi;

export function redactText(input: string, configuredPatterns: readonly string[] = []): string {
  let output = input;
  for (const pattern of DEFAULT_PATTERNS) output = output.replace(pattern, "[REDACTED]");
  output = output.replace(ASSIGNMENT_PATTERN, "$1[REDACTED]");
  output = output.replace(FLAG_PATTERN, "$1[REDACTED]");
  output = output.replace(URL_CREDENTIAL_PATTERN, "$1[REDACTED]@");
  for (const source of configuredPatterns) {
    try {
      output = output.replace(new RegExp(source, "gi"), "[REDACTED]");
    } catch {
      // Invalid custom patterns are rejected by configuration validation where possible.
    }
  }
  return output;
}

export function redactValue(value: unknown, configuredPatterns: readonly string[] = []): unknown {
  if (typeof value === "string") return redactText(value, configuredPatterns);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, configuredPatterns));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(child, configuredPatterns),
      ]),
    );
  }
  return value;
}
