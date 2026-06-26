/**
 * Remove const/let variable declarations named `nodeUuid` that shadow an existing
 * parameter or binding with the same name in the same function scope.
 */
const { Project, SyntaxKind } = require('ts-morph');

const project = new Project({ tsConfigFilePath: 'tsconfig.app.json' });
project.addSourceFilesAtPaths('src/**/*.{ts,tsx}');

let removed = 0;

function hasNodeUuidBinding(node) {
  if (!node) return false;
  if (node.isKind(SyntaxKind.Identifier) && node.getText() === 'nodeUuid') return true;
  if (node.isKind(SyntaxKind.ObjectBindingPattern)) {
    for (const el of node.getElements()) {
      if (hasNodeUuidBinding(el.getNameNode())) return true;
      const prop = el.getPropertyNameNode();
      if (prop && hasNodeUuidBinding(prop)) return true;
    }
  }
  if (node.isKind(SyntaxKind.ArrayBindingPattern)) {
    for (const el of node.getElements()) {
      if (hasNodeUuidBinding(el.getNameNode())) return true;
    }
  }
  return false;
}

function getEnclosingFunction(node) {
  let current = node;
  while (current) {
    if (
      current.isKind(SyntaxKind.ArrowFunction) ||
      current.isKind(SyntaxKind.FunctionDeclaration) ||
      current.isKind(SyntaxKind.FunctionExpression) ||
      current.isKind(SyntaxKind.MethodDeclaration)
    ) {
      return current;
    }
    current = current.getParent();
  }
  return null;
}

for (const sourceFile of project.getSourceFiles()) {
  // Find all variable declarations named nodeUuid
  const varDecls = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).filter(d => {
    const name = d.getNameNode();
    return name.isKind(SyntaxKind.Identifier) && name.getText() === 'nodeUuid';
  });

  for (const decl of varDecls) {
    const fn = getEnclosingFunction(decl);
    if (!fn) continue;

    // Check if any parameter of the enclosing function binds nodeUuid
    let shadows = false;
    for (const param of fn.getParameters()) {
      if (hasNodeUuidBinding(param.getNameNode())) {
        shadows = true;
        break;
      }
    }
    if (!shadows) continue;

    // Only remove resolution shims
    const init = decl.getInitializer();
    if (!init) continue;
    const initText = init.getText();
    if (!initText.includes('nodeUuid') && !initText.includes('getNodeUuidByServerId')) continue;

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
