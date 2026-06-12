// Cue text/markup sanitizing. Only inert inline formatting survives; everything
// else is unwrapped to text. Output is injected into the PiP window we own.

const ALLOWED_TAGS = new Set(['B', 'I', 'U', 'EM', 'STRONG', 'BR', 'RUBY', 'RT']);

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Serialize a node tree keeping only allowed inline formatting tags. */
export function sanitizeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.textContent ?? '');
  if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    const children = Array.from(node.childNodes).map(sanitizeNode).join('');
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = (node as Element).tagName;
      if (tag === 'BR') return '<br>';
      if (ALLOWED_TAGS.has(tag)) {
        const t = tag.toLowerCase();
        return `<${t}>${children}</${t}>`;
      }
    }
    return children;
  }
  return '';
}

/** Coerce unknown values (e.g. odd innerText) to a safe string. */
export function coerceText(value: unknown): string {
  if (value == null) return '';
  return typeof value === 'string' ? value : String(value);
}

/** Collapse runs of spaces/tabs per line, trim, drop empty lines. */
export function normalizeText(s: unknown): string {
  return coerceText(s)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** Player seek clocks — not caption overlays. */
const TIME_HINT_RE = /\b(time|duration|timestamp|clock|remaining|elapsed|current-?time)\b/i;
const TIME_DISPLAY_RE =
  /^(?:LIVE\s+)?(?:(?:\d{1,2}:\d{2}(?::\d{2})?)|(?:[–—\-]|–:–))(?:\s*\/\s*(?:(?:\d{1,2}:\d{2}(?::\d{2})?)|(?:[–—\-]|–:–)))?$/i;

export function looksLikeTimeDisplay(text: unknown): boolean {
  const t = coerceText(text).trim();
  if (!t || t.includes('\n')) return false;
  return TIME_DISPLAY_RE.test(t);
}

export function hasTimeControlHint(el: Element): boolean {
  let cur: Element | null = el;
  for (let i = 0; cur && i < 5; i++) {
    const idClass = `${cur.id} ${typeof cur.className === 'string' ? cur.className : ''}`;
    if (TIME_HINT_RE.test(idClass)) return true;
    cur = cur.parentElement;
  }
  return false;
}
