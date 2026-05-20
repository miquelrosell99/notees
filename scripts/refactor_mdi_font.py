#!/usr/bin/env python3
"""
Refactor frontend from @mdi/react + @mdi/js to @mdi/font (CSS webfont).

This script performs mechanical transformations on .ts/.tsx files:
1. Replaces @mdi/js imports with nothing (mdiXxx -> "mdi mdi-xxx")
2. Replaces @mdi/react Icon JSX with <i> tags
3. Updates core infrastructure files
"""

import re
import sys
from pathlib import Path

def camel_to_kebab(name: str) -> str:
    """Convert mdiCamelCase to mdi-camel-case."""
    if not name.startswith('mdi'):
        return name
    rest = name[3:]  # Remove 'mdi' prefix
    result = rest[0].lower() if rest else ''
    for char in rest[1:]:
        if char.isupper():
            result += '-' + char.lower()
        else:
            result += char
    return 'mdi-' + result


def replace_mdi_imports(content: str) -> tuple[str, dict[str, str]]:
    """
    Find and remove @mdi/js imports, returning the mapping of
    camelCase names to their kebab class strings.
    """
    mapping = {}
    
    # Pattern: import { mdiA, mdiB } from '@mdi/js';
    import_pattern = re.compile(
        r"import\s*\{([^}]+)\}\s*from\s*['\"]@mdi/js['\"];?\n?"
    )
    
    def replacer(match):
        names_str = match.group(1)
        # Split by comma, handle whitespace
        names = [n.strip() for n in names_str.split(',') if n.strip()]
        for name in names:
            if name.startswith('mdi'):
                mapping[name] = f"mdi {camel_to_kebab(name)}"
        return ''
    
    content = import_pattern.sub(replacer, content)
    return content, mapping


def replace_icon_jsx(content: str, mapping: dict[str, str]) -> str:
    """
    Replace <Icon path={...} size={N} color={C} className={CN} />
    with <i className={...} style={{...}} />.
    
    Handles:
    - Direct constants: <Icon path={mdiPlus} size={0.7} />
    - Ternaries: <Icon path={cond ? mdiA : mdiB} size={0.7} />
    - Variables: <Icon path={iconVar} size={0.7} />
    """
    # Build a regex that matches Icon components
    # We'll do a simple text-based replacement for common patterns
    
    def replace_single_icon(match):
        full = match.group(0)
        inner = match.group(1)
        
        # Extract path expression
        path_match = re.search(r'path=\{([^}]+)\}', inner)
        path_expr = path_match.group(1).strip() if path_match else None
        
        # Extract size
        size_match = re.search(r'size=\{([^}]+)\}', inner)
        size_expr = size_match.group(1).strip() if size_match else None
        
        # Extract color
        color_match = re.search(r'color=\{([^}]+)\}', inner)
        color_expr = color_match.group(1).strip() if color_match else None
        
        # Extract className
        class_match = re.search(r'className=\{([^}]+)\}', inner)
        class_expr = class_match.group(1).strip() if class_match else None
        
        # Extract title
        title_match = re.search(r'title=\{([^}]+)\}', inner)
        title_expr = title_match.group(1).strip() if title_match else None
        
        # Build className expression
        if path_expr:
            # Check if path_expr is a known mdi constant
            if path_expr in mapping:
                class_value = f'"{mapping[path_expr]}"'
            elif '?' in path_expr:
                # Ternary: replace mdi constants inside
                class_value = path_expr
                for name, cls in mapping.items():
                    class_value = re.sub(r'\b' + re.escape(name) + r'\b', f'"{cls}"', class_value)
                # Wrap the whole thing
                class_value = f'{{{class_value}}}'
            else:
                # Variable or unknown expression - assume it holds a class string
                class_value = f'{{{path_expr}}}'
        else:
            class_value = '"mdi"'
        
        # Add explicit className if present
        if class_expr:
            if class_value.startswith('{') and class_value.endswith('}'):
                class_value = f'{{`${{{class_value[1:-1]}}} ${{" + class_expr + "}}`}}'
            elif class_value.startswith('"') and class_value.endswith('"'):
                class_value = f'{{`${class_value[:-1]} ${{" + class_expr + "}}`}}'
            else:
                class_value = f'{{{class_value} + " " + {class_expr}}}'
        
        # Build style
        style_parts = []
        if size_expr:
            style_parts.append(f'fontSize: `${{{size_expr}}} * 24px`')
        if color_expr:
            style_parts.append(f'color: {color_expr}')
        
        style_attr = f' style={{{{ ", ".join(style_parts) }}}}' if style_parts else ''
        
        # Build title
        title_attr = f' title={{{title_expr}}}' if title_expr else ''
        
        # Handle self-closing or with children (Icon shouldn't have children)
        return f'<i className={class_value}{style_attr}{title_attr} />'
    
    # Match <Icon ... /> and <Icon ...></Icon>
    # This regex is intentionally simple - handles most cases
    content = re.sub(
        r'<Icon\s+([^>/]+)(?:/>|>(?:[^<]*(?:<(?!/Icon>)[^<]*)*)</Icon>)',
        replace_single_icon,
        content
    )
    
    return content


def replace_mdi_constants(content: str, mapping: dict[str, str]) -> str:
    """Replace standalone mdiXxx usages with their string class equivalents."""
    for name, cls in mapping.items():
        # Replace as JSX expression: {mdiXxx} -> {"mdi mdi-xxx"}
        # But be careful not to replace inside strings
        content = re.sub(
            r'(?<![\w"\'])' + re.escape(name) + r'(?![\w"\'])',
            f'"{cls}"',
            content
        )
    return content


def remove_mdi_react_import(content: str) -> str:
    """Remove 'import Icon from "@mdi/react"' lines."""
    content = re.sub(
        r"import\s+Icon\s+from\s*['\"]@mdi/react['\"];?\n?",
        '',
        content
    )
    return content


def process_file(path: Path) -> bool:
    """Process a single file. Returns True if modified."""
    content = path.read_text()
    original = content
    
    # Skip if no mdi references
    if '@mdi/js' not in content and '@mdi/react' not in content:
        return False
    
    content, mapping = replace_mdi_imports(content)
    if mapping:
        content = replace_mdi_constants(content, mapping)
    
    content = remove_mdi_react_import(content)
    
    # Replace Icon JSX
    content = replace_icon_jsx(content, mapping)
    
    if content != original:
        path.write_text(content)
        return True
    return False


def main():
    frontend_dir = Path('/etc/periphery/stacks/notees/frontend/src')
    modified = []
    
    for path in sorted(frontend_dir.rglob('*.ts*')):
        if 'node_modules' in str(path):
            continue
        if process_file(path):
            modified.append(path)
    
    print(f"Modified {len(modified)} files")
    for p in modified:
        print(f"  {p}")


if __name__ == '__main__':
    main()
