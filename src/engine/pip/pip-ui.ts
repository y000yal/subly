// DOM and styling of the Document PiP window: video stage, subtitle overlay,
// auto-hiding control bar. No framework — this surface must stay tiny and is
// fully owned by us (no site CSS can reach it).

import type { SubtitleCue } from '../subtitles/types';
import type { SubtitleSettings } from '@/shared/settings';
import { bgRgba, saveSettings } from '@/shared/settings';

export interface PipUI {
  stage: HTMLElement;
  renderCue(cue: SubtitleCue | null): void;
  applySettings(s: SubtitleSettings): void;
  /** Wire the control bar to a media element. Call again if the element is swapped. */
  bindVideo(video: HTMLVideoElement): void;
  destroy(): void;
}

const SHEET = `
  html, body { margin: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
  * { box-sizing: border-box; }
  .stage { position: absolute; inset: 0; }
  .stage video {
    width: 100% !important; height: 100% !important;
    max-width: none !important; max-height: none !important;
    position: static !important; object-fit: contain; background: #000;
  }
  .subs {
    position: absolute; left: 4%; right: 4%; display: flex; justify-content: center;
    pointer-events: none; z-index: 5; transition: bottom .15s ease;
  }
  .subs.pos-bottom { bottom: 7%; }
  .subs.pos-top { top: 5%; }
  body.show-controls .subs.pos-bottom { bottom: 52px; }
  .subs .cue {
    display: none;
    font: 600 calc(var(--sub-size) * 1vh) / 1.35 var(--sub-font);
    color: var(--sub-color); background: var(--sub-bg);
    padding: 0.12em 0.45em; border-radius: 0.22em;
    text-align: center; white-space: pre-wrap; max-width: 100%;
    text-shadow: var(--sub-edge);
  }
  .subs .cue.visible { display: inline-block; }
  .controls {
    position: absolute; left: 0; right: 0; bottom: 0; z-index: 10;
    display: flex; align-items: center; gap: 8px; padding: 10px 12px 8px;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.8));
    opacity: 0; pointer-events: none; transition: opacity .2s ease;
  }
  body.show-controls .controls { opacity: 1; pointer-events: auto; }
  .controls button {
    background: rgba(255, 255, 255, 0.12); color: #f3f4f6; border: 0; border-radius: 6px;
    font: 600 13px/1 system-ui, sans-serif; padding: 7px 9px; cursor: pointer; flex: none;
  }
  .controls button:hover { background: rgba(255, 255, 255, 0.25); }
  .controls input[type="range"] { flex: 1; min-width: 40px; accent-color: #60a5fa; cursor: pointer; }
  .controls input[type="range"].hidden { visibility: hidden; }
  .controls input[type="range"].vol { flex: none; width: 60px; }
  .controls .time { font: 11px/1 system-ui, sans-serif; color: #d1d5db; flex: none; min-width: 76px; text-align: center; }
`;

export function createPipUI(
  pipWindow: Window,
  settings: SubtitleSettings,
  hooks: { onRequestClose: () => void },
): PipUI {
  const doc = pipWindow.document;
  doc.title = 'Captiv - Picture in Picture with Subtitles';

  const style = doc.createElement('style');
  style.textContent = SHEET;
  doc.head.appendChild(style);

  const stage = doc.createElement('div');
  stage.className = 'stage';

  const subs = doc.createElement('div');
  subs.className = 'subs pos-bottom';
  const cueEl = doc.createElement('span');
  cueEl.className = 'cue';
  subs.appendChild(cueEl);

  const controls = doc.createElement('div');
  controls.className = 'controls';
  controls.setAttribute('data-captiv', 'controls');
  const playBtn = button(doc, '⏸');
  const seek = doc.createElement('input');
  seek.type = 'range';
  seek.min = '0';
  seek.step = '0.1';
  seek.value = '0';
  const time = doc.createElement('span');
  time.className = 'time';
  time.setAttribute('data-captiv', 'time');
  time.textContent = '–:– / –:–';
  const volBtn = button(doc, '🔊');
  volBtn.title = 'Toggle mute';
  const volSlider = doc.createElement('input');
  volSlider.type = 'range';
  volSlider.className = 'vol';
  volSlider.min = '0';
  volSlider.max = '1';
  volSlider.step = '0.02';
  volSlider.value = '1';
  volSlider.title = 'Volume';
  const rewind = button(doc, '⏪10');
  rewind.title = 'Rewind 10 seconds';
  const forward = button(doc, '10⏩');
  forward.title = 'Forward 10 seconds';
  const smaller = button(doc, 'A−');
  smaller.title = 'Smaller subtitles';
  const bigger = button(doc, 'A+');
  bigger.title = 'Bigger subtitles';
  const back = button(doc, '↩ Tab');
  back.title = 'Back to tab';
  controls.append(playBtn, rewind, seek, time, forward, volBtn, volSlider, smaller, bigger, back);

  doc.body.append(stage, subs, controls);

  // --- auto-hide controls ---
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const poke = () => {
    doc.body.classList.add('show-controls');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => doc.body.classList.remove('show-controls'), 2500);
  };
  const keepVisible = () => {
    doc.body.classList.add('show-controls');
    clearTimeout(hideTimer);
  };
  doc.addEventListener('mousemove', poke);
  doc.addEventListener('click', poke);
  poke();

  // --- subtitle size quick-adjust; persists, applied back via watchSettings ---
  let currentFontPct = settings.fontSizePct;
  smaller.addEventListener('click', () => {
    void saveSettings({ fontSizePct: Math.max(2, +(currentFontPct - 0.5).toFixed(1)) });
  });
  bigger.addEventListener('click', () => {
    void saveSettings({ fontSizePct: Math.min(14, +(currentFontPct + 0.5).toFixed(1)) });
  });
  back.addEventListener('click', () => hooks.onRequestClose());

  // --- media binding ---
  let bound: HTMLVideoElement | null = null;
  let boundCleanup: (() => void) | null = null;
  let dragging = false;

  function bindVideo(video: HTMLVideoElement): void {
    boundCleanup?.();
    bound = video;

    const fmt = (s: number) => {
      if (!Number.isFinite(s)) return '–:–';
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${String(sec).padStart(2, '0')}`;
    };

    const syncPlayState = () => {
      const paused = video.paused;
      playBtn.textContent = paused ? '⏵' : '⏸';
      // Keep controls visible while paused so the user can see the play button.
      if (paused) keepVisible();
    };

    const syncTime = () => {
      const live = !Number.isFinite(video.duration);
      seek.classList.toggle('hidden', live);
      if (!live) {
        seek.max = String(video.duration || 0);
        if (!dragging) seek.value = String(video.currentTime);
      }
      time.textContent = live
        ? `LIVE ${fmt(video.currentTime)}`
        : `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
    };

    const syncVolume = () => {
      const muted = video.muted || video.volume === 0;
      const v = video.volume;
      volBtn.textContent = muted ? '🔇' : v < 0.33 ? '🔈' : v < 0.66 ? '🔉' : '🔊';
      if (!muted) volSlider.value = String(v);
    };

    const onPlayClick = () => {
      if (video.paused) void video.play().catch(() => {});
      else video.pause();
    };
    const onRewind = () => { video.currentTime = Math.max(0, video.currentTime - 10); };
    const onForward = () => { video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10); };
    const onSeekInput = () => {
      dragging = true;
      time.textContent = `${fmt(Number(seek.value))} / ${fmt(video.duration)}`;
    };
    const onSeekChange = () => {
      dragging = false;
      video.currentTime = Number(seek.value);
    };
    const onVolBtnClick = () => {
      video.muted = !video.muted;
    };
    const onVolSliderInput = () => {
      video.volume = Number(volSlider.value);
      video.muted = video.volume === 0;
    };

    playBtn.addEventListener('click', onPlayClick);
    rewind.addEventListener('click', onRewind);
    forward.addEventListener('click', onForward);
    seek.addEventListener('input', onSeekInput);
    seek.addEventListener('change', onSeekChange);
    volBtn.addEventListener('click', onVolBtnClick);
    volSlider.addEventListener('input', onVolSliderInput);
    video.addEventListener('play', syncPlayState);
    video.addEventListener('pause', syncPlayState);
    video.addEventListener('timeupdate', syncTime);
    video.addEventListener('durationchange', syncTime);
    video.addEventListener('volumechange', syncVolume);
    syncPlayState();
    syncTime();
    syncVolume();

    boundCleanup = () => {
      playBtn.removeEventListener('click', onPlayClick);
      rewind.removeEventListener('click', onRewind);
      forward.removeEventListener('click', onForward);
      seek.removeEventListener('input', onSeekInput);
      seek.removeEventListener('change', onSeekChange);
      volBtn.removeEventListener('click', onVolBtnClick);
      volSlider.removeEventListener('input', onVolSliderInput);
      video.removeEventListener('play', syncPlayState);
      video.removeEventListener('pause', syncPlayState);
      video.removeEventListener('timeupdate', syncTime);
      video.removeEventListener('durationchange', syncTime);
      video.removeEventListener('volumechange', syncVolume);
    };
  }

  function applySettings(s: SubtitleSettings): void {
    currentFontPct = s.fontSizePct;
    const root = doc.documentElement;
    root.style.setProperty('--sub-size', String(s.fontSizePct));
    root.style.setProperty('--sub-color', s.textColor);
    root.style.setProperty('--sub-bg', bgRgba(s));
    root.style.setProperty(
      '--sub-font',
      s.fontFamily === 'sans-serif'
        ? 'system-ui, "Segoe UI", Roboto, sans-serif'
        : s.fontFamily,
    );
    const edge =
      s.edgeStyle === 'shadow'
        ? '0 0 4px rgba(0,0,0,.95), 0 1px 2px rgba(0,0,0,.9)'
        : s.edgeStyle === 'outline'
          ? '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000'
          : 'none';
    root.style.setProperty('--sub-edge', edge);
    subs.classList.toggle('pos-bottom', s.position === 'bottom');
    subs.classList.toggle('pos-top', s.position === 'top');
  }

  function renderCue(cue: SubtitleCue | null): void {
    if (!cue || (!cue.text && !cue.html)) {
      cueEl.classList.remove('visible');
      cueEl.textContent = '';
      return;
    }
    if (cue.html) cueEl.innerHTML = cue.html; // sanitized upstream
    else cueEl.textContent = cue.text;
    cueEl.classList.add('visible');
  }

  applySettings(settings);

  return {
    stage,
    renderCue,
    applySettings,
    bindVideo,
    destroy: () => {
      boundCleanup?.();
      bound = null;
      clearTimeout(hideTimer);
    },
  };
}

function button(doc: Document, label: string): HTMLButtonElement {
  const b = doc.createElement('button');
  b.textContent = label;
  return b;
}
