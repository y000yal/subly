export interface SubtitleCue {
  /** Plain text, lines separated by \n. */
  text: string;
  /** Sanitized minimal markup (b/i/u/br/em/strong) when the source provides it. */
  html?: string;
}

export type CueListener = (cue: SubtitleCue | null) => void;

export interface SubtitleSource {
  readonly kind: 'texttrack' | 'dom-overlay';
  start(onCue: CueListener): void;
  stop(): void;
  /** Live confidence 0..1; the arbiter polls this and it may change mid-session. */
  confidence(): number;
}
