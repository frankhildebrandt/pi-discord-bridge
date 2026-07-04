const DEFAULT_SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk-ant|sk-proj|sk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@/g,
  /\b(?:token|api[_-]?key|authorization|password|passwd|secret)\s*[:=]\s*[^\s`'\"]+/gi,
  /\b[A-Za-z0-9+/]{32,}={0,2}\b/g,
];

export function redactSecrets(text: string, additionalPatterns: string[] = []): string {
  let redacted = text;
  for (const pattern of DEFAULT_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  for (const pattern of additionalPatterns) {
    try {
      redacted = redacted.replace(new RegExp(pattern, "g"), "[REDACTED]");
    } catch {
      // Invalid custom redaction patterns are ignored deliberately.
    }
  }
  return redacted;
}
