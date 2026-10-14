/**
 * Fill-in-the-blank prompts: a saved prompt can contain {{variables}} that are
 * asked for each time it is used, turning the library into reusable templates.
 * Names: a letter, then up to 39 letters, digits, spaces, dots, dashes or
 * underscores ({{audience}}, {{due date}}, {{client_name}}).
 */

const VAR_RE = /\{\{\s*([A-Za-z][\w .-]{0,39}?)\s*\}\}/g;

/** Unique variable names, in first-appearance order. */
export function extractVariables(text) {
  const seen = new Map();
  for (const m of String(text ?? '').matchAll(VAR_RE)) {
    const key = m[1].toLowerCase();
    if (!seen.has(key)) seen.set(key, m[1]);
  }
  return [...seen.values()];
}

/**
 * Replace each {{name}} with its value (matched case-insensitively). A blank
 * value leaves the placeholder in place, so nothing silently disappears.
 */
export function fillTemplate(text, values = {}) {
  const lookup = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), String(v ?? '').trim()]));
  return String(text ?? '').replace(VAR_RE, (whole, name) => lookup.get(name.toLowerCase()) || whole);
}
