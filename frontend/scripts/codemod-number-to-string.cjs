/**
 * Change known numeric Node/block ID parameter/variable types to string.
 */
const fs = require('fs');
const path = require('path');
const glob = require('glob');

const ROOT = path.resolve(__dirname, '..', 'src');

const REPLACEMENTS = [
  // Callback parameter types
  { from: /blockServerId:\s*number\s*\|\s*undefined/g, to: 'blockServerId: string | undefined' },
  { from: /blockServerId:\s*number\s*\|\s*null/g, to: 'blockServerId: string | null' },
  { from: /blockServerId:\s*number/g, to: 'blockServerId: string' },
  { from: /templateNodeId:\s*number\s*\|\s*undefined/g, to: 'templateNodeId: string | undefined' },
  { from: /templateNodeId:\s*number/g, to: 'templateNodeId: string' },
  // State variable types (Node IDs stored as numbers)
  { from: /(manualAssetBlockId|targetBlockId|tableTargetBlockId|moveTargetBlockId|propertyTargetNodeId|selectedParentId):\s*number\s*\|\s*null/g, to: '$1: string | null' },
  { from: /\[(manualAssetBlockId|targetBlockId|tableTargetBlockId|moveTargetBlockId|propertyTargetNodeId|selectedParentId),\s*set(ManualAssetBlockId|TargetBlockId|TableTargetBlockId|MoveTargetBlockId|PropertyTargetNodeId|SelectedParentId)\]\s*=\s*useState<number\s*\|\s*null>\(null\)/g, to: '[$1, set$2] = useState<string | null>(null)' },
];

const files = glob.sync('**/*.{ts,tsx}', { cwd: ROOT, absolute: true });
let changedFiles = 0;
let totalReplacements = 0;

for (const file of files) {
  let text = fs.readFileSync(file, 'utf8');
  let original = text;
  for (const { from, to } of REPLACEMENTS) {
    const matches = text.match(from);
    if (matches) {
      text = text.replace(from, to);
      totalReplacements += matches.length;
    }
  }
  if (text !== original) {
    fs.writeFileSync(file, text, 'utf8');
    changedFiles++;
  }
}

console.log(`Changed ${changedFiles} files with ${totalReplacements} replacements.`);
