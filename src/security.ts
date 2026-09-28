export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function redactSecrets(message: string, secrets: Array<string | undefined>): string {
  let redacted = message;
  for (const secret of secrets) {
    if (!secret || secret.length < 6) continue;
    redacted = redacted.split(secret).join("***");
  }
  return redacted
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "***")
    .replace(/\b(Authorization\s*:\s*)(?:Bearer\s+)?[^\s,;"']+/gi, "$1***")
    .replace(/\b(Bearer\s+)[^\s,;"']+/gi, "$1***")
    .replace(/([?&](?:key|api[_-]?key|token|access_token)=)[^&#\s]+/gi, "$1***")
    .replace(/\b((?:api[_-]?key|authorization|x-api-key)\s*[:=]\s*)[^\s,;"']+/gi, "$1***");
}
