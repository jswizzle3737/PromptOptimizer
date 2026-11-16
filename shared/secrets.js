/**
 * Catch credentials pasted into a draft before the draft leaves the device.
 *
 * Heuristic and deliberately narrow: well-known key prefixes and shapes, so a
 * warning means something. A miss is possible; a false alarm should be rare.
 */

const PATTERNS = [
  ['an OpenAI or Anthropic API key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Stripe secret key', /\b[rs]k_live_[0-9A-Za-z]{20,}/],
  ['a JSON Web Token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['a private key', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ['a password', /\b(?:password|passwd|pwd)\s*[:=]\s*\S{6,}/i]
];

/** Labels of the credential kinds found in `text`, in a stable order. */
export function detectSecrets(text) {
  const s = String(text ?? '');
  return PATTERNS.filter(([, re]) => re.test(s)).map(([label]) => label);
}

const CLOUD_ENGINES = ['gemini', 'openai', 'anthropic', 'openrouter'];

/** Whether an endpoint targets the user's own machine. */
export function isLocalEndpoint(rawUrl) {
  const value = String(rawUrl ?? '').trim();
  if (!value) return true;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function hasCloudKey(settings = {}) {
  return CLOUD_ENGINES.some(id => String(settings[`${id}ApiKey`] || '').trim());
}

function isOmnirouteRemote(settings = {}) {
  const active = Boolean(
    settings.omnirouteEnabled ||
    String(settings.omnirouteApiKey || '').trim() ||
    settings.preferredEngine === 'omniroute'
  );
  if (!active) return false;
  return !isLocalEndpoint(settings.omnirouteBaseUrl || 'http://localhost:20128/v1');
}

const FALLBACK_ENGINE_FIELDS = ['fallback1Engine', 'fallback2Engine'];
const OMNI_DEFAULT_URL = 'http://localhost:20128/v1';

/**
 * Whether a run with `engine` may send the draft to a remote/cloud provider.
 * Local engines stay on-device when allowCloudFallback is false or an explicit
 * `offline` fallback stops the chain before any cloud slot or key.
 */
export function mayLeaveDevice(engine, settings = {}) {
  if (engine === 'offline') return false;
  if (CLOUD_ENGINES.includes(engine)) return true;

  const omniUrl = settings.omnirouteBaseUrl || OMNI_DEFAULT_URL;
  if (engine === 'omniroute' && !isLocalEndpoint(omniUrl)) return true;

  if (engine === 'nano' || engine === 'omniroute') {
    if (settings.allowCloudFallback === false) return false;

    let stopped = false;
    for (const field of FALLBACK_ENGINE_FIELDS) {
      const slot = String(settings[field] || '').trim();
      if (!slot) continue;
      if (slot === 'offline') {
        stopped = true;
        break;
      }
      if (slot === engine) continue;
      if (slot === 'omniroute') {
        if (!isLocalEndpoint(omniUrl)) return true;
        continue;
      }
      if (CLOUD_ENGINES.includes(slot) && String(settings[`${slot}ApiKey`] || '').trim()) {
        return true;
      }
    }
    if (stopped) return false;
    return engine === 'nano'
      ? Boolean(hasCloudKey(settings) || isOmnirouteRemote(settings))
      : hasCloudKey(settings);
  }

  return true;
}

/** One sentence for the warning, or '' when there is nothing to warn about. */
export function secretWarning(text, engine, settings) {
  if (!mayLeaveDevice(engine, settings)) return '';
  const found = detectSecrets(text);
  if (!found.length) return '';
  const list = found.length === 1 ? found[0] : `${found.slice(0, -1).join(', ')} and ${found.at(-1)}`;
  return `This draft looks like it contains ${list}. It would be sent to a cloud AI provider.`;
}
