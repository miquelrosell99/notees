/**
 * Revert accidental "nodeUuid" renames in variable/param/binding declarations
 * back to "nodeId". Property signatures and object/JSX keys are left as-is.
 */
const { Project, SyntaxKind } = require('ts-morph');

const project = new Project({ tsConfigFilePath: 'tsconfig.app.json' });
project.addSourceFilesAtPaths('src/**/*.{ts,tsx}');

let changes = 0;

function renameIdentifier(node) {
  if (node && node.isKind(SyntaxKind.Identifier) && node.getText() === 'nodeUuid') {
    node.replaceWithText('nodeId');
    changes++;
  }
}

for (const sourceFile of project.getSourceFiles()) {
  // Function parameters: (nodeUuid: string) => ...
  for (const param of sourceFile.getDescendantsOfKind(SyntaxKind.Parameter)) {
    renameIdentifier(param.getNameNode());
  }

  // Variable declarations: const nodeUuid = ...
  for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    renameIdentifier(decl.getNameNode());
  }

  // Catch clauses: catch (nodeUuid) { ... }
  for (const clause of sourceFile.getDescendantsOfKind(SyntaxKind.CatchClause)) {
    renameIdentifier(clause.getVariableDeclaration()?.getNameNode());
  }

  // Binding elements in destructuring when there is no property name
  // (i.e. shorthand destructuring like { nodeUuid })
  for (const binding of sourceFile.getDescendantsOfKind(SyntaxKind.BindingElement)) {
    const nameNode = binding.getNameNode();
    if (nameNode.isKind(SyntaxKind.Identifier) && nameNode.getText() === 'nodeUuid') {
      const propNameNode = binding.getPropertyNameNode();
      if (!propNameNode) {
        // { nodeUuid } -> { nodeId }
        nameNode.replaceWithText('nodeId');
        changes++;
      } else if (propNameNode.isKind(SyntaxKind.Identifier) && propNameNode.getText() === 'nodeUuid') {
        // { nodeUuid: nodeUuid } -> { nodeId: nodeId }
        propNameNode.replaceWithText('nodeId');
        nameNode.replaceWithText('nodeId');
        changes++;
      }
    }
  }
}

for (const sourceFile of project.getSourceFiles()) {
  if (!sourceFile.isSaved()) sourceFile.saveSync();
}

console.log(`Reverted ${changes} declaration/binding names.`);
