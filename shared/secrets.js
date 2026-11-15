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

/**
 * Whether a run with `engine` may send the draft to a remote/cloud provider.
 * Nano stays local unless fallback is enabled and a remote route exists.
 */
export function mayLeaveDevice(engine, settings = {}) {
  if (engine === 'offline') return false;
  if (engine === 'nano') {
    if (settings.allowCloudFallback === false) return false;
    return Boolean(hasCloudKey(settings) || isOmnirouteRemote(settings));
  }
  if (engine === 'omniroute') {
    if (!isLocalEndpoint(settings.omnirouteBaseUrl || 'http://localhost:20128/v1')) return true;
    if (settings.allowCloudFallback === false) return false;
    return hasCloudKey(settings);
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
