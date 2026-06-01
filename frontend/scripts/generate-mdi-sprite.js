/**
 * Generate an SVG sprite sheet from @mdi/svg.
 *
 * Run this script after updating @mdi/svg to regenerate the sprite:
 *   node scripts/generate-mdi-sprite.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SVG_DIR = path.resolve(__dirname, '../node_modules/@mdi/svg/svg');
const OUT_FILE = path.resolve(__dirname, '../public/mdi-sprite.svg');

function main() {
  if (!fs.existsSync(SVG_DIR)) {
    console.error('Error: @mdi/svg not found. Run: npm install -D @mdi/svg');
    process.exit(1);
  }

  const files = fs
    .readdirSync(SVG_DIR)
    .filter((f) => f.endsWith('.svg'))
    .sort();

  let symbols = '';
  for (const file of files) {
    const content = fs.readFileSync(path.join(SVG_DIR, file), 'utf8');
    const id = file.replace('.svg', '');

    // Extract inner content: remove <svg> wrapper and xmlns
    const inner = content
      .replace(/<svg[^>]*>/, '')
      .replace(/<\/svg>/, '')
      .trim();

    symbols += `<symbol id="mdi-${id}" viewBox="0 0 24 24">${inner}</symbol>\n`;
  }

  const sprite =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" style="display:none">\n' +
    symbols +
    '</svg>\n';

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, sprite);

  const rawKb = (sprite.length / 1024).toFixed(0);
  console.log(`Generated sprite with ${files.length} icons.`);
  console.log(`Raw size: ${rawKb} KB`);
  console.log(`Output: ${OUT_FILE}`);
}

main();
