#!/usr/bin/env python3
"""
Frontend refactoring script:
1. Remove default exports from component files
2. Fix relative imports to use @/components/ aliases
3. Create barrel files for core/ and layout/
4. Fix conditional hooks in PropertiesSection.tsx
"""
import os
import re

FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'frontend', 'src'))
COMPONENTS_DIR = os.path.join(FRONTEND_DIR, 'components')

def remove_default_exports():
    """Remove 'export default Ident;' lines from component files."""
    for root, dirs, files in os.walk(COMPONENTS_DIR):
        if 'node_modules' in root:
            continue
        for fname in files:
            if not fname.endswith(('.tsx', '.ts')):
                continue
            if '.test.' in fname:
                continue
            path = os.path.join(root, fname)
            with open(path, 'r', encoding='utf-8') as f:
                content = f.read()
            original = content
            # Remove lines like: export default ComponentName;
            content = re.sub(r'^export default [A-Z][a-zA-Z0-9_]*;\s*\n?', '', content, flags=re.MULTILINE)
            if content != original:
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(content)
                print(f'Removed default export from {os.path.relpath(path, FRONTEND_DIR)}')

def fix_main_tsx_default_import():
    path = os.path.join(FRONTEND_DIR, 'main.tsx')
    if not os.path.exists(path):
        return
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    # Replace: import App from './App.tsx'
    # With:    import { App } from './App.tsx'
    content = re.sub(r"import\s+([A-Z][a-zA-Z0-9_]*)\s+from\s+('\.\.?/[^']+')", r"import { \1 } from \2", content)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print('Fixed main.tsx import')

def fix_relative_imports_in_components():
    """Replace relative imports within components/ to use @/components/ aliases."""
    for root, dirs, files in os.walk(COMPONENTS_DIR):
        if 'node_modules' in root:
            continue
        for fname in files:
            if not fname.endswith(('.tsx', '.ts')):
                continue
            path = os.path.join(root, fname)
            with open(path, 'r', encoding='utf-8') as f:
                content = f.read()
            original = content
            
            replacements = [
                (r"from\s+'\.\./core/", "from '@/components/core/"),
                (r"from\s+'\.\./blocks/", "from '@/components/blocks/"),
                (r"from\s+'\.\./nodes/", "from '@/components/nodes/"),
                (r"from\s+'\.\./layout/", "from '@/components/layout/"),
                (r"from\s+'\.\./properties/", "from '@/components/properties/"),
                (r"from\s+'\.\./queries/", "from '@/components/queries/"),
                (r"from\s+'\.\./sidebar/", "from '@/components/sidebar/"),
                (r"from\s+'\.\./workspace/", "from '@/components/workspace/"),
                (r"from\s+'\.\./assets/", "from '@/components/assets/"),
                (r"from\s+'\.\./shared/", "from '@/components/shared/"),
                (r"from\s+'\.\./maintenance/", "from '@/components/maintenance/"),
                (r"from\s+'\.\./icons'", "from '@/components/core/icons'"),
            ]
            
            for pattern, repl in replacements:
                content = re.sub(pattern, repl, content)
            
            if content != original:
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(content)
                print(f'Fixed imports in {os.path.relpath(path, FRONTEND_DIR)}')

def create_barrel_file(directory, output_name='index.ts'):
    """Create an index.ts that re-exports all named exports from .tsx files in the directory."""
    tsx_files = sorted([f for f in os.listdir(directory) if f.endswith('.tsx') and not f.startswith('.') and '.test.' not in f])
    lines = []
    for f in tsx_files:
        name = f[:-4]
        lines.append(f"export * from './{name}';")
    
    if not lines:
        return
    
    path = os.path.join(directory, output_name)
    content = '\n'.join(lines) + '\n'
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'Created barrel file {os.path.relpath(path, FRONTEND_DIR)}')

def fix_properties_section_hooks():
    """Fix conditional hooks in PropertiesSection.tsx by hoisting them."""
    path = os.path.join(COMPONENTS_DIR, 'properties', 'PropertiesSection.tsx')
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # For case 'node':
    old_node = '''    case 'node':
      // For node references
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const handleCreateNodeForProperty = useCallback(async (name: string): Promise<Node> => {
        const newPage = await onCreatePage?.(name, property.class_filters);
        if (!newPage) throw new Error('Failed to create page');
        return newPage;
      }, [onCreatePage, property.class_filters]);'''
    
    new_node = '''    case 'node':
      // For node references'''
    
    content = content.replace(old_node, new_node)
    
    # For case 'selection' multi:
    old_sel_multi = '''      if (property.multi) {
        // Multi-value selection: use Dropdown with multiple
        // eslint-disable-next-line react-hooks/rules-of-hooks
        const selectionOptions = useMemo(() => 
          options.map(opt => {
            const color = opt.color || parseIconField(opt.icon || '').color || null;
            return {
              value: opt.id,
              label: opt.name,
              iconNode: color
                ? <span className="selection-color-dot" style={{ background: color }} />
                : opt.icon ? <NodeIcon icon={opt.icon} size="xs" /> : undefined,
            };
          }),
          [options]
        );'''
    
    new_sel_multi = '''      if (property.multi) {
        // Multi-value selection: use Dropdown with multiple'''
    
    content = content.replace(old_sel_multi, new_sel_multi)
    
    # For case 'selection' single:
    old_sel_single = '''      } else {
        // Single-value selection: use Dropdown
        // eslint-disable-next-line react-hooks/rules-of-hooks
        const selectionOptions = useMemo(() => 
          options.map(opt => {
            const color = opt.color || parseIconField(opt.icon || '').color || null;
            return {
              value: opt.id,
              label: opt.name,
              iconNode: color
                ? <span className="selection-color-dot" style={{ background: color }} />
                : opt.icon ? <NodeIcon icon={opt.icon} size="xs" /> : undefined,
            };
          }),
          [options]
        );'''
    
    new_sel_single = '''      } else {
        // Single-value selection: use Dropdown'''
    
    content = content.replace(old_sel_single, new_sel_single)
    
    # Now add the hoisted hooks before the switch.
    hoisted = '''    // Hoisted hook calls to comply with Rules of Hooks
    const handleCreateNodeForProperty = useCallback(async (name: string): Promise<Node> => {
      const newPage = await onCreatePage?.(name, property.class_filters);
      if (!newPage) throw new Error('Failed to create page');
      return newPage;
    }, [onCreatePage, property.class_filters]);

    const selectionOptions = useMemo(() => {
      const opts = property.options ?? [];
      return opts.map(opt => {
        const color = opt.color || parseIconField(opt.icon || '').color || null;
        return {
          value: opt.id,
          label: opt.name,
          iconNode: color
            ? <span className="selection-color-dot" style={{ background: color }} />
            : opt.icon ? <NodeIcon icon={opt.icon} size="xs" /> : undefined,
        };
      });
    }, [property.options]);

    switch (property.type) {'''
    
    content = content.replace('    switch (property.type) {', hoisted)
    
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print('Fixed conditional hooks in PropertiesSection.tsx')

if __name__ == '__main__':
    remove_default_exports()
    fix_main_tsx_default_import()
    fix_relative_imports_in_components()
    create_barrel_file(os.path.join(COMPONENTS_DIR, 'core'))
    create_barrel_file(os.path.join(COMPONENTS_DIR, 'layout'))
    fix_properties_section_hooks()
    print('Done!')
