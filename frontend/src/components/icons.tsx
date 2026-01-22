/**
 * MDI Icons for the application
 * 
 * Uses @mdi/react and @mdi/js for Material Design Icons.
 * Provides default icons for system tags and pages.
 */
import Icon from '@mdi/react';
import * as mdiIcons from '@mdi/js';
import {
  mdiFileDocumentOutline,
  mdiCalendarToday,
  mdiBookOpenPageVariant,
  mdiNotebookOutline,
  mdiGraphOutline,
  mdiTag,
  mdiLink,
  mdiClipboardTextOutline,
  mdiPlus,
  mdiMenu,
  mdiMagnify,
  mdiChevronDown,
  mdiChevronRight,
  mdiChevronUp,
  mdiCircleSmall,
  mdiHome,
  mdiFolderOutline,
  mdiFolderOpenOutline,
  mdiStar,
  mdiStarOutline,
  mdiPinOutline,
  mdiCheckboxMarkedOutline,
  mdiCheckboxBlankOutline,
  mdiCog,
  mdiDotsHorizontal,
  mdiPencil,
  mdiTrashCanOutline,
  mdiContentCopy,
  mdiArrowLeft,
  mdiArrowRight,
  mdiChevronLeft,
  mdiClose,
  mdiCommentTextOutline,
  mdiArchiveOutline,
  mdiImageOutline,
  mdiPaperclip,
  mdiMusicNoteOutline,
  mdiCheckboxMarkedCircleOutline,
  mdiFileDocumentMultipleOutline,
  mdiDatabaseOutline,
  mdiCheck,
  mdiAlertOutline,
  mdiWifiOff,
  mdiSync,
  mdiTrayArrowDown,
  mdiMap,
  mdiClockOutline,
  mdiTable,
  mdiDrag,
  // Graph view icons
  mdiVectorPolygon,
  mdiCircleOutline,
  mdiFileTreeOutline,
  mdiFitToScreen,
  mdiRefresh,
  mdiPalette,
} from '@mdi/js';

// Icon size presets
export const ICON_SIZE = {
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
  <Icon path={mdiFileDocumentOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const FolderIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiFolderOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const FolderOpenIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiFolderOpenOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const DatabaseIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiDatabaseOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const CheckIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiCheck} size={getSize(size)} className={className} color={color} title={title} />
);

export const AlertIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiAlertOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const WifiOffIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiWifiOff} size={getSize(size)} className={className} color={color} title={title} />
);

export const SyncIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiSync} size={getSize(size)} className={className} color={color} title={title} />
);

export const ImportIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiTrayArrowDown} size={getSize(size)} className={className} color={color} title={title} />
);

// Calendar/Date icons
export const CalendarIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiCalendarToday} size={getSize(size)} className={className} color={color} title={title} />
);

// Navigation icons
export const AllPagesIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiBookOpenPageVariant} size={getSize(size)} className={className} color={color} title={title} />
);

export const JournalIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiNotebookOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const GraphIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiGraphOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const MapIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiMap} size={getSize(size)} className={className} color={color} title={title} />
);

export const ArchiveIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiArchiveOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const TaskIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiCheckboxMarkedCircleOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const TemplateIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiFileDocumentMultipleOutline} size={getSize(size)} className={className} color={color} title={title} />
);

// Tag and property icons
export const TagIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiTag} size={getSize(size)} className={className} color={color} title={title} />
);

export const LinkIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiLink} size={getSize(size)} className={className} color={color} title={title} />
);

export const PropertiesIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiClipboardTextOutline} size={getSize(size)} className={className} color={color} title={title} />
);

// Action icons
export const AddIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiPlus} size={getSize(size)} className={className} color={color} title={title} />
);

export const MenuIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiMenu} size={getSize(size)} className={className} color={color} title={title} />
);

export const DragHandleIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiDrag} size={getSize(size)} className={className} color={color} title={title} />
);

export const SearchIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiMagnify} size={getSize(size)} className={className} color={color} title={title} />
);

export const EditIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiPencil} size={getSize(size)} className={className} color={color} title={title} />
);

export const DeleteIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiTrashCanOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const TrashIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiTrashCanOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const CloseIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiClose} size={getSize(size)} className={className} color={color} title={title} />
);

export const CommentIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiCommentTextOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const ImageIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiImageOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const AttachmentIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiPaperclip} size={getSize(size)} className={className} color={color} title={title} />
);

export const AudioIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiMusicNoteOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const CopyIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiContentCopy} size={getSize(size)} className={className} color={color} title={title} />
);

export const SettingsIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiCog} size={getSize(size)} className={className} color={color} title={title} />
);

// Graph view icons
export const ForceGraphIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiVectorPolygon} size={getSize(size)} className={className} color={color} title={title} />
);

export const CircleLayoutIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiCircleOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const TreeLayoutIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiFileTreeOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const FitToScreenIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiFitToScreen} size={getSize(size)} className={className} color={color} title={title} />
);

export const RefreshIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiRefresh} size={getSize(size)} className={className} color={color} title={title} />
);

export const MoreIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiDotsHorizontal} size={getSize(size)} className={className} color={color} title={title} />
);

// Navigation arrows
export const ChevronDownIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiChevronDown} size={getSize(size)} className={className} color={color} title={title} />
);

export const ChevronRightIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiChevronRight} size={getSize(size)} className={className} color={color} title={title} />
);

export const ChevronLeftIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiChevronLeft} size={getSize(size)} className={className} color={color} title={title} />
);

export const ChevronUpIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiChevronUp} size={getSize(size)} className={className} color={color} title={title} />
);

export const PaletteIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiPalette} size={getSize(size)} className={className} color={color} title={title} />
);

export const ArrowLeftIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiArrowLeft} size={getSize(size)} className={className} color={color} title={title} />
);

export const ArrowRightIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiArrowRight} size={getSize(size)} className={className} color={color} title={title} />
);

// Status icons
export const BulletIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiCircleSmall} size={getSize(size)} className={className} color={color} title={title} />
);

export const HomeIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiHome} size={getSize(size)} className={className} color={color} title={title} />
);

export const StarIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiStar} size={getSize(size)} className={className} color={color} title={title} />
);

export const StarOutlineIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiStarOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const ClockIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiClockOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const TableIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiTable} size={getSize(size)} className={className} color={color} title={title} />
);

export const PinIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiPinOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const CheckboxCheckedIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiCheckboxMarkedOutline} size={getSize(size)} className={className} color={color} title={title} />
);

export const CheckboxUncheckedIcon = ({ size = 'md', className, color, title }: IconProps) => (
  <Icon path={mdiCheckboxBlankOutline} size={getSize(size)} className={className} color={color} title={title} />
);

/**
 * Default icons for system tags and pages
 * Maps system tag/page names to their default icon components
 */
export const DEFAULT_ICONS = {
  // Page types
  page: PageIcon,
  daily: CalendarIcon,
  journal: JournalIcon,
  
  // System views
  'all-pages': AllPagesIcon,
  graph: GraphIcon,
  
  // Organization
  tag: TagIcon,
  folder: FolderIcon,
  
  // Links
  link: LinkIcon,
  backlink: LinkIcon,
  
  // Properties
  properties: PropertiesIcon,
  
  // Navigation
  home: HomeIcon,
  
  // Status
  starred: StarIcon,
  pinned: PinIcon,
  clock: ClockIcon,
  recent: ClockIcon,
} as const;

/**
 * Get the default icon component for a given type
 */
export function getDefaultIcon(type: keyof typeof DEFAULT_ICONS): React.ComponentType<IconProps> {
  return DEFAULT_ICONS[type] || PageIcon;
}

/**
 * Render an icon from a node's icon field
 * 
 * Supports:
 * - Emoji characters (rendered as-is)
 * - MDI icon names like "mdi-calendar" or "mdiCalendar" or "calendar"
 * - Falls back to type-based defaults (page → document, block → bullet)
 * 
 * Note: Date pages (daily/monthly/yearly) inherit icons from their type definitions.
 */
export function NodeIcon({ 
  icon, 
  isPage = true,
  size = 'sm',
  className,
}: { 
  icon?: string | null; 
  isPage?: boolean;
  size?: IconSize;
  className?: string;
}) {
  // If icon is provided
  if (icon) {
    // Try to resolve it from @mdi/js (MDI icons start with mdi- or similar patterns)
    const path = getMdiPath(icon);
    if (path) {
      return <Icon path={path} size={getSize(size)} className={className} />;
    }
    
    // If not an MDI icon, it might be an emoji - render as text
    // Check if it looks like an emoji (not an MDI-like pattern)
    if (!icon.match(/^mdi/i) && !icon.match(/^[a-z-]+$/i)) {
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
    return <PageIcon size={size} className={className} />;
  }
  
  return <BulletIcon size={size} className={className} />;
}

/**
 * Convert an icon name to an MDI path
 * Accepts formats: "mdi-calendar-today", "mdiCalendarToday", "calendar-today", "calendarToday"
 */
function getMdiPath(iconName: string): string | null {
  // Normalize: remove "mdi-" prefix, convert kebab-case to camelCase
  let normalized = iconName
    .replace(/^mdi-?/i, '')  // Remove mdi- or mdi prefix
    .replace(/-([a-z])/g, (_, c) => c.toUpperCase());  // kebab to camelCase
  
  // Ensure first letter is lowercase, then prepend "mdi"
  normalized = 'mdi' + normalized.charAt(0).toUpperCase() + normalized.slice(1);
  
  // Look up in the mdiIcons object
  const path = (mdiIcons as Record<string, string>)[normalized];
  return path || null;
}
