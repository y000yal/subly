// Subtitle appearance settings, persisted in chrome.storage.sync under one key.
// Every render context (Doc PiP overlay, canvas compositor, options preview)
// reads storage directly and subscribes to changes — no relaying needed.

export interface SubtitleSettings {
  /** Font size as % of PiP window height. */
  fontSizePct: number;
  fontFamily: 'sans-serif' | 'serif' | 'monospace';
  textColor: string;
  bgColor: string;
  bgOpacity: number; // 0..1
  position: 'bottom' | 'top';
  edgeStyle: 'none' | 'shadow' | 'outline';
}

export const DEFAULT_SETTINGS: SubtitleSettings = {
  fontSizePct: 5.5,
  fontFamily: 'sans-serif',
  textColor: '#ffffff',
  bgColor: '#000000',
  bgOpacity: 0.6,
  position: 'bottom',
  edgeStyle: 'shadow',
};

const STORAGE_KEY = 'subtitleSettings';

export async function loadSettings(): Promise<SubtitleSettings> {
  try {
    const stored = await chrome.storage.sync.get(STORAGE_KEY);
    return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEY] as Partial<SubtitleSettings> | undefined) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Partial<SubtitleSettings>): Promise<SubtitleSettings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  return next;
}

/** Subscribe to live settings changes. Returns an unsubscribe function. */
export function watchSettings(cb: (settings: SubtitleSettings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'sync' || !changes[STORAGE_KEY]) return;
    cb({ ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEY].newValue as Partial<SubtitleSettings>) });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** rgba() string from settings bg color + opacity. */
export function bgRgba(s: SubtitleSettings): string {
  const hex = s.bgColor.replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${s.bgOpacity})`;
}
