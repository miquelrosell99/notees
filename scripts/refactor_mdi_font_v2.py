#!/usr/bin/env python3
"""
Refactor frontend from @mdi/react + @mdi/js to @mdi/font (CSS webfont).

This script:
1. Replaces @mdi/js imports with nothing (mdiXxx -> "mdi mdi-xxx")
2. Replaces @mdi/react Icon import with import from local icons
3. Handles files that already import from icons.tsx
"""

import re
from pathlib import Path

FRONTEND = Path('/etc/periphery/stacks/notees/frontend/src')


def camel_to_kebab(name: str) -> str:
    if not name.startswith('mdi'):
        return name
    rest = name[3:]
    if not rest:
        return 'mdi'
    result = rest[0].lower()
    for char in rest[1:]:
        if char.isupper():
            result += '-' + char.lower()
        else:
            result += char
    return 'mdi-' + result


def process_file(path: Path) -> bool:
    content = path.read_text()
    original = content

    # Find @mdi/js imports and build mapping
    mdi_import_pattern = re.compile(
        r"import\s*\{([^}]+)\}\s*from\s*['\"]@mdi/js['\"];?\n?"
    )
    mapping = {}
    for match in mdi_import_pattern.finditer(content):
        names = [n.strip() for n in match.group(1).split(',') if n.strip()]
        for name in names:
            if name.startswith('mdi'):
                mapping[name] = f'"mdi {camel_to_kebab(name)}"'

    if not mapping and "@mdi/react" not in content and "@mdi/js" not in content:
        return False

    # Remove @mdi/js imports
    content = mdi_import_pattern.sub('', content)

    # Replace mdi constants with strings (word boundaries)
    # Sort by longest first to avoid partial replacements
    for name in sorted(mapping.keys(), key=len, reverse=True):
        # Replace as standalone identifier
        content = re.sub(
            r'(?<![\w"\'])' + re.escape(name) + r'(?![\w"\'])',
            mapping[name],
            content
        )

    # Handle @mdi/react import
    has_icon_jsx = '<Icon ' in content or 'Icon ' in content  # crude check

    if "import Icon from '@mdi/react';" in content:
        content = content.replace("import Icon from '@mdi/react';", '')

        # Check if file already imports from @/components/core/icons
        icons_import = re.search(
            r"import\s*\{([^}]+)\}\s*from\s*['\"]@/components/core/icons['\"];?",
            content
        )
        if icons_import:
            # Add Icon to existing import
            existing = icons_import.group(1)
            if 'Icon' not in existing:
                new_import = f"import {{ Icon, {existing.strip()} }} from '@/components/core/icons';"
                content = content[:icons_import.start()] + new_import + content[icons_import.end():]
        else:
            # Add new import for Icon
            # Insert after the last import or at top of file
            lines = content.split('\n')
            import_idx = 0
            for i, line in enumerate(lines):
                if line.strip().startswith('import '):
                    import_idx = i + 1
            lines.insert(import_idx, "import { Icon } from '@/components/core/icons';")
            content = '\n'.join(lines)

    # Clean up double blank lines from removed imports
    content = re.sub(r'\n{3,}', '\n\n', content)

    if content != original:
        path.write_text(content)
        return True
    return False


def main():
    modified = []
    for path in sorted(FRONTEND.rglob('*.ts*')):
        if 'node_modules' in str(path):
            continue
        if process_file(path):
            modified.append(path)

    print(f"Modified {len(modified)} files")
    for p in modified[:30]:
        print(f"  {p.relative_to(FRONTEND)}")


if __name__ == '__main__':
    main()
