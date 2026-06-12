// Resizes assets/icon-128.png to all required extension icon sizes.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'assets', 'icon-128.png');
const outDir = join(root, 'src', 'public', 'icon');
mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 96, 128]) {
  await sharp(src)
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .png()
    .toFile(join(outDir, `${size}.png`));
  console.log(`icon/${size}.png`);
}
