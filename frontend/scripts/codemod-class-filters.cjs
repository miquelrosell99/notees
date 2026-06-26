/**
 * Migrate classFilters / classFilterIds arrays from number[] to string[].
 */
const fs = require('fs');
const path = require('path');
const glob = require('glob');

const ROOT = path.resolve(__dirname, '..', 'src');
const files = glob.sync('**/*.{ts,tsx}', { cwd: ROOT, absolute: true });

let changed = 0;
for (const file of files) {
  let text = fs.readFileSync(file, 'utf8');
  let original = text;
  text = text.replace(/classFilters\?:\s*number\[\]/g, 'classFilters?: string[]');
  text = text.replace(/classFilters:\s*number\[\]/g, 'classFilters: string[]');
  text = text.replace(/classFilterIds:\s*number\[\]/g, 'classFilterIds: string[]');
  text = text.replace(/classFilterIds\?:\s*number\[\]/g, 'classFilterIds?: string[]');
  if (text !== original) {
    fs.writeFileSync(file, text, 'utf8');
    changed++;
  }
}
console.log(`Updated classFilters types in ${changed} files.`);
