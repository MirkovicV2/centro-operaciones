// Shared redaction for anything that may reach the ledger, the panel or a log.
// Patterns are conservative: a false positive hides text, a false negative leaks a key.
// 8: synthetic examples live in tests/redaction.test.mjs; never paste real tokens here.
const SECRET_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{12,}/g, // Anthropic
  /\bsk-[A-Za-z0-9_-]{12,}/g, // OpenAI and similar
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained personal access tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub classic PAT, OAuth, user-to-server, server-to-server, refresh
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, // Telegram bot tokens
];
const ENV_KEYS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'TELEGRAM_BOT_TOKEN'];

export function containsSecret(value, env = process.env) {
  const text = String(value ?? '');
  return ENV_KEYS.some(name => env?.[name] && env[name].length >= 8 && text.includes(env[name]))
    || SECRET_PATTERNS.some(pattern => new RegExp(pattern.source).test(text));
}

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
