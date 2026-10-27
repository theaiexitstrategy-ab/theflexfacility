// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Claude helper for the Fuel Agent. Same model setting and client options
// as the Flex Fuel meal estimator (lib/fuel/ai.js in the GoElev8 portal):
// ANTHROPIC_MODEL overrides DEFAULT_MODEL, one retry, 50s timeout.
//
// Two call shapes:
//   askJson()  — structured output against a JSON schema (photo check).
//   askText()  — short plain-text reply (page chat).
// Both opt into the server-side refusal fallback where the model accepts it.

const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const FALLBACK_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5'];

let _client = null;
function client() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 50_000, maxRetries: 1 });
  return _client;
}

const model = () => process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

class ClaudeError extends Error {
  constructor(code, detail) { super(detail || code); this.code = code; }
}

function mapError(e) {
  if (e instanceof ClaudeError) return e;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ClaudeError('timeout');
  if (e instanceof Anthropic.RateLimitError || e?.status === 529) return new ClaudeError('busy');
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ClaudeError('not_configured', e.message);
  if (e instanceof Anthropic.BadRequestError) return new ClaudeError('bad_request', e.message);
  return new ClaudeError('upstream_error', e?.message);
}

// thinking: 'on' runs adaptive thinking (omit the param); 'off' uses
// between_tools on Sonnet 5.5, the only way to turn it off there.
function baseParams(m, { effort, thinking }) {
  const out = { model: m, output_config: { effort } };
  if (thinking === 'off' && m === 'claude-sonnet-5-5') out.thinking = { type: 'between_tools' };
  if (FALLBACK_MODELS.includes(m)) {
    out.betas = ['server-side-fallback-2026-07-01'];
    out.fallbacks = 'default';
  }
  return out;
}

function textOf(response) {
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

// → parsed object. Throws ClaudeError.
async function askJson({ system, content, schema, maxTokens = 4000, effort = 'medium' }) {
  const c = client();
  if (!c) throw new ClaudeError('not_configured');
  const m = model();
  const params = baseParams(m, { effort, thinking: 'on' });
  let response;
  try {
    response = await c.beta.messages.create({
      ...params,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
      output_config: { ...params.output_config, format: { type: 'json_schema', schema } },
    });
  } catch (e) {
    throw mapError(e);
  }
  if (response.stop_reason === 'refusal') throw new ClaudeError('refused');
  if (response.stop_reason === 'max_tokens') throw new ClaudeError('truncated');
  try {
    return { data: JSON.parse(textOf(response)), model: response.model };
  } catch {
    throw new ClaudeError('invalid_json');
  }
}

// → reply string. Throws ClaudeError.
async function askText({ system, messages, maxTokens = 600, effort = 'low' }) {
  const c = client();
  if (!c) throw new ClaudeError('not_configured');
  const m = model();
  let response;
  try {
    response = await c.beta.messages.create({
      ...baseParams(m, { effort, thinking: 'off' }),
      max_tokens: maxTokens,
      system,
      messages,
    });
  } catch (e) {
    throw mapError(e);
  }
  if (response.stop_reason === 'refusal') throw new ClaudeError('refused');
  return textOf(response);
}

module.exports = { askJson, askText, ClaudeError, DEFAULT_MODEL, model };
