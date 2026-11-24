/**
 * Catch credentials pasted into a draft before the draft leaves the device.
 *
 * Heuristic and deliberately narrow: well-known key prefixes and shapes, so a
 * warning means something. A miss is possible; a false alarm should be rare.
 */

const PATTERNS = [
  ['an AI provider API key (OpenAI, Anthropic, OpenRouter)', /\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{20,}/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['a GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/],
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
