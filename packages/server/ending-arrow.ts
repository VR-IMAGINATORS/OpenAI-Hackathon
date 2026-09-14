import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

/** Use the same committed artwork in development and in the built server. */
export async function addEndingArrow(frame: Buffer): Promise<Buffer> {
  const source = new URL('../../apps/web/public/images/to-be-continued.png', import.meta.url);
  const deployed = new URL('../../../web/images/to-be-continued.png', import.meta.url);
  const artwork = await readFile(existsSync(source) ? source : deployed);
  // Crop only the surrounding black margins; keep the arrow and lettering intact.
  const overlay = await sharp(artwork)
    .extract({ left: 0, top: 320, width: 1536, height: 384 })
    .resize({ width: 560 })
    .png()
    .toBuffer();
  return sharp(frame)
    .composite([{ input: overlay, left: 382, top: 802 }])
    .jpeg({ quality: 75 })
    .toBuffer();
}
