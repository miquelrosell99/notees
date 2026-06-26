/**
 * Collapse duplicate nodeId/nodeUuid property signatures and destructuring bindings.
 */
const { Project, SyntaxKind } = require('ts-morph');

const project = new Project({ tsConfigFilePath: 'tsconfig.app.json' });
project.addSourceFilesAtPaths('src/**/*.{ts,tsx}');

let collapsedProps = 0;
let collapsedBindings = 0;

for (const sourceFile of project.getSourceFiles()) {
  // Collapse duplicate property signatures in interfaces/types
  const propParents = new Set();
  for (const sig of sourceFile.getDescendantsOfKind(SyntaxKind.PropertySignature)) {
    const name = sig.getName();
    if (name === 'nodeUuid' || name === 'nodeId') {
      propParents.add(sig.getParent());
    }
  }
  for (const parent of propParents) {
    const siblings = parent.getChildrenOfKind(SyntaxKind.PropertySignature);
    const seen = new Set();
    for (let i = siblings.length - 1; i >= 0; i--) {
      const sig = siblings[i];
      const name = sig.getName();
      if (name !== 'nodeUuid' && name !== 'nodeId') continue;
      if (seen.has(name)) {
        sig.remove();
        collapsedProps++;
      } else {
        seen.add(name);
      }
    }
  }

  // Collapse duplicate binding elements in object destructuring
  const bindingParents = new Set();
  for (const binding of sourceFile.getDescendantsOfKind(SyntaxKind.BindingElement)) {
    const nameNode = binding.getNameNode();
    if (nameNode.isKind(SyntaxKind.Identifier)) {
      const name = nameNode.getText();
      if (name === 'nodeUuid' || name === 'nodeId') {
        bindingParents.add(binding.getParent());
      }
    }
  }
  for (const parent of bindingParents) {
    if (!parent.isKind(SyntaxKind.ObjectBindingPattern)) continue;
    const siblings = parent.getElements();
    const seen = new Set();
    for (let i = siblings.length - 1; i >= 0; i--) {
      const binding = siblings[i];
      const nameNode = binding.getNameNode();
      if (!nameNode.isKind(SyntaxKind.Identifier)) continue;
      const name = nameNode.getText();
      if (name !== 'nodeUuid' && name !== 'nodeId') continue;
      if (seen.has(name)) {
        binding.replaceWithText('');
        collapsedBindings++;
      } else {
        seen.add(name);
      }
    }
    // Rename surviving nodeId binding to nodeUuid
    for (const binding of parent.getElements()) {
      const nameNode = binding.getNameNode();
      if (nameNode.isKind(SyntaxKind.Identifier) && nameNode.getText() === 'nodeId') {
        try {
          nameNode.rename('nodeUuid');
        } catch {}
      }
    }
    // Clean leftover duplicate commas from removed bindings
    let text = parent.getText();
    text = text.replace(/,\s*,/g, ',');
    text = text.replace(/\{\s*,/g, '{ ');
    text = text.replace(/,\s*\}/g, ' }');
    parent.replaceWithText(text);
  }
}

for (const sourceFile of project.getSourceFiles()) {
  if (!sourceFile.isSaved()) sourceFile.saveSync();
}

console.log(`Collapsed ${collapsedProps} duplicate props and ${collapsedBindings} duplicate bindings.`);
