// Heuristic subtitle source: site-rendered caption overlays (YouTube, Netflix
// style). Strictly generic — geometry, text shape, mutation cadence, and
// pattern hints. Never site-specific selectors.
//
// The overlay element stays in the page when the video moves to the PiP
// window, and the site keeps updating it; geometry checks therefore compare
// against a reference rect callback (the placeholder once the video has moved).

import type { CueListener, SubtitleCue, SubtitleSource } from './types';
import { hasTimeControlHint, looksLikeTimeDisplay, normalizeText } from './sanitize';
import { diag } from '@/shared/diag';

const HINT_RE = /(caption|subtitle|subtit|timedtext|\bcue\b|\bsubs\b)/i;
const MAX_TEXT_LEN = 220;
const MAX_LINES = 4;
const MAX_TRACKED = 50;
const SWEEP_NODE_BUDGET = 4000;
const CADENCE_MIN_MS = 250;
const CADENCE_MAX_MS = 20_000;
const STALE_AFTER_MS = 45_000;
const CHOOSE_THRESHOLD = 0.35;

interface Tracked {
  el: Element;
  changeTimes: number[];
  hintBonus: number;
}

export class DomOverlaySource implements SubtitleSource {
  readonly kind = 'dom-overlay' as const;

  private onCue: CueListener = () => {};
  private observers: MutationObserver[] = [];
  private container: Element | null = null;
  private tracked = new Map<Element, Tracked>();
  private chosen: Tracked | null = null;
  private lastEmitted: string | null = null;
  private lastChangeAt = 0;
  private flushScheduled = false;
  private pendingTargets = new Set<Element>();
  private healTimer: ReturnType<typeof setInterval> | undefined;
  private observedRoot: Element | null = null;
  private rawMutations = 0;
  private lastStatsAt = 0;

  constructor(
    private readonly video: HTMLVideoElement,
    /** Current video footprint in the page (placeholder rect after the move). */
    private readonly getRefRect: () => DOMRect,
  ) {}

  start(onCue: CueListener): void {
    this.onCue = onCue;
    this.lastChangeAt = Date.now();
    this.video.addEventListener('timeupdate', this.pollChosen);
    this.arm('start');
    // Self-heal: players (Playerjs, JW, custom SPAs) often REBUILD their DOM
    // when real playback begins or quality switches — leaving our observers
    // attached to a detached subtree that never reports again. Re-arm whenever
    // the observed container falls out of the document.
    this.healTimer = setInterval(() => {
      const root = this.observedRoot;
      if (root && !root.isConnected && this.video.isConnected) {
        diag('dom-overlay/rearm', { rawMutations: this.rawMutations });
        this.disconnectObservers();
        this.tracked.clear();
        this.chosen = null;
        this.arm('rearm');
      }
      // Captions may appear long after attach (CC enabled later, caption layer
      // built lazily). While nothing is chosen, re-run the cheap hint sweep.
      if (!this.chosen && this.observedRoot) {
        this.initialSweep([this.observedRoot]);
      }
      // Heartbeat so the diag trail distinguishes "no mutations arriving"
      // from "mutations rejected by heuristics".
      if (Date.now() - this.lastStatsAt > 4000) {
        this.lastStatsAt = Date.now();
        diag('dom-overlay/stats', {
          raw: this.rawMutations,
          tracked: this.tracked.size,
          chosen: this.chosen ? tagOf(this.chosen.el) : null,
          chosenConnected: this.chosen?.el.isConnected ?? null,
          rootConnected: this.observedRoot?.isConnected ?? null,
          videoConnected: this.video.isConnected,
        });
      }
    }, 2000);
  }

  private arm(why: string): void {
    // The walk-based player container is only the boundary for the
    // caption-block walk. OBSERVATION covers the video's entire document:
    // React portals, body-level overlay layers, and full-viewport app stacks
    // routinely render captions outside any "player container" — geometry
    // checks already constrain candidates to the video footprint.
    this.container = findPlayerContainer(this.video);
    this.observedRoot = this.video.ownerDocument.documentElement;
    diag('dom-overlay/armed', {
      why,
      container: this.container ? tagOf(this.container) : null,
      videoDoc: this.video.ownerDocument === document ? 'same' : 'child',
    });
    if (!this.observedRoot) return;

    const roots: (Element | ShadowRoot)[] = [this.observedRoot];
    collectShadowRoots(this.observedRoot, roots, SWEEP_NODE_BUDGET);

    for (const root of roots) {
      const observer = new MutationObserver(this.onMutations);
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden'],
      });
      this.observers.push(observer);
    }

    this.initialSweep(roots);
  }

  private disconnectObservers(): void {
    for (const o of this.observers) o.disconnect();
    this.observers = [];
  }

  stop(): void {
    this.video.removeEventListener('timeupdate', this.pollChosen);
    clearInterval(this.healTimer);
    this.disconnectObservers();
    this.tracked.clear();
    this.chosen = null;
  }

  confidence(): number {
    if (!this.chosen) return 0;
    const changes = this.chosen.changeTimes.length;
    let c = Math.min(0.9, 0.3 + this.chosen.hintBonus + Math.min(changes, 4) * 0.12);
    // decay when the overlay stops tracking playback
    const playing = !this.video.paused && !this.video.ended;
    if (playing && this.lastChangeAt > 0 && Date.now() - this.lastChangeAt > STALE_AFTER_MS) {
      c = Math.min(c, 0.3);
    }
    return c;
  }

  // ---- mutation handling -------------------------------------------------

  /** Re-read the chosen overlay on playback ticks (not only on DOM mutations). */
  private pollChosen = (): void => {
    this.emitFromChosen();
  };

  private onMutations = (mutations: MutationRecord[]): void => {
    this.rawMutations += mutations.length;
    for (const m of mutations) {
      const target =
        m.type === 'characterData' ? m.target.parentElement : (m.target as Element | null);
      if (!target || !(target instanceof Element)) continue;
      if (target.closest('[data-pip-subs]')) continue; // ignore our own UI
      this.pendingTargets.add(target);
    }
    if (!this.flushScheduled && this.pendingTargets.size > 0) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  };

  private flush(): void {
    this.flushScheduled = false;
    const targets = [...this.pendingTargets];
    this.pendingTargets.clear();
    const now = Date.now();

    for (const target of targets) {
      const block = this.captionBlockFor(target);
      if (!block) continue;
      let tracked = this.tracked.get(block);
      if (!tracked) {
        if (this.tracked.size >= MAX_TRACKED) this.pruneTracked();
        tracked = { el: block, changeTimes: [], hintBonus: hintBonus(block) };
        this.tracked.set(block, tracked);
      }
      const last = tracked.changeTimes[tracked.changeTimes.length - 1];
      if (last === undefined || now - last >= CADENCE_MIN_MS) {
        tracked.changeTimes.push(now);
        if (tracked.changeTimes.length > 12) tracked.changeTimes.shift();
      }
    }

    this.choose();
    this.emitFromChosen();
  }

  /** Walk up from a mutated node to the best-fitting caption block element. */
  private captionBlockFor(target: Element): Element | null {
    let el: Element | null = target;
    let best: Element | null = null;
    for (let depth = 0; el && depth < 5; depth++) {
      if (el === this.container) break;
      if (this.passesShape(el)) best = el;
      el = el.parentElement;
    }
    return best;
  }

  private passesShape(el: Element): boolean {
    if (!el.isConnected) return false;
    if (el.querySelector('video, iframe, input, button, select, textarea, a[href]')) return false;

    const text = normalizeText(readElementText(el));
    if (text.length === 0 || text.length > MAX_TEXT_LEN) return false;
    if (text.split('\n').length > MAX_LINES) return false;
    if (hasTimeControlHint(el)) return false;
    if (looksLikeTimeDisplay(text)) return false;

    const ref = this.getRefRect();
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (rect.height > ref.height * 0.45) return false;
    if (rect.width > ref.width * 1.1) return false;
    // must overlap the video footprint
    const overlapX = Math.min(rect.right, ref.right) - Math.max(rect.left, ref.left);
    const overlapY = Math.min(rect.bottom, ref.bottom) - Math.max(rect.top, ref.top);
    if (overlapX <= 0 || overlapY <= 0) return false;

    const win = el.ownerDocument.defaultView;
    if (win) {
      const style = win.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (Number(style.opacity) < 0.05) return false;
    }
    return true;
  }

  private choose(): void {
    let best: Tracked | null = null;
    let bestScore = 0;
    for (const tracked of this.tracked.values()) {
      if (!tracked.el.isConnected || !this.passesShape(tracked.el)) continue;
      const cadence = cadenceScore(tracked.changeTimes);
      let score = tracked.hintBonus + cadence;
      const ref = this.getRefRect();
      const rect = tracked.el.getBoundingClientRect();
      // bottom-third placement is the strongest generic caption signal
      if (rect.top > ref.top + ref.height * 0.55) score += 0.12;
      if (score > bestScore) {
        bestScore = score;
        best = tracked;
      }
    }
    if (best && bestScore >= CHOOSE_THRESHOLD && best !== this.chosen) {
      this.chosen = best;
      this.lastEmitted = null; // force re-emit from the new element
      diag('dom-overlay/chosen', {
        el: tagOf(best.el),
        score: +bestScore.toFixed(2),
        changes: best.changeTimes.length,
        tracked: this.tracked.size,
      });
    }
    if (this.chosen && !this.chosen.el.isConnected) {
      this.chosen = null;
      this.emit(null);
    }
  }

  private emitFromChosen(): void {
    if (!this.chosen) return;
    const el = this.chosen.el;
    if (!el.isConnected || !this.passesShape(el)) {
      this.emit(null);
      return;
    }
    const text = normalizeText(readElementText(el));
    if (text === this.lastEmitted) return;
    this.lastEmitted = text;
    this.lastChangeAt = Date.now();
    if (text && looksLikeTimeDisplay(text)) {
      this.emit(null);
      return;
    }
    this.emit(text ? { text } : null);
  }

  private emit(cue: SubtitleCue | null): void {
    if (cue === null) this.lastEmitted = null;
    this.onCue(cue);
  }

  private pruneTracked(): void {
    let worst: Element | null = null;
    let worstScore = Infinity;
    for (const [el, t] of this.tracked) {
      if (t === this.chosen) continue;
      const s = t.hintBonus + cadenceScore(t.changeTimes);
      if (s < worstScore) {
        worstScore = s;
        worst = el;
      }
    }
    if (worst) this.tracked.delete(worst);
  }

  private initialSweep(roots: (Element | ShadowRoot)[]): void {
    // Captions may already be on screen before any mutation fires.
    let budget = SWEEP_NODE_BUDGET;
    for (const root of roots) {
      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (budget-- <= 0) break;
        if (el.childElementCount > 3 || this.tracked.has(el)) continue;
        const bonus = hintBonus(el);
        if (bonus > 0 && this.passesShape(el)) {
          this.tracked.set(el, { el, changeTimes: [Date.now()], hintBonus: bonus });
        }
      }
    }
    this.choose();
    this.emitFromChosen();
  }
}

// ---- helpers --------------------------------------------------------------

/**
 * Nearest ancestor that looks like the player container: roughly the video's
 * footprint (caption overlays are near-always inside it).
 */
function findPlayerContainer(video: HTMLVideoElement): Element | null {
  const videoRect = video.getBoundingClientRect();
  const videoArea = Math.max(1, videoRect.width * videoRect.height);
  // The video may live in a same-origin CHILD document (engine running in an
  // ancestor frame) — always walk against ITS document, not ours.
  const ownBody = video.ownerDocument.body;
  let el: Element | null = video.parentElement;
  let candidate: Element | null = video.parentElement;
  for (let depth = 0; el && el !== ownBody && depth < 8; depth++) {
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > videoArea * 3.5) break; // grew past the player
    candidate = el;
    el = el.parentElement;
  }
  return candidate;
}

function tagOf(el: Element): string {
  const cls = typeof el.className === 'string' ? el.className.split(/\s+/)[0] ?? '' : '';
  return `${el.tagName}#${el.id}${cls ? '.' + cls : ''}`;
}

function collectShadowRoots(
  root: Element | ShadowRoot,
  out: (Element | ShadowRoot)[],
  budget: number,
): void {
  const all = root.querySelectorAll('*');
  let remaining = budget;
  for (const el of all) {
    if (remaining-- <= 0) return;
    if (el.shadowRoot) {
      out.push(el.shadowRoot);
      collectShadowRoots(el.shadowRoot, out, remaining);
    }
  }
}

function readElementText(el: Element): string {
  try {
    const inner = (el as HTMLElement).innerText;
    if (typeof inner === 'string') return inner;
  } catch {
    // innerText can throw on rare cross-document nodes
  }
  return el.textContent ?? '';
}

function hintBonus(el: Element): number {
  let bonus = 0;
  let cur: Element | null = el;
  for (let i = 0; cur && i < 4; i++) {
    const idClass = `${cur.id} ${cur.className && typeof cur.className === 'string' ? cur.className : ''}`;
    if (HINT_RE.test(idClass)) {
      bonus = Math.max(bonus, 0.35);
      break;
    }
    if (cur.getAttribute('aria-live')) bonus = Math.max(bonus, 0.15);
    cur = cur.parentElement;
  }
  const win = el.ownerDocument.defaultView;
  if (win && win.getComputedStyle(el).pointerEvents === 'none') bonus += 0.05;
  return bonus;
}

function cadenceScore(times: number[]): number {
  if (times.length < 2) return times.length * 0.08;
  let good = 0;
  for (let i = 1; i < times.length; i++) {
    const cur = times[i];
    const prev = times[i - 1];
    if (cur === undefined || prev === undefined) continue;
    const delta = cur - prev;
    if (delta >= CADENCE_MIN_MS && delta <= CADENCE_MAX_MS) good++;
  }
  return Math.min(0.6, good * 0.15);
}
