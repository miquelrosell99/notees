// Renders public/icons/icon-{48,96}.png from the geometry of icon.svg.
// Dependency-free: the PNG is encoded by hand on top of node:zlib (no raster
// library exists in this tree, and none is wanted for two static icons).
//
// SVG text ("N", font-family sans-serif bold) cannot be rasterized faithfully
// without a font engine, so the glyph is drawn as measured from the shipped
// 96px icon: two 6/96-em stems plus a same-width diagonal capsule, on the
// rounded square that icon.svg declares (fill + rx are read from the SVG).

import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = join(root, "public", "icons");

const svg = readFileSync(join(iconsDir, "icon.svg"), "utf8");
const fill = svg.match(/fill="(#\w+)"/)[1];
const rxFrac = Number(svg.match(/rx="([\d.]+)"/)[1]) / 96;
const [BR, BG, BB] = [1, 3, 5].map((i) => parseInt(fill.slice(i, i + 2), 16));

// "N" glyph, fractions of the icon size, measured from the shipped 96px render.
const STEM_W = 6 / 96;
const LEFT_STEM = [33 / 96, 39 / 96];
const RIGHT_STEM = [57 / 96, 63 / 96];
const N_TOP = 34 / 96;
const N_BOTTOM = 63 / 96;
const DIAGONAL = { ax: 41.5 / 96, ay: 34 / 96, bx: 55.5 / 96, by: 63 / 96, r: 3 / 96 };

// Point-in-shape tests on normalized coordinates (0..1).
function inRoundedSquare(x, y, r) {
  const q = 1 - r;
  if (x >= r && x <= q) return y >= 0 && y <= 1;
  if (y >= r && y <= q) return x >= 0 && x <= 1;
  const cx = x < r ? r : q;
  const cy = y < r ? r : q;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inCapsule(x, y, { ax, ay, bx, by, r }) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = ((x - ax) * dx + (y - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * dx;
  const py = ay + t * dy;
  return (x - px) ** 2 + (y - py) ** 2 <= r * r;
}

function inGlyph(x, y) {
  if (y < N_TOP || y >= N_BOTTOM) return false;
  return (
    (x >= LEFT_STEM[0] && x < LEFT_STEM[1]) ||
    (x >= RIGHT_STEM[0] && x < RIGHT_STEM[1]) ||
    inCapsule(x, y, DIAGONAL)
  );
}

// One icon: per pixel, average SUB×SUB sub-samples (antialiasing by coverage).
function render(size) {
  const r = rxFrac;
  const SUB = 8;
  const rows = Buffer.alloc(size * (1 + size * 3));
  for (let py = 0; py < size; py++) {
    const rowStart = py * (1 + size * 3);
    rows[rowStart] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      let cr = 0;
      let cg = 0;
      let cb = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const x = (px + (sx + 0.5) / SUB) / size;
          const y = (py + (sy + 0.5) / SUB) / size;
          if (inRoundedSquare(x, y, r) && !inGlyph(x, y)) {
            cr += BR;
            cg += BG;
            cb += BB;
          } else {
            cr += 255;
            cg += 255;
            cb += 255;
          }
        }
      }
      const n = SUB * SUB;
      const o = rowStart + 1 + px * 3;
      rows[o] = Math.round(cr / n);
      rows[o + 1] = Math.round(cg / n);
      rows[o + 2] = Math.round(cb / n);
    }
  }
  return rows;
}

// Minimal PNG encoder (8-bit RGB, filter 0, single IDAT).
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePNG(size, rows) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [48, 96]) {
  const file = join(iconsDir, `icon-${size}.png`);
  writeFileSync(file, encodePNG(size, render(size)));
  console.log(`rendered ${file}`);
}
