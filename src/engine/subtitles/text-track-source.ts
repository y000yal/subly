// Structured subtitle source: HTMLVideoElement TextTracks. Covers players that
// use the platform track model (hls.js, Shaka, Video.js, JW, native <track>).
// Tracks with mode 'hidden' still fire cuechange — many players keep them
// hidden and paint cues themselves, which is exactly the signal we want.

import type { CueListener, SubtitleCue, SubtitleSource } from './types';
import { normalizeText, sanitizeNode } from './sanitize';
import { diag } from '@/shared/diag';

const MODE_POLL_MS = 1000; // mode changes fire no event
const RECENT_CUE_WINDOW_MS = 60_000;

export class TextTrackSource implements SubtitleSource {
  readonly kind = 'texttrack' as const;

  private onCue: CueListener = () => {};
  private selected: TextTrack[] = [];
  private selectedFromShowing = false;
  private lastCueAt = 0;
  private sawAnyCue = false;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private emittedNull = true;
  private lastEmittedText: string | null = null;

  constructor(private readonly video: HTMLVideoElement) {}

  start(onCue: CueListener): void {
    this.onCue = onCue;
    this.video.textTracks.addEventListener('addtrack', this.reselect);
    this.video.textTracks.addEventListener('removetrack', this.reselect);
    this.reselect();
    this.pollTimer = setInterval(this.reselect, MODE_POLL_MS);
    this.video.addEventListener('timeupdate', this.pollActiveCues);
  }

  stop(): void {
    clearInterval(this.pollTimer);
    this.video.removeEventListener('timeupdate', this.pollActiveCues);
    this.video.textTracks.removeEventListener('addtrack', this.reselect);
    this.video.textTracks.removeEventListener('removetrack', this.reselect);
    for (const track of this.selected) track.removeEventListener('cuechange', this.handleCueChange);
    this.selected = [];
  }

  confidence(): number {
    if (this.selected.length === 0) return 0;
    const recent = Date.now() - this.lastCueAt < RECENT_CUE_WINDOW_MS;
    if (this.sawAnyCue && recent) return this.selectedFromShowing ? 0.9 : 0.65;
    if (this.sawAnyCue) return 0.45; // had cues once, long silence — let DOM compete
    return 0.55; // selected but unproven yet
  }

  /** Some players delay cuechange when the video is off-screen / in PiP. */
  private pollActiveCues = (): void => {
    if (this.selected.length > 0) this.handleCueChange();
  };

  private reselect = (): void => {
    const tracks = Array.from(this.video.textTracks).filter(
      (t) => t.kind === 'subtitles' || t.kind === 'captions',
    );
    const showing = tracks.filter((t) => t.mode === 'showing');
    const hidden = tracks.filter((t) => t.mode === 'hidden');
    const next = showing.length > 0 ? showing : hidden;
    const nextFromShowing = showing.length > 0;

    const same =
      next.length === this.selected.length && next.every((t, i) => t === this.selected[i]);
    if (same) return;

    for (const track of this.selected) track.removeEventListener('cuechange', this.handleCueChange);
    this.selected = next;
    this.selectedFromShowing = nextFromShowing;
    for (const track of next) track.addEventListener('cuechange', this.handleCueChange);
    diag('texttrack/select', {
      selected: next.map((t) => `${t.kind}:${t.label || '?'}:${t.mode}`),
      total: this.video.textTracks.length,
    });

    if (next.length === 0) {
      this.emit(null);
    } else {
      this.handleCueChange(); // pick up any cue already active
    }
  };

  private handleCueChange = (): void => {
    const texts: string[] = [];
    const htmls: string[] = [];
    let anyHtml = false;

    for (const track of this.selected) {
      const cues = track.activeCues;
      if (!cues) continue;
      for (let i = 0; i < cues.length; i++) {
        const cue = cues[i];
        if (!cue) continue;
        const vtt = cue as VTTCue;
        if (typeof vtt.getCueAsHTML === 'function') {
          const html = sanitizeNode(vtt.getCueAsHTML());
          htmls.push(html);
          anyHtml = anyHtml || html !== '';
          texts.push(normalizeText(vtt.text ?? ''));
        } else {
          const raw = (cue as unknown as { text?: string }).text;
          if (typeof raw === 'string') {
            texts.push(normalizeText(raw));
            htmls.push('');
          }
        }
      }
    }

    const text = texts.filter(Boolean).join('\n');
    if (!text) {
      if (this.lastEmittedText !== null) {
        this.lastEmittedText = null;
        this.emit(null);
      }
      return;
    }
    if (text === this.lastEmittedText) return;
    this.lastEmittedText = text;
    this.lastCueAt = Date.now();
    this.sawAnyCue = true;
    const cue: SubtitleCue = { text };
    if (anyHtml) cue.html = htmls.filter(Boolean).join('<br>');
    this.emit(cue);
  };

  private emit(cue: SubtitleCue | null): void {
    if (cue === null && this.emittedNull) return;
    this.emittedNull = cue === null;
    this.onCue(cue);
  }
}
