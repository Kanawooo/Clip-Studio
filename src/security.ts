export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function redactSecrets(message: string, secrets: Array<string | undefined>): string {
  let redacted = message;
  for (const secret of secrets) {
    if (!secret || secret.length < 6) continue;
    redacted = redacted.split(secret).join("***");
  }
  return redacted;
}
