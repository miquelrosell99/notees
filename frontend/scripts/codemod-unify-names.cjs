/**
 * Unify nodeId/nodeUuid variable names:
 * - Declarations whose type is number-ish stay as nodeId.
 * - Declarations whose type is string-ish become nodeUuid.
 * Uses ts-morph renameSymbol to fix both declaration and all references.
 */
const { Project, SyntaxKind, TypeFormatFlags } = require('ts-morph');

const project = new Project({ tsConfigFilePath: 'tsconfig.app.json' });
project.addSourceFilesAtPaths('src/**/*.{ts,tsx}');

const STRINGY_TYPES = new Set([
  'string', 'string | null', 'string | undefined', 'string | null | undefined',
  'string | null | undefined | boolean', 'string | undefined | null',
  'string | null | boolean',
]);
const NUMERIC_TYPES = new Set([
  'number', 'number | null', 'number | undefined', 'number | null | undefined',
  'number | string',
]);

function isNumericTypeText(t) {
  return NUMERIC_TYPES.has(t) || /^number\b/.test(t);
}
function isStringyTypeText(t) {
  return STRINGY_TYPES.has(t) || /^string\b/.test(t);
}

function getDesiredName(decl) {
  let typeText = '';
  if (decl.getType) {
    try {
      typeText = decl.getType().getText(decl, TypeFormatFlags.NoTruncation | TypeFormatFlags.UseFullyQualifiedType);
    } catch {}
  }
  if (!typeText && decl.getTypeNode) {
    const tn = decl.getTypeNode();
    if (tn) typeText = tn.getText();
  }
  if (typeText) {
    if (isStringyTypeText(typeText)) return 'nodeUuid';
    if (isNumericTypeText(typeText)) return 'nodeId';
  }
  // Heuristic based on initializer
  const init = decl.getInitializer?.();
  if (init) {
    if (init.isKind(SyntaxKind.NumericLiteral)) return 'nodeId';
    if (init.isKind(SyntaxKind.StringLiteral)) return 'nodeUuid';
    if (init.isKind(SyntaxKind.NullKeyword)) return null; // ambiguous
  }
  return null;
}

let renames = 0;

for (const sourceFile of project.getSourceFiles()) {
  // Process declarations named nodeId or nodeUuid (variables, parameters, catch variables)
  const declarations = [];
  for (const param of sourceFile.getDescendantsOfKind(SyntaxKind.Parameter)) {
    const nameNode = param.getNameNode();
    if (nameNode.isKind(SyntaxKind.Identifier) && ['nodeId','nodeUuid'].includes(nameNode.getText())) {
      declarations.push({ decl: param, nameNode });
    }
  }
  for (const v of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const nameNode = v.getNameNode();
    if (nameNode.isKind(SyntaxKind.Identifier) && ['nodeId','nodeUuid'].includes(nameNode.getText())) {
      declarations.push({ decl: v, nameNode });
    }
  }
  for (const c of sourceFile.getDescendantsOfKind(SyntaxKind.CatchClause)) {
    const nameNode = c.getVariableDeclaration()?.getNameNode();
    if (nameNode && nameNode.isKind(SyntaxKind.Identifier) && ['nodeId','nodeUuid'].includes(nameNode.getText())) {
      declarations.push({ decl: c.getVariableDeclaration(), nameNode });
    }
  }

  for (const { decl, nameNode } of declarations) {
    const desired = getDesiredName(decl);
    if (!desired) continue;
    const current = nameNode.getText();
    if (current === desired) continue;
    try {
      nameNode.rename(desired);
      renames++;
    } catch (e) {
      // ignore rename conflicts; will surface later
    }
  }
}

for (const sourceFile of project.getSourceFiles()) {
  if (!sourceFile.isSaved()) sourceFile.saveSync();
}

console.log(`Renamed ${renames} declarations.`);
