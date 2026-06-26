/**
 * Rename JSX attribute nodeId= to nodeUuid= across the frontend.
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
  // Match nodeId= preceded by whitespace or < or { (JSX attribute contexts)
  const re = /([\s<{])nodeId=/g;
  const matches = text.match(re);
  if (matches) {
    text = text.replace(re, '$1nodeUuid=');
    total += matches.length;
    changed++;
  }
  if (text !== original) fs.writeFileSync(file, text, 'utf8');
}
console.log(`Renamed nodeId->nodeUuid in ${changed} files (${total} occurrences).`);
