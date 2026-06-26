/**
 * Migrate Node mutation hooks that still accept a numeric `id` parameter
 * to accept a string `nodeUuid`.
 */
const { Project, SyntaxKind } = require('ts-morph');

const project = new Project({ tsConfigFilePath: 'tsconfig.app.json' });

const FILES = [
  'src/features/content/hooks/useDeleteNode.ts',
  'src/features/content/hooks/useArchiveNode.ts',
  'src/features/content/hooks/useUnarchiveNode.ts',
  'src/features/content/hooks/useMoveNode.ts',
  'src/features/content/hooks/useUpdateNode.ts',
];

for (const f of FILES) {
  project.addSourceFileAtPath(f);
}

let renamed = 0;

for (const sourceFile of project.getSourceFiles()) {
  for (const param of sourceFile.getDescendantsOfKind(SyntaxKind.Parameter)) {
    const nameNode = param.getNameNode();
    if (!nameNode.isKind(SyntaxKind.Identifier) || nameNode.getText() !== 'id') continue;
    const typeNode = param.getTypeNode();
    if (!typeNode) continue;
    const typeText = typeNode.getText();
    if (!/^number(\s*\|\s*undefined)?$/.test(typeText)) continue;

    // Rename the parameter symbol to nodeUuid
    try {
      nameNode.rename('nodeUuid');
      renamed++;
    } catch {}
  }

  // Also update object type literal { id: number; ... } -> { nodeUuid: string; ... }
  for (const prop of sourceFile.getDescendantsOfKind(SyntaxKind.PropertySignature)) {
    if (prop.getName() !== 'id') continue;
    const typeNode = prop.getTypeNode();
    if (!typeNode) continue;
    if (typeNode.getText() === 'number') {
      prop.setType('string');
      prop.rename('nodeUuid');
    }
  }
}

for (const sourceFile of project.getSourceFiles()) {
  if (!sourceFile.isSaved()) sourceFile.saveSync();
}

console.log(`Renamed ${renamed} id parameters.`);
