// Typed access to platform APIs that may be missing from TS lib.dom or from
// the running browser. All feature detection funnels through here.

export interface DocumentPictureInPictureApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  readonly window: Window | null;
}

export function getDocPip(): DocumentPictureInPictureApi | null {
  const api = (window as { documentPictureInPicture?: DocumentPictureInPictureApi })
    .documentPictureInPicture;
  return api ?? null;
}

/**
 * Frame-paced callback loop on a video. Falls back to rAF when
 * requestVideoFrameCallback is unavailable. Returns a cancel function.
 */
export function startFramePump(video: HTMLVideoElement, draw: () => void): () => void {
  let cancelled = false;

  if (typeof video.requestVideoFrameCallback === 'function') {
    let handle = 0;
    const tick: VideoFrameRequestCallback = () => {
      if (cancelled) return;
      draw();
      handle = video.requestVideoFrameCallback(tick);
    };
    handle = video.requestVideoFrameCallback(tick);
    return () => {
      cancelled = true;
      video.cancelVideoFrameCallback(handle);
    };
  }

  // rAF stalls in throttled cross-origin iframes (the usual canvas-PiP context).
  // timeupdate keeps firing during playback even when the frame is backgrounded.
  const onTime = () => {
    if (!cancelled) draw();
  };
  video.addEventListener('timeupdate', onTime);
  return () => {
    cancelled = true;
    video.removeEventListener('timeupdate', onTime);
  };
}

export function captureStreamOf(
  el: HTMLMediaElement | HTMLCanvasElement,
  frameRate?: number,
): MediaStream {
  const target = el as unknown as { captureStream?: (fps?: number) => MediaStream };
  if (typeof target.captureStream !== 'function') {
    throw new Error('captureStream unsupported');
  }
  return frameRate != null ? target.captureStream(frameRate) : target.captureStream();
}
