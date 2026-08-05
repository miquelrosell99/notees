#!/usr/bin/env node
/**
 * Helper for Python migrations that need to emit or inspect Yjs text updates.
 *
 * Modes:
 *   --encode (default): reads a UTF-8 string from stdin and writes a JSON array
 *                       of byte values for a Yjs update that sets a fresh text
 *                       CRDT to exactly that string.
 *   --replace:          reads a JSON object { current, new } from stdin and
 *                       writes a Yjs update that replaces the current text with
 *                       the new text when applied.
 *   --decode:           reads a JSON array of byte values from stdin and writes
 *                       the decoded plain text.
 *   --encode-batch:     reads a JSON array of { current, new } objects from stdin
 *                       and writes a JSON array of replacement update byte arrays.
 *   --decode-batch:     reads a JSON array of update byte arrays from stdin and
 *                       writes a JSON array of decoded strings.
 *
 * The encoded update can be passed to WorkspaceStore.update_text_crdt().
 */
const path = require('path');

// yjs lives in the frontend workspace; add it to the module search path.
const frontendNodeModules = path.resolve(__dirname, '..', 'frontend', 'node_modules');
require.main.paths.unshift(frontendNodeModules);
module.paths.unshift(frontendNodeModules);

const Y = require('yjs');

function generateUpdate(text) {
  const doc = new Y.Doc();
  const ytext = doc.getText('content');
  ytext.insert(0, text);
  return Array.from(Y.encodeStateAsUpdate(doc));
}

function generateReplaceUpdate(currentText, newText) {
  // Build the update against a doc that already contains the current text so
  // that the deletion actually removes the existing content on the target doc.
  const doc = new Y.Doc();
  const ytext = doc.getText('content');
  ytext.insert(0, currentText);
  ytext.delete(0, currentText.length);
  ytext.insert(0, newText);
  return Array.from(Y.encodeStateAsUpdate(doc));
}

function decodeUpdate(bytes) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(bytes));
  return doc.getText('content').toString();
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.find((a) => a.startsWith('--'))?.replace(/^--/, '') || 'encode';
  const input = await readStdin();

  try {
    switch (mode) {
      case 'decode': {
        const bytes = JSON.parse(input);
        const text = decodeUpdate(bytes);
        process.stdout.write(text);
        break;
      }
      case 'encode': {
        const update = generateUpdate(input);
        process.stdout.write(JSON.stringify(update));
        break;
      }
      case 'replace': {
        const { current, new: newText } = JSON.parse(input);
        const update = generateReplaceUpdate(current, newText);
        process.stdout.write(JSON.stringify(update));
        break;
      }
      case 'decode-batch': {
        const batches = JSON.parse(input);
        const texts = batches.map((bytes) => decodeUpdate(bytes));
        process.stdout.write(JSON.stringify(texts));
        break;
      }
      case 'encode-batch': {
        const pairs = JSON.parse(input);
        const updates = pairs.map(({ current, new: newText }) =>
          generateReplaceUpdate(current, newText)
        );
        process.stdout.write(JSON.stringify(updates));
        break;
      }
      default:
        throw new Error(`Unknown mode: ${mode}`);
    }
  } catch (err) {
    process.stderr.write(String(err));
    process.exit(1);
  }
}

main();
