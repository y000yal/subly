// Unlisted script entrypoint: built as a standalone web-accessible chunk
// (/engine.js) that the content stub dynamic-imports on first activation.

import { registerEngine } from '@/engine';

export default defineUnlistedScript(() => {
  registerEngine();
});
