// Namespaced logger. Silent by default; enable via
// chrome.storage.local.set({ pipDebug: true }) or localStorage.pipDebug = '1'.

let enabled = false;

try {
  if (typeof localStorage !== 'undefined' && localStorage.getItem('pipDebug')) enabled = true;
} catch {
  // storage access can throw in sandboxed frames
}
try {
  chrome.storage?.local.get('pipDebug').then((v) => {
    if (v['pipDebug']) enabled = true;
  });
} catch {
  // chrome.storage unavailable in some contexts
}

export function createLogger(ns: string) {
  const prefix = `[pip-subs:${ns}]`;
  return {
    debug: (...args: unknown[]) => enabled && console.debug(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  };
}
