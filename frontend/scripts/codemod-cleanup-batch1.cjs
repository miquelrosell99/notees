/**
 * Batch cleanup:
 * 1. Replace nodeUuid ?? 0 -> nodeUuid ?? ''
 * 2. Replace .nodeId -> .nodeUuid
 * 3. Remove const nodeUuid resolution shims that shadow an outer nodeUuid.
 */
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const { Project, SyntaxKind } = require('ts-morph');

const ROOT = path.resolve(__dirname, '..', 'src');

// 1 & 2 via regex
const BLOCKLIST_REGEX = /\/(types\/queryAST|lib\/ast|stringifyAST|features\/views\/utils\/evaluateQueryAST)\./;
const files = glob.sync('**/*.{ts,tsx}', { cwd: ROOT, absolute: true });
let changedFiles = 0;
let totalReplacements = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file);
  if (BLOCKLIST_REGEX.test('/' + rel)) continue;
  let text = fs.readFileSync(file, 'utf8');
  let original = text;
  // nodeUuid ?? 0 -> nodeUuid ?? '' (including tab.nodeUuid)
  const r1 = /(\b\w*\.)?nodeUuid\s*\?\?\s*0/g;
  const m1 = text.match(r1);
  if (m1) {
    text = text.replace(r1, "$1nodeUuid ?? ''");
    totalReplacements += m1.length;
  }
  // .nodeId -> .nodeUuid (but not .nodeIdOrder etc)
  const r2 = /\.nodeId\b/g;
  const m2 = text.match(r2);
  if (m2) {
    text = text.replace(r2, '.nodeUuid');
    totalReplacements += m2.length;
  }
  if (text !== original) {
    fs.writeFileSync(file, text, 'utf8');
    changedFiles++;
  }
}

console.log(`Regex pass: changed ${changedFiles} files, ${totalReplacements} replacements.`);

// 3 ts-morph remove shadowing const nodeUuid declarations
const project = new Project({ tsConfigFilePath: 'tsconfig.app.json' });
project.addSourceFilesAtPaths('src/**/*.{ts,tsx}');

function findNodeUuidIdentifiers(scopeNode, list = []) {
  if (!scopeNode) return list;
  if (scopeNode.isKind(SyntaxKind.Identifier) && scopeNode.getText() === 'nodeUuid') {
    list.push(scopeNode);
  }
  // Parameters / binding elements
  if (scopeNode.getParameters) {
    for (const p of scopeNode.getParameters()) {
      findNodeUuidIdentifiers(p.getNameNode(), list);
    }
  }
  if (scopeNode.isKind(SyntaxKind.ObjectBindingPattern)) {
    for (const el of scopeNode.getElements()) {
      findNodeUuidIdentifiers(el.getNameNode(), list);
      const pn = el.getPropertyNameNode();
      if (pn) findNodeUuidIdentifiers(pn, list);
    }
  }
  if (scopeNode.isKind(SyntaxKind.ArrayBindingPattern)) {
    for (const el of scopeNode.getElements()) {
      findNodeUuidIdentifiers(el.getNameNode(), list);
    }
  }
  return list;
}

let removed = 0;
for (const sourceFile of project.getSourceFiles()) {
  // Build a map of scopes that declare nodeUuid
  const scopesWithNodeUuid = new Set();
  for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getText() !== 'nodeUuid') continue;
    if (
      id.getParent().isKind(SyntaxKind.Parameter) ||
      id.getParent().isKind(SyntaxKind.BindingElement) ||
      id.getParent().isKind(SyntaxKind.VariableDeclaration)
    ) {
      const fn = id.getParent().getAncestors().find(a =>
        a.isKind(SyntaxKind.ArrowFunction) ||
        a.isKind(SyntaxKind.FunctionDeclaration) ||
        a.isKind(SyntaxKind.FunctionExpression) ||
        a.isKind(SyntaxKind.MethodDeclaration)
      );
      if (fn) scopesWithNodeUuid.add(fn);
    }
  }

  for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const nameNode = decl.getNameNode();
    if (!nameNode.isKind(SyntaxKind.Identifier) || nameNode.getText() !== 'nodeUuid') continue;
    const init = decl.getInitializer();
    if (!init) continue;
    const initText = init.getText();
    if (!initText.includes('nodeUuid') && !initText.includes('getNodeUuidByServerId')) continue;

    // Is there an outer nodeUuid in scope?
    let outer = null;
    let current = decl.getParent();
    while (current) {
      if (
        current.isKind(SyntaxKind.ArrowFunction) ||
        current.isKind(SyntaxKind.FunctionDeclaration) ||
        current.isKind(SyntaxKind.FunctionExpression) ||
        current.isKind(SyntaxKind.MethodDeclaration)
      ) {
        const ids = findNodeUuidIdentifiers(current);
        // exclude the declaration itself
        const others = ids.filter(id => id !== nameNode && !decl.getDescendants().some(d => d === id));
        if (others.length > 0) {
          outer = current;
          break;
        }
      }
      current = current.getParent();
    }
    if (!outer) continue;

    const statement = decl.getVariableStatement();
    if (statement) {
      statement.remove();
      removed++;
    } else {
      decl.remove();
      removed++;
    }
  }
}

for (const sourceFile of project.getSourceFiles()) {
  if (!sourceFile.isSaved()) sourceFile.saveSync();
}

console.log(`Removed ${removed} shadowing nodeUuid declarations.`);
