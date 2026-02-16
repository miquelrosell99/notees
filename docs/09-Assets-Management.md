# Assets Management

The asset system handles file uploads (images, audio) with automatic thumbnail generation, short-lived access tokens, and seamless integration into the node hierarchy.

---

## Overview

Each asset is a **Node** with `is_asset=true`, linked to a file on disk:

```
data/workspaces/{workspace_uuid}/
  └── assets/
      └── {asset_uuid}/
          ├── main.jpg          # Source file
          └── thumbnail.webp    # Auto-generated thumbnail
```

**One asset node = one folder = one source file.** This invariant is enforced throughout the system.

---

## Supported File Types

| Category | Formats | Max Size |
|----------|---------|----------|
| Images | JPEG, PNG, WebP | 50 MB |
| Audio | MP3, WAV, OGG, OPUS, WebM | 50 MB |

---

## Uploading Assets

### Upload Endpoint

```http
POST /api/assets/upload
Content-Type: multipart/form-data
Authorization: Bearer {token}

file: (binary data)
parent_id: 100           # Optional: parent node for the asset
existing_node_id: 42     # Optional: convert existing node to asset
```

### Upload Flow

```
Client uploads file
       │
       ▼
  Validate type & size
       │
       ▼
  Create asset folder:
  assets/{uuid}/
       │
       ▼
  Write to temp file:
  assets/{uuid}/main.tmp
       │
       ▼
  Atomic rename:
  assets/{uuid}/main.{ext}
       │
       ▼
  Generate thumbnail
  (if image type)
       │
       ▼
  Create/update Node
  (is_asset=true)
       │
       ▼
  Return AssetResponse
```

**Atomic writes** ensure partial uploads don't leave corrupt files — the file is written to a temp location first, then renamed.

### Response

```json
{
  "uuid": "asset-uuid-123",
  "node_id": 201,
  "filename": "photo.jpg",
  "content_type": "image/jpeg",
  "category": "image",
  "size_bytes": 245760,
  "url": "/api/assets/asset-uuid-123"
}
```

### Converting Existing Nodes

The `existing_node_id` parameter converts an existing block into an asset node — useful when an empty block is replaced with an uploaded image:

```http
POST /api/assets/upload
Content-Type: multipart/form-data

file: photo.jpg
existing_node_id: 42    # This block becomes the asset node
```

---

## Thumbnails

Thumbnails are automatically generated for image files:

| Setting | Value |
|---------|-------|
| Max width | 800 px |
| Max height | 600 px |
| Quality | 85% |
| Format | WebP |
| Eligible formats | `.jpg`, `.jpeg`, `.png`, `.webp`, `.bmp`, `.gif` |

```http
GET /api/assets/{asset_uuid}/thumbnail?asset_token={token}
```

Thumbnails are generated asynchronously via Pillow and stored alongside the source file.

---

## Asset Access & Authentication

Assets use **short-lived tokens** instead of the standard JWT, since image/audio URLs in HTML need authentication embedded in the URL:

### Generate Access Token

```http
POST /api/assets/{asset_uuid}/token
Authorization: Bearer {token}
```

**Response:**

```json
{
  "token": "eyJhbGciOi...",
  "expires_at": "2026-02-16T10:05:00Z"
}
```

Tokens are:
- **5-minute** validity
- Scoped to a **specific asset UUID**
- JWT-encoded with the asset UUID as a claim

### Access Asset File

```http
# Via query parameter (for <img src> and <audio src> URLs)
GET /api/assets/{asset_uuid}?asset_token={short-lived-token}

# Via header (standard API requests)
GET /api/assets/{asset_uuid}
Authorization: Bearer {standard-jwt}
```

### Frontend Token Management

The `assetTokens.ts` module provides cached token management:

```typescript
// Get an authenticated URL for an asset
const url = await getAssetUrl(assetUuid);
// → "/api/assets/{uuid}?asset_token=eyJ..."

// Synchronous version (uses cached token)
const url = getAssetUrlSync(assetUuid);

// Clear cache (on logout/workspace switch)
clearAssetTokenCache();
```

Tokens are cached with a **30-second buffer** — a new token is requested 30 seconds before the current one expires.

---

## Replacing Assets

Existing assets can be replaced with a new file:

```python
class AssetService:
    def replace_asset(self, uuid: str, file_bytes: bytes, filename: str, content_type: str):
        """
        Atomic replacement:
        1. Write new file to temp
        2. Delete old main.* file
        3. Rename temp to main.{new_ext}
        4. Regenerate thumbnail if image
        5. Return (new_ext, old_ext, mime_changed)
        """
```

---

## Asset Metadata

```http
GET /api/assets/{asset_uuid}/info
Authorization: Bearer {token}
```

Returns metadata about the asset file without downloading it.

---

## Listing Assets

```http
GET /api/assets/?page=1&page_size=20
Authorization: Bearer {token}
```

**Response:**

```json
{
  "assets": [
    {
      "uuid": "asset-uuid-1",
      "node_id": 201,
      "filename": "photo.jpg",
      "content_type": "image/jpeg",
      "category": "image",
      "size_bytes": 245760,
      "url": "/api/assets/asset-uuid-1"
    }
  ],
  "total": 42
}
```

---

## Deleting Assets

```http
DELETE /api/assets/{asset_uuid}
Authorization: Bearer {token}
```

Deletes both:
- The asset **folder** on disk (via `shutil.rmtree`)
- The asset **node** from the database

When a node is soft-deleted, its associated asset folder is also deleted from disk.

---

## Asset Integrity Verification

```python
class AssetService:
    def verify_asset(self, uuid: str) -> Tuple[bool, Optional[str], Optional[str]]:
        """
        Returns (is_valid, error_message, extension)
        
        Checks:
        1. Asset folder exists
        2. Exactly one main.* file exists
        3. File has a valid extension
        """
```

---

## Frontend: Image Integration

### Banner & Cover Images

Pages can have banner and cover images stored as system properties:

```
┌──────────────────────────────────────────┐
│ ┌──────────────────────────────────────┐ │
│ │          Banner Image                │ │  ← SYSTEM_PROPERTY_UUIDS.banner
│ └──────────────────────────────────────┘ │
│                                          │
│ ┌──────┐                                │
│ │Cover │  📋 My Page Title              │  ← SYSTEM_PROPERTY_UUIDS.cover
│ │Image │                                │
│ └──────┘                                │
│                                          │
│ • Block content here...                  │
└──────────────────────────────────────────┘
```

Both support drag-and-drop upload via `useDragDropImage()` hook.

### Upload Flow in the Editor

```
User drops image into block area
         │
         ▼
   useDragDropImage hook detects file
         │
         ▼
   POST /api/assets/upload
   (with parent_id = current page)
         │
         ▼
   Asset node created
         │
         ▼
   Block content updated with
   asset reference in the AST
         │
         ▼
   Image renders inline with
   authenticated URL
```

### Audio Playback

Audio assets render as HTML5 `<audio>` elements with token-authenticated source URLs:

```html
<audio controls>
  <source src="/api/assets/{uuid}?asset_token={token}" type="audio/mpeg">
</audio>
```

---

## Image-Type Properties

Properties of type `image` store asset node references:

```http
# Set an image property
POST /api/nodes/{node_id}/properties
{ "property_id": 20, "value": 201 }  # 201 is the asset node ID
```

When an image property value is **deleted**, the asset node is also deleted (since it's a floating node with no other parent).

---

## Error Handling

```python
class AssetError(Exception):
    """Base asset error"""

class AssetMissingError(AssetError):
    """Asset file or folder not found on disk"""

class AssetInvariantViolation(AssetError):
    """Multiple files in asset folder, or other invariant broken"""

class AssetPermissionError(AssetError):
    """File system permission error"""
```
