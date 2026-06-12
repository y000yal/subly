// Runs both subtitle sources and forwards cues from whichever is currently
// most trustworthy. TextTracks win whenever reasonably confident (structured,
// synchronized); the DOM overlay heuristic covers everything else.

import type { CueListener, SubtitleCue } from './types';
import { looksLikeTimeDisplay } from './sanitize';
import { TextTrackSource } from './text-track-source';
import { DomOverlaySource } from './dom-overlay-source';
import { createLogger } from '@/shared/logger';
import { diag } from '@/shared/diag';

const log = createLogger('subs');

const EVAL_MS = 500;
const TT_PRIORITY_THRESHOLD = 0.6;
const DOM_MIN = 0.3;
const TT_MIN = 0.3;

type ActiveKind = 'texttrack' | 'dom-overlay' | null;

export class SubtitleEngine {
  private tt: TextTrackSource | null = null;
  private dom: DomOverlaySource | null = null;
  private latest: Record<'texttrack' | 'dom-overlay', SubtitleCue | null> = {
    texttrack: null,
    'dom-overlay': null,
  };
  private active: ActiveKind = null;
  private listener: CueListener = () => {};
  private timer: ReturnType<typeof setInterval> | undefined;

  attach(video: HTMLVideoElement, getRefRect: () => DOMRect): void {
    this.tt = new TextTrackSource(video);
    this.dom = new DomOverlaySource(video, getRefRect);

    this.tt.start((cue) => {
      this.latest.texttrack = cue;
      if (this.active === 'texttrack') this.listener(cue);
    });
    this.dom.start((cue) => {
      this.latest['dom-overlay'] = cue;
      if (this.active === 'dom-overlay') this.listener(cue);
    });

    this.timer = setInterval(() => this.evaluate(), EVAL_MS);
    this.evaluate();
  }

  onCue(cb: CueListener): void {
    this.listener = cb;
  }

  detach(): void {
    clearInterval(this.timer);
    this.tt?.stop();
    this.dom?.stop();
    this.tt = null;
    this.dom = null;
    this.active = null;
    this.latest = { texttrack: null, 'dom-overlay': null };
  }

  private lastDiagAt = 0;

  private evaluate(): void {
    const ttConf = this.tt?.confidence() ?? 0;
    const domRaw = this.dom?.confidence() ?? 0;
    const domCue = this.latest['dom-overlay'];
    // Ignore DOM overlay when its latest cue is player chrome (seek clock).
    const domConf =
      domRaw > 0 && domCue?.text && !looksLikeTimeDisplay(domCue.text) ? domRaw : 0;

    let next: ActiveKind = null;
    if (ttConf >= TT_PRIORITY_THRESHOLD) next = 'texttrack';
    else if (domConf >= DOM_MIN && domConf > ttConf) next = 'dom-overlay';
    else if (ttConf >= TT_MIN) next = 'texttrack';

    // Heartbeat: confidences every ~4s so the diag trail shows why a source
    // was (not) selected, without flooding it.
    if (Date.now() - this.lastDiagAt > 4000) {
      this.lastDiagAt = Date.now();
      diag('subs/confidence', { tt: +ttConf.toFixed(2), dom: +domConf.toFixed(2), active: next });
    }

    if (next !== this.active) {
      log.debug('subtitle source switch', { from: this.active, to: next, ttConf, domConf });
      diag('subs/switch', { from: this.active, to: next, tt: +ttConf.toFixed(2), dom: +domConf.toFixed(2) });
      this.active = next;
      this.listener(null); // clear stale cue from the previous source
      if (next) this.listener(this.latest[next]);
    }
  }
}
