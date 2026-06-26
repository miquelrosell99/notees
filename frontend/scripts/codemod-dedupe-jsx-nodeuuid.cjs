/**
 * Remove duplicate consecutive JSX nodeUuid= attributes.
 */
const fs = require('fs');
const path = require('path');
const glob = require('glob');

const ROOT = path.resolve(__dirname, '..', 'src');
const files = glob.sync('**/*.{ts,tsx}', { cwd: ROOT, absolute: true });
let changed = 0;
let total = 0;
for (const file of files) {
  let text = fs.readFileSync(file, 'utf8');
  let original = text;
  const re = /(\s+nodeUuid=\{[^}]+\})\n\s+nodeUuid=\{[^}]+\}/g;
  const matches = text.match(re);
  if (matches) {
    text = text.replace(re, '$1');
    total += matches.length;
    changed++;
  }
  if (text !== original) fs.writeFileSync(file, text, 'utf8');
}
console.log(`Deduped nodeUuid JSX attrs in ${changed} files (${total} occurrences).`);
