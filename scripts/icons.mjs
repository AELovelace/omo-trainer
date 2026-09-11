import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

const colors = { background: [238, 232, 250], petal: [174, 145, 206], center: [255, 248, 234] };
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

function colorAt(x, y) { // Rasterizes the existing vector flower with all important artwork inside the maskable safe zone.
  const dx = x - .5, dy = y - .5;
  if (dx * dx + dy * dy < .084 ** 2) return colors.center;
  const diagonal = Math.SQRT1_2;
  for (const [cx, cy, direction] of [[.404, .404, -1], [.596, .404, 1], [.404, .596, 1], [.596, .596, -1]]) {
    const px = x - cx, py = y - cy;
    const u = (px + direction * py) * diagonal;
    const v = (-direction * px + py) * diagonal;
    if ((u / .117) ** 2 + (v / .195) ** 2 <= 1) return colors.petal;
  }
  return colors.background;
}

function png(size) { // Builds antialiased RGB PNGs with Node built-ins, avoiding any runtime icon dependency.
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0];
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
        const pixel = colorAt((x + (sx + .5) / 3) / size, (y + (sy + .5) / 3) / size);
        for (let channel = 0; channel < 3; channel++) sum[channel] += pixel[channel];
      }
      const offset = y * (1 + size * 3) + 1 + x * 3;
      for (let channel = 0; channel < 3; channel++) raw[offset + channel] = Math.round(sum[channel] / 9);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

await mkdir(new URL('../icons/', import.meta.url), { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['maskable-512.png', 512], ['apple-touch-icon.png', 180]]) {
  await writeFile(new URL(`../icons/${name}`, import.meta.url), png(size));
}
console.log('Generated four install icons from the flower artwork.');
