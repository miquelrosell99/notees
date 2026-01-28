# Asset System Migration Guide

## Overview
This document describes the migration from flat asset storage to per-asset folder structure, required for the new atomic asset block system.

## Storage Structure Changes

### OLD Structure (Pre-Migration)
```
graphs/{graph_id}/assets/
  {uuid}.jpg
  {uuid}.png
  {uuid}.mp3
  ...
```

### NEW Structure (Post-Migration)
```
graphs/{graph_id}/assets/
  {uuid}/
    {uuid}.jpg      # original file
    thumbnail.webp  # (future) auto-generated thumbnail
  {uuid}/
    {uuid}.png
    thumbnail.webp
  ...
```

## Migration Script

Run this Python script to migrate existing assets:

```python
"""
Migrate assets from flat structure to per-asset folders.

Run from project root:
  python scripts/migrate_assets_to_folders.py
"""
import os
import shutil
from pathlib import Path

def migrate_graph_assets(graph_id: int, data_dir: Path):
    """Migrate assets for a single graph."""
    assets_dir = data_dir / "graphs" / str(graph_id) / "assets"
    
    if not assets_dir.exists():
        print(f"  No assets directory for graph {graph_id}")
        return
    
    # Find all asset files (not directories)
    files = [f for f in assets_dir.iterdir() if f.is_file()]
    
    if not files:
        print(f"  No assets to migrate for graph {graph_id}")
        return
    
    print(f"  Migrating {len(files)} assets for graph {graph_id}...")
    
    for asset_file in files:
        # Extract UUID from filename (before extension)
        uuid = asset_file.stem
        
        # Create per-asset folder
        asset_folder = assets_dir / uuid
        asset_folder.mkdir(exist_ok=True)
        
        # Move file into folder with same name
        new_path = asset_folder / asset_file.name
        
        if not new_path.exists():
            shutil.move(str(asset_file), str(new_path))
            print(f"    Moved {asset_file.name} -> {uuid}/{asset_file.name}")
        else:
            print(f"    Skipped {asset_file.name} (already exists)")

def main():
    """Migrate all graphs in data directory."""
    # Adjust this path if your data directory is elsewhere
    data_dir = Path("data")
    
    if not data_dir.exists():
        print(f"Data directory not found: {data_dir}")
        return
    
    graphs_dir = data_dir / "graphs"
    if not graphs_dir.exists():
        print(f"Graphs directory not found: {graphs_dir}")
        return
    
    # Find all graph directories
    graph_ids = [int(d.name) for d in graphs_dir.iterdir() if d.is_dir() and d.name.isdigit()]
    
    if not graph_ids:
        print("No graphs found to migrate")
        return
    
    print(f"Found {len(graph_ids)} graph(s) to migrate")
    
    for graph_id in sorted(graph_ids):
        print(f"\nMigrating graph {graph_id}...")
        migrate_graph_assets(graph_id, data_dir)
    
    print("\n✅ Migration complete!")

if __name__ == "__main__":
    main()
```

## Verification Steps

After migration, verify:

1. **No orphaned files in assets root:**
   ```bash
   # Should show only directories
   ls data/graphs/*/assets/
   ```

2. **Each asset has its own folder:**
   ```bash
   # Each UUID should be a folder containing the asset file
   ls data/graphs/2/assets/
   ```

3. **File structure is correct:**
   ```bash
   # Example output:
   # data/graphs/2/assets/abc123/abc123.jpg
   # data/graphs/2/assets/def456/def456.png
   ```

4. **Test in app:**
   - Upload a new asset → should create folder automatically
   - View existing asset → should load from folder
   - Delete asset → should remove entire folder

## Rollback

If needed, rollback by flattening structure:

```bash
# For each graph
cd data/graphs/{graph_id}/assets/
for dir in */; do
  mv "$dir"/* ./
  rmdir "$dir"
done
```

## Code Changes Summary

### Backend (`app/routers/assets.py`)
- `get_asset_path()`: Now creates per-asset folder
- `upload_asset()`: Saves to `{uuid}/{uuid}.{ext}`
- `get_asset()`: Scans folder for file
- `get_asset_info()`: Scans folder for metadata

### Frontend
- **New**: `AssetBlock.tsx` - Single component for all assets
- **New**: `ImageRenderer.tsx` - Image display
- **New**: `AudioRenderer.tsx` - Audio player
- **New**: `GenericRenderer.tsx` - File card
- **New**: `mimeUtils.ts` - MIME type utilities
- **Updated**: `Block.tsx` - Renders AssetBlock for asset nodes
- **Removed**: `BlockImage.tsx`, `BlockAsset.tsx` (replaced by AssetBlock)

## Future Enhancements

With per-asset folders in place, we can now:

1. **Auto-generate thumbnails**
   ```
   assets/{uuid}/thumbnail.webp
   ```
   
2. **Store multiple versions**
   ```
   assets/{uuid}/{uuid}.jpg       # original
   assets/{uuid}/preview.jpg      # medium size
   assets/{uuid}/thumbnail.webp   # small thumbnail
   ```

3. **Add metadata**
   ```
   assets/{uuid}/metadata.json    # EXIF, dimensions, etc.
   ```

4. **Support asset variants**
   ```
   assets/{uuid}/{uuid}.mp4       # original video
   assets/{uuid}/compressed.mp4   # web-optimized
   assets/{uuid}/poster.jpg       # video thumbnail
   ```

## Testing Checklist

- [ ] Migrate existing assets with script
- [ ] Upload new image asset
- [ ] Upload new audio asset
- [ ] Upload new document asset
- [ ] View image in block (inline preview)
- [ ] Click image to open lightbox
- [ ] Play audio with Space key
- [ ] Download generic file
- [ ] Edit asset title (node name)
- [ ] Delete asset node (folder removed)
- [ ] Replace asset file (preserves UUID)

## Breaking Changes

⚠️ **Important**: This migration changes file paths on disk but **does not require database changes**. The node UUID remains stable, and rendering is inferred from MIME type.

### No Breaking Changes For:
- ✅ Node schema (no new fields)
- ✅ Node UUIDs (stable)
- ✅ API endpoints (same URLs)
- ✅ User data (titles preserved)

### Breaking Changes:
- ⚠️ Direct file access via filesystem (must use API)
- ⚠️ Old file paths invalid (need migration script)
- ⚠️ Custom scripts accessing assets (update paths)
