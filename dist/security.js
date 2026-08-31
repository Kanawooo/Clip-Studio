export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function redactSecrets(message, secrets) {
    let redacted = message;
    for (const secret of secrets) {
        if (!secret || secret.length < 6)
            continue;
        redacted = redacted.split(secret).join("***");
    }
    return redacted;
}
