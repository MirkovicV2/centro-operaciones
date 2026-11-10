// Shared redaction for anything that may reach the ledger, the panel or a log.
// Patterns are conservative: a false positive hides text, a false negative leaks a key.
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}/g, // OpenAI, Anthropic (sk-ant-…) and similar
];
const ENV_KEYS = ['OPENAI_API_KEY', 'CODEX_API_KEY'];

export function redactSecrets(value, env = process.env, { limit = 48_000 } = {}) {
  let text = String(value ?? '');
  for (const name of ENV_KEYS) if (env?.[name] && env[name].length >= 8) text = text.split(env[name]).join('[CLAVE OCULTA]');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[CLAVE OCULTA]');
  return text.slice(0, limit);
}

// A single-line, bounded, redacted excerpt for error details.
export function excerpt(value, limit = 400, env = process.env) {
  const text = redactSecrets(String(value ?? '').replace(/\s+/g, ' ').trim(), env, { limit: limit + 1 });
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}
