/**
 * CodeBlock Component
 * 
 * Renders blocks with the "code" class as code blocks with:
 * - Monospace font
 * - Code block styling
 * - Language selector dropdown
 * - Syntax highlighting-ready structure
 */
import { useState } from 'react';
import { Dropdown } from '@/components/core/Dropdown';
import type { DropdownOption } from '@/components/core/Dropdown';
import { Card } from '@/components/core/Card';
import './CodeBlock.css';

export interface CodeBlockProps {
  /** The code content */
  content: string;
  /** Current language */
  language?: string | null;
  /** Whether the code block is editable */
  editable?: boolean;
  /** Change handler for language */
  onLanguageChange?: (language: string | null) => void;
  /** Click handler for the content area */
  onClick?: (e?: React.MouseEvent) => void;
}

// Popular programming languages for code blocks
const LANGUAGE_OPTIONS: DropdownOption[] = [
  { value: 'plaintext', label: 'Plain Text' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'csharp', label: 'C#' },
  { value: 'cpp', label: 'C++' },
  { value: 'c', label: 'C' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'php', label: 'PHP' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'swift', label: 'Swift' },
  { value: 'kotlin', label: 'Kotlin' },
  { value: 'scala', label: 'Scala' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'scss', label: 'SCSS' },
  { value: 'json', label: 'JSON' },
  { value: 'xml', label: 'XML' },
  { value: 'yaml', label: 'YAML' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'sql', label: 'SQL' },
  { value: 'bash', label: 'Bash' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'shell', label: 'Shell' },
  { value: 'dockerfile', label: 'Dockerfile' },
  { value: 'r', label: 'R' },
  { value: 'matlab', label: 'MATLAB' },
  { value: 'lua', label: 'Lua' },
  { value: 'perl', label: 'Perl' },
  { value: 'haskell', label: 'Haskell' },
  { value: 'clojure', label: 'Clojure' },
  { value: 'elixir', label: 'Elixir' },
  { value: 'erlang', label: 'Erlang' },
  { value: 'fsharp', label: 'F#' },
  { value: 'dart', label: 'Dart' },
  { value: 'groovy', label: 'Groovy' },
  { value: 'objective-c', label: 'Objective-C' },
];

/**
 * CodeBlock component for displaying code with language selection
 */
export function CodeBlock({
  content,
  language = 'plaintext',
  editable = true,
  onLanguageChange,
  onClick,
}: CodeBlockProps) {
  const [isHovered, setIsHovered] = useState(false);

  const handleLanguageChange = (newLang: string | null) => {
    onLanguageChange?.(newLang);
  };
  
  const handleDropdownClick = (e: React.MouseEvent) => {
    // Prevent click from propagating to the code block and entering edit mode
    e.stopPropagation();
  };

  const displayLanguage = language || 'plaintext';
  const languageLabel = LANGUAGE_OPTIONS.find(opt => opt.value === displayLanguage)?.label ?? 'Plain Text';

  return (
    <Card 
      className="code-block"
      variant="outlined"
      padding={false}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onClick}
    >
      {/* Language selector in top-right corner */}
      {editable && (
        <div 
          className={`code-block-header${isHovered ? ' code-block-header--visible' : ''}`}
          onClick={handleDropdownClick}
        >
          <Dropdown
            options={LANGUAGE_OPTIONS}
            value={displayLanguage}
            onChange={handleLanguageChange}
            placeholder="Language"
            searchable={true}
            size="sm"
            className="code-block-language-selector"
          />
        </div>
      )}

      {/* Code content */}
      <div className="code-block-content">
        <pre className={`language-${displayLanguage}`}>
          <code>{content || ''}</code>
        </pre>
      </div>

      {/* Show language label when not editable */}
      {!editable && language && (
        <div className="code-block-footer">
          <span className="code-block-language-label">{languageLabel}</span>
        </div>
      )}
    </Card>
  );
}

