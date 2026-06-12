// Unlisted script entrypoint: built as a standalone chunk (/engine.js) that the
// background injects into each frame on activation via executeScript({ files }).

import { registerEngine } from '@/engine';

export default defineUnlistedScript(() => {
  registerEngine();
});
