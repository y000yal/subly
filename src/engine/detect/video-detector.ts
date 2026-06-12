// Frame-local video discovery and scoring. Generic only: walks the document,
// open shadow roots, and accessible (same-origin) child frame documents.
// A frame whose PARENT is same-origin reports coveredByParent=true so the
// parent's scan owns its videos and the election never sees duplicates.

import type { FrameScanResult, VideoCandidateInfo } from '@/shared/messages';

const NODE_BUDGET = 25_000;
const MAX_CANDIDATES = 3;

const registry = new Map<string, WeakRef<HTMLVideoElement>>();
const idByVideo = new WeakMap<HTMLVideoElement, string>();
let nextId = 1;

export function scanFrame(): FrameScanResult {
  const isTop = window === window.top;
  let coveredByParent = false;
  if (!isTop) {
    try {
      void window.parent.document; // throws cross-origin
      coveredByParent = true;
    } catch {
      coveredByParent = false;
    }
  }

  const candidates: VideoCandidateInfo[] = [];
  if (!coveredByParent) {
    const videos: HTMLVideoElement[] = [];
    collectVideos(document, videos, { budget: NODE_BUDGET });
    for (const video of videos) {
      const info = scoreVideo(video);
      if (info.score > 0) candidates.push(info);
    }
    candidates.sort((a, b) => b.score - a.score);
    candidates.length = Math.min(candidates.length, MAX_CANDIDATES);
  }

  return { candidates, isTop, coveredByParent };
}

export function resolveCandidate(candidateId: string): HTMLVideoElement | null {
  return registry.get(candidateId)?.deref() ?? null;
}

function collectVideos(
  root: Document | ShadowRoot,
  out: HTMLVideoElement[],
  state: { budget: number },
): void {
  if (state.budget <= 0) return;
  out.push(...root.querySelectorAll('video'));

  const all = root.querySelectorAll('*');
  state.budget -= all.length;
  for (const el of all) {
    if (state.budget <= 0) return;
    if (el.shadowRoot) collectVideos(el.shadowRoot, out, state);
    if (el instanceof HTMLIFrameElement || el instanceof HTMLFrameElement) {
      let childDoc: Document | null = null;
      try {
        childDoc = el.contentDocument; // null when cross-origin
      } catch {
        childDoc = null;
      }
      if (childDoc) collectVideos(childDoc, out, state);
    }
  }
}

function scoreVideo(video: HTMLVideoElement): VideoCandidateInfo {
  const win = video.ownerDocument.defaultView ?? window;
  const rect = video.getBoundingClientRect();

  const visW = Math.max(0, Math.min(rect.right, win.innerWidth) - Math.max(rect.left, 0));
  const visH = Math.max(0, Math.min(rect.bottom, win.innerHeight) - Math.max(rect.top, 0));
  let area = visW * visH;

  const style = win.getComputedStyle(video);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    area = 0;
  }

  const hasSource = Boolean(video.currentSrc || video.src || video.srcObject);
  const playing = !video.paused && !video.ended && video.readyState >= 2;

  let score = area;
  if (!hasSource) score = 0;
  if (playing) score *= 2;
  if (video.muted || video.volume === 0) score *= 0.9;
  if (video.currentTime > 0) score *= 1.2;
  // demote decorative background loops and tiny thumbnails
  if (video.loop && Number.isFinite(video.duration) && video.duration < 10) score *= 0.15;
  if (rect.width < 120 || rect.height < 80) score *= 0.2;

  return {
    candidateId: idFor(video),
    score: Math.round(score),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    playing,
    hasTextTracks: video.textTracks.length > 0,
    drmSuspected: video.mediaKeys != null,
  };
}

function idFor(video: HTMLVideoElement): string {
  let id = idByVideo.get(video);
  if (!id) {
    id = `v${nextId++}`;
    idByVideo.set(video, id);
    registry.set(id, new WeakRef(video));
  }
  return id;
}
