# Daily Journals

The journal system provides automatic daily, monthly, and yearly pages that form a date-based hierarchy for chronological note-taking.

---

## Overview

Daily pages are **automatically created** when accessed and organized in a hierarchy:

```
2026 (is_year=true)
├── January 2026 (is_month=true)
│   ├── January 1, 2026 (is_day=true)
│   ├── January 2, 2026
│   └── ...
├── February 2026
│   ├── February 1, 2026
│   ├── February 16, 2026  ← Today
│   └── ...
└── ...
```

---

## Date UUID Encoding

Date pages use **deterministic UUIDs** derived from the date, making them idempotent:

| Type | UUID Format | Example |
|------|------------|---------|
| Day | `YYYYMMDD` | `20260216` |
| Month | `YYYYMM00` | `20260200` |
| Year | `YYYY0000` | `20260000` |

This means:
- Requesting the same date twice returns the same page
- Date pages can be looked up by UUID without a database query
- The hierarchy is deterministic and consistent

---

## Creating Date Pages

### Get or Create Daily Page

```http
POST /api/nodes/daily?date=2026-02-16
Authorization: Bearer {token}
```

This endpoint is **idempotent** — it creates the page if it doesn't exist, or returns the existing one:

1. Computes the UUID: `20260216`
2. Checks if a node with that UUID exists
3. If not:
   - Creates the year page (`2026`) if missing
   - Creates the month page (`February 2026`) as child of the year if missing
   - Creates the day page (`February 16, 2026`) as child of the month
4. Returns the day page

**Race condition handling**: If two requests try to create the same date simultaneously, duplicate key detection catches the collision and returns the existing page.

### Get or Create Monthly/Yearly Pages

```http
POST /api/nodes/monthly?year=2026&month=2
POST /api/nodes/yearly?year=2026
```

### List All Daily Pages

```http
GET /api/nodes/daily/list
```

Returns all daily pages ordered by UUID (date) descending — most recent first.

---

## Date Naming Format

The date page name is formatted using the user's preferred date format (stored in `setting_user` table):

| Format | Example Day | Example Month |
|--------|------------|---------------|
| `MMMM D, YYYY` | February 16, 2026 | February 2026 |
| `D MMMM YYYY` | 16 February 2026 | February 2026 |
| `YYYY/MM/DD` | 2026/02/16 | 2026/02 |
| `DD/MM/YYYY` | 16/02/2026 | 02/2026 |
| `MM/DD/YYYY` | 02/16/2026 | 02/2026 |
| `YYYY-MM-DD` | 2026-02-16 | 2026-02 |

### Changing the Date Format

```http
POST /api/nodes/settings/update-date-format
{ "new_format": "YYYY-MM-DD" }
```

This **renames all existing date/month pages** to the new format. Year pages are not renamed.

---

## System Classes for Dates

Date pages are automatically assigned system classes:

| Class | Flag | UUID |
|-------|------|------|
| `day` | `is_day=true` | Fixed system UUID |
| `month` | `is_month=true` | Fixed system UUID |
| `year` | `is_year=true` | Fixed system UUID |

These classes are **protected** — they cannot be manually added or removed from nodes:

```python
PROTECTED_DATE_CLASS_UUIDS = {
    SYSTEM_CLASS_UUIDS["day"],
    SYSTEM_CLASS_UUIDS["month"],
    SYSTEM_CLASS_UUIDS["year"],
}
```

---

## Deletion Constraints

- **Month pages** cannot be deleted if they have active (non-deleted) day children
- **Year pages** cannot be deleted if they have active month children
- Day pages can be freely deleted

```
# This will return 400 Bad Request:
DELETE /api/nodes/{month_page_id}
→ "Cannot delete month page with active day children"
```

---

## Frontend: Journals View

The `JournalsView` displays a reverse-chronological list of **existing** daily pages:

```
┌──────────────────────────────────────────────┐
│ 📅 Journals                                  │
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │ February 16, 2026                        │ │
│ │ • Worked on documentation               │ │
│ │ • Fixed bug in query system              │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │ February 15, 2026                        │ │
│ │ • Team meeting notes                     │ │
│ │ • Planning sprint goals                  │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ [Load more...]                               │
└──────────────────────────────────────────────┘
```

**Key behaviors:**
- Does **not** auto-create new daily pages — only shows existing ones
- Each day is rendered as a compact `NodeViewContent` (no properties, backlinks, or query sections)
- Lazy-loads 10 pages at a time with "Load more" button
- Colored pages get a bordered `Card` wrapper
- Opens the full `NodeView` when clicking on a day's header

### Frontend Hooks

```typescript
// Existing daily pages list
const { data: dailyPages } = useExistingDailyPages();

// Get or create today's page
const { data: todayPage } = useTodayNote();

// Get or create a specific date's page
const { data: datePage } = useDailyNote("2026-02-16");

// Get or create monthly/yearly
const { data: monthPage } = useMonthlyNote(2026, 2);
const { data: yearPage } = useYearlyNote(2026);
```

---

## Today Button & Calendar

The `TopBar` provides quick access to today's journal:

### Today Button

Clicking "Today" in the top bar navigates to today's daily page (creating it if needed).

### Calendar Popup

The calendar popup (`CalendarPopup`) allows navigating to any date:

```
┌─────────────────────────────┐
│ ◀ February 2026 ▶           │
│                             │
│ Mo Tu We Th Fr Sa Su        │
│                    1        │
│  2  3  4  5  6  7  8       │
│  9 10 11 12 13 14 15       │
│ [16] 17 18 19 20 21 22     │
│ 23 24 25 26 27 28          │
│                             │
└─────────────────────────────┘
```

Clicking a date navigates to (and creates if needed) that day's page.

---

## Quick Add Integration

The Quick Add panel (`Ctrl+N`) can create blocks in today's page:

```typescript
const { createBlocks } = useQuickAdd();

// Creates blocks in today's page
await createBlocks(todayPageId);
```

The `quickAddDestination` setting controls whether new blocks go to:
- `today` — Today's daily page
- `inbox` — The Inbox page

---

## Date Properties

Date-type properties link to day pages, creating bidirectional connections:

```http
POST /api/nodes/{node_id}/properties
{ "property_id": 16, "value": "2026-02-16" }
```

This creates (or finds) the day page for February 16, 2026 and stores a `property_value_relation` pointing to it. The day page's property backlinks will then show this node.

---

## Command Palette Date Parsing

The Command Palette (`Ctrl+K`) can parse typed dates and navigate to journal pages:

```
┌─────────────────────────────────────┐
│ 🔍 feb 16                          │
│                                     │
│ 📅 February 16, 2026    → Navigate │
│ 📅 February 2026        → Navigate │
│ 📅 2026                 → Navigate │
└─────────────────────────────────────┘
```

The `parseDate()` utility supports multiple formats:
- ISO: `2026-02-16`
- US: `02/16/2026`
- EU: `16/02/2026`
- Named: `feb 16`, `february 2026`
- Relative: `today`, `yesterday`, `tomorrow`

---

## Late Night Thoughts Filter

The `NodeView` includes an optional "late night thoughts" filter that shows only blocks created between 10PM and 4AM — useful for reviewing late-night journal entries:

```typescript
// Toggle via appStore
const { lateNightThoughtsFilter, toggleLateNightThoughtsFilter } = useAppStore();
```
