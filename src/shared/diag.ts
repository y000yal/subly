// Session diagnostics trail. Every context (engine frames, background) emits
// small structured events; the background buffers them per tab and forwards
// them to the TOP frame's stub, which mirrors the trail into a hidden DOM node
// (#__pip_subs_diag) so it can be inspected on any page — including when the
// session actually runs in a cross-origin child frame whose console/world is
// unreachable. Low volume (only during activation/sessions), dev-oriented but
// harmless to ship.

export interface DiagEvent {
  ts: number;
  /** Where it happened: 'bg' or frame href tail. */
  ctx: string;
  stage: string;
  data?: unknown;
}

const ctxTag = (() => {
  try {
    if (typeof window === 'undefined') return 'bg';
    const top = window === window.top ? 'top' : 'frame';
    return `${top}:${location.host}`;
  } catch {
    return 'frame:?';
  }
})();

/** Fire-and-forget diagnostic event (content-script contexts). */
export function diag(stage: string, data?: unknown): void {
  try {
    void chrome.runtime
      .sendMessage({ t: 'diag/event', event: { ts: Date.now(), ctx: ctxTag, stage, data } })
      .catch(() => {});
  } catch {
    // extension context gone (reload) — ignore
  }
}
