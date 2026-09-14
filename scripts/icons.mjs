import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

const colors = { background: [26, 6, 17], sigil: [255, 150, 200], frame: [216, 154, 171] };
const crcTable = Array.from({ length: 256 }, (_, byte) => { // Precomputes PNG's CRC-32 table using its standard polynomial.
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function chunk(type, data) { // Encodes a PNG chunk with its length and integrity checksum.
  const name = Buffer.from(type);
  const payload = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of payload) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  payload.copy(output, 4);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}

function colorAt(x, y) { // Draws the vector terminal sigil inside the maskable safe zone, with a decorative outer frame.
  const dx = Math.abs(x - .5), dy = Math.abs(y - .5);
  const outer = Math.max(dx, dy);
  if (outer >= .405 && outer <= .411) return colors.frame;
  if (dx + dy < .075) return colors.background;
  if (outer + 3 * Math.min(dx, dy) <= .32) return colors.sigil;
  return colors.background;
}

function notificationColorAt(x, y, badge = false) {
  const dx = Math.abs(x - .5), dy = Math.abs(y - .5);
  const inside = Math.max(dx, dy) + 2.6 * Math.min(dx, dy) <= .45;
  const center = dx + dy < .175;
  if (badge) return [255, 255, 255, inside && !center ? 255 : 0];
  return center ? [26, 6, 17] : inside ? [173, 60, 121] : [255, 245, 250];
} // Match the header's four-point Little Log sigil; the badge uses alpha instead of an opaque background.

function png(size, sample = colorAt, channels = 3) { // Builds antialiased RGB/RGBA PNGs with Node built-ins, avoiding any runtime icon dependency.
  const raw = Buffer.alloc(size * (1 + size * channels));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = Array(channels).fill(0);
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
        const pixel = sample((x + (sx + .5) / 3) / size, (y + (sy + .5) / 3) / size);
        for (let channel = 0; channel < channels; channel++) sum[channel] += pixel[channel];
      }
      const offset = y * (1 + size * channels) + 1 + x * channels;
      for (let channel = 0; channel < channels; channel++) raw[offset + channel] = Math.round(sum[channel] / 9);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

await mkdir(new URL('../icons/', import.meta.url), { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['maskable-512.png', 512], ['apple-touch-icon.png', 180]]) {
  await writeFile(new URL(`../icons/${name}`, import.meta.url), png(size));
}
await writeFile(new URL('../icons/notification-icon.png', import.meta.url), png(192, notificationColorAt));
await writeFile(new URL('../icons/notification-badge.png', import.meta.url), png(96, (x, y) => notificationColorAt(x, y, true), 4));
console.log('Generated four install icons and Little Log notification icon/badge.');
