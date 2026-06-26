/**
 * Remove const/let variable declarations named `nodeUuid` that shadow an existing
 * parameter or binding with the same name in the same scope. These were created
 * when the broad rename turned `const nodeUuid = typeof nodeId === ...` into a
 * duplicate of an already-renamed destructured parameter.
 */
const { Project, SyntaxKind } = require('ts-morph');

const project = new Project({ tsConfigFilePath: 'tsconfig.app.json' });
project.addSourceFilesAtPaths('src/**/*.{ts,tsx}');

let removed = 0;

function hasNodeUuidInScope(scope) {
  if (!scope) return false;
  // Parameters
  if (scope.getParameters) {
    for (const p of scope.getParameters()) {
      if (p.getName() === 'nodeUuid') return true;
    }
  }
  // Check binding patterns if this scope is a variable declaration
  const decl = scope.getNodeProperty ? null : null; // generic below
  // We'll simply look for any BindingElement or Parameter named nodeUuid in ancestors
  return false;
}

for (const sourceFile of project.getSourceFiles()) {
  for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const nameNode = decl.getNameNode();
    if (!nameNode.isKind(SyntaxKind.Identifier) || nameNode.getText() !== 'nodeUuid') continue;

    // Only handle declarations that shadow an ancestor parameter/binding named nodeUuid
    let shadows = false;
    let ancestor = decl.getParent();
    while (ancestor) {
      if (ancestor.isKind(SyntaxKind.Parameter)) {
        if (ancestor.getName() === 'nodeUuid') shadows = true;
        break;
      }
      if (ancestor.isKind(SyntaxKind.ArrowFunction) || ancestor.isKind(SyntaxKind.FunctionDeclaration) || ancestor.isKind(SyntaxKind.FunctionExpression) || ancestor.isKind(SyntaxKind.MethodDeclaration)) {
        for (const p of ancestor.getParameters()) {
          if (p.getName() === 'nodeUuid') { shadows = true; break; }
        }
        break;
      }
      if (ancestor.isKind(SyntaxKind.BindingElement)) {
        if (ancestor.getNameNode().getText() === 'nodeUuid') shadows = true;
        break;
      }
      ancestor = ancestor.getParent();
    }
    if (!shadows) continue;

    // Only remove if initializer is a conditional involving nodeUuid or getNodeUuidByServerId
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
