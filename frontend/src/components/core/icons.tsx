/**
 * MDI Icons for the application
 *
 * Uses the shared MDI SVG sprite sheet (`/mdi-sprite.svg`) for all icons.
 * Provides default icons for system tags and pages.
 */
import { Icon } from './Icon';
import { getMdiClass } from '@/utils/iconDom';
export { Icon } from './Icon';

// Icon size presets
const ICON_SIZE = {
  xs: 0.6,  // 14.4px at 24px base
  sm: 0.75, // 18px
  md: 1,    // 24px (default)
  lg: 1.25, // 30px
  xl: 1.5,  // 36px
} as const;

type IconSize = keyof typeof ICON_SIZE | number;

interface IconProps {
  size?: IconSize;
  className?: string;
  color?: string;
  title?: string;
}

function getSize(size: IconSize): number {
  if (typeof size === 'number') return size;
  return ICON_SIZE[size];
}

// Document/Page icons
export const PageIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-file-document-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const FolderIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-folder-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const FolderOpenIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-folder-open-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const DatabaseIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-database-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const CheckIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-check" size={getSize(size)} className={className} color={color} title={title} />
);

export const AlertIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-alert-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const WifiOffIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-wifi-off" size={getSize(size)} className={className} color={color} title={title} />
);

export const SyncIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-sync" size={getSize(size)} className={className} color={color} title={title} />
);

export const ImportIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-tray-arrow-down" size={getSize(size)} className={className} color={color} title={title} />
);

// Calendar/Date icons
export const CalendarIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-calendar-today" size={getSize(size)} className={className} color={color} title={title} />
);

// Navigation icons
export const AllPagesIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-book-open-page-variant" size={getSize(size)} className={className} color={color} title={title} />
);

export const JournalIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-notebook-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const GraphIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-graph-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const MapIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-map" size={getSize(size)} className={className} color={color} title={title} />
);

export const ArchiveIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-archive-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const TaskIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-checkbox-marked-circle-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const TemplateIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-file-document-multiple-outline" size={getSize(size)} className={className} color={color} title={title} />
);

// Tag and property icons
export const TagIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-tag" size={getSize(size)} className={className} color={color} title={title} />
);

export const LinkIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-link" size={getSize(size)} className={className} color={color} title={title} />
);

export const PropertiesIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-clipboard-text-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const MetadataIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-tag-multiple-outline" size={getSize(size)} className={className} color={color} title={title} />
);

// Action icons
export const AddIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-plus" size={getSize(size)} className={className} color={color} title={title} />
);

export const MenuIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-menu" size={getSize(size)} className={className} color={color} title={title} />
);

export const DragHandleIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-drag" size={getSize(size)} className={className} color={color} title={title} />
);

export const DragVerticalIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-drag-vertical" size={getSize(size)} className={className} color={color} title={title} />
);

export const SearchIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-magnify" size={getSize(size)} className={className} color={color} title={title} />
);

export const EditIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-pencil" size={getSize(size)} className={className} color={color} title={title} />
);

export const DeleteIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-trash-can-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const TrashIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-trash-can-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const RestoreIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-restore" size={getSize(size)} className={className} color={color} title={title} />
);

export const CloseIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-close" size={getSize(size)} className={className} color={color} title={title} />
);

export const CommentIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-comment-text-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const ReplyIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-reply" size={getSize(size)} className={className} color={color} title={title} />
);

export const SendIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-send" size={getSize(size)} className={className} color={color} title={title} />
);

export const ResolveIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-check-circle-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const ImageIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-image-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const AttachmentIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-paperclip" size={getSize(size)} className={className} color={color} title={title} />
);

export const AudioIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-music-note-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const CopyIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-content-copy" size={getSize(size)} className={className} color={color} title={title} />
);

export const SettingsIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-cog" size={getSize(size)} className={className} color={color} title={title} />
);

// Graph view icons
export const ForceGraphIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-vector-polygon" size={getSize(size)} className={className} color={color} title={title} />
);

export const CircleLayoutIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-circle-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const TreeLayoutIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-file-tree-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const FitToScreenIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-fit-to-screen" size={getSize(size)} className={className} color={color} title={title} />
);

export const RefreshIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-refresh" size={getSize(size)} className={className} color={color} title={title} />
);

export const MoreIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-dots-horizontal" size={getSize(size)} className={className} color={color} title={title} />
);

// Navigation arrows
export const ChevronDownIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-chevron-down" size={getSize(size)} className={className} color={color} title={title} />
);

export const ChevronRightIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-chevron-right" size={getSize(size)} className={className} color={color} title={title} />
);

export const ChevronLeftIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-chevron-left" size={getSize(size)} className={className} color={color} title={title} />
);

export const ChevronUpIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-chevron-up" size={getSize(size)} className={className} color={color} title={title} />
);

export const PaletteIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-palette" size={getSize(size)} className={className} color={color} title={title} />
);

export const ArrowLeftIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-arrow-left" size={getSize(size)} className={className} color={color} title={title} />
);

export const ArrowRightIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-arrow-right" size={getSize(size)} className={className} color={color} title={title} />
);

// Status icons
export const BulletIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-circle-small" size={getSize(size)} className={className} color={color} title={title} />
);

export const HomeIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-home" size={getSize(size)} className={className} color={color} title={title} />
);

export const StarIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-star" size={getSize(size)} className={className} color={color} title={title} />
);

export const StarOutlineIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-star-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const ClockIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-clock-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const TableIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-table" size={getSize(size)} className={className} color={color} title={title} />
);

export const CodeIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-code-tags" size={getSize(size)} className={className} color={color} title={title} />
);

export const PinIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-pin-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const CheckboxCheckedIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-checkbox-marked-outline" size={getSize(size)} className={className} color={color} title={title} />
);

export const CheckboxUncheckedIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path="mdi-checkbox-blank-outline" size={getSize(size)} className={className} color={color} title={title} />
);
/**
 * Render an icon from a node's icon field
 * 
 * Supports:
 * - Emoji characters (rendered as-is)
 * - MDI icon names in camelCase (e.g. "mdiCalendarToday")
 * - Falls back to type-based defaults (page → document, block → bullet)
 * 
 * Note: Date pages (daily/monthly/yearly) inherit icons from their type definitions.
 */
export function NodeIcon({ 
  icon: rawIcon, 
  isPage = true,
  size = 'sm',
  className,
  color: colorProp,
}: { 
  icon?: string | null; 
  isPage?: boolean;
  size?: IconSize;
  className?: string;
  color?: string | null;
}) {
  // Parse JSON-encoded icon fields like {"icon":"mdiCalendarToday","color":"var(--color-preset-green)"}
  let icon = rawIcon;
  let parsedColor: string | undefined;
  if (rawIcon) {
    try {
      const parsed = JSON.parse(rawIcon) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).icon === 'string'
      ) {
        const obj = parsed as { icon: string; color?: string };
        icon = obj.icon;
        parsedColor = obj.color || undefined;
      }
    } catch {
      // Not JSON — use as plain string
    }
  }
  // Explicit color prop overrides parsed color
  const color = colorProp ?? parsedColor;

  // If icon is provided
  if (icon) {
    // Try to resolve it as an MDI CSS class
    const path = getMdiClass(icon);
    if (path) {
      return <Icon path={path} size={getSize(size)} className={className} color={color || undefined} />;
    }
    
    // If not an MDI icon, treat as emoji
    if (!icon.match(/^mdi[A-Z]/)) {
      // Render as emoji with appropriate size
      const emojiSize = getSize(size) * 24; // Convert to px (base is 24px)
      return (
        <span 
          className={className} 
          style={{ 
            fontSize: `${emojiSize}px`, 
            lineHeight: 1,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: `${emojiSize}px`,
            height: `${emojiSize}px`,
            verticalAlign: 'middle',
            ...(color ? { color } : {}),
          }}
        >
          {icon}
        </span>
      );
    }
  }
  
  // Fall back to type-based defaults
  // (Date pages now inherit icons from their type definitions)
  if (isPage) {
    return <PageIcon size={size} className={className} color={color || undefined} />;
  }

  return <BulletIcon size={size} className={className} color={color || undefined} />;
}
