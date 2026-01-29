"""
Migrate assets from flat structure to per-asset folders.

HISTORICAL SCRIPT: This script was used for the initial folder structure migration.
Note: As of the UUID-based graph folders update, asset paths are now:
  graphs/{graph_uuid}/assets/{uuid}/{uuid}.{ext}

This script migrates the asset storage structure from:
  graphs/{graph_id}/assets/{uuid}.{ext}

To:
  graphs/{graph_id}/assets/{uuid}/{uuid}.{ext}

This enables future thumbnail support and better asset organization.

Usage:
  python scripts/migrate_assets_to_folders.py

Options:
  --dry-run    Show what would be migrated without making changes
  --data-dir   Specify custom data directory (default: ./data)
"""
import argparse
import os
import shutil
from pathlib import Path
from typing import List, Tuple


def find_asset_files(assets_dir: Path) -> List[Path]:
    """Find all asset files (not directories) in assets directory."""
    if not assets_dir.exists():
        return []
    
    return [f for f in assets_dir.iterdir() if f.is_file() and not f.name.startswith('.')]


def migrate_asset_file(asset_file: Path, dry_run: bool = False) -> Tuple[bool, str]:
    """
    Migrate a single asset file to per-asset folder structure.
    
    Returns:
        (success, message) tuple
    """
    # Extract UUID from filename (everything before extension)
    uuid = asset_file.stem
    assets_dir = asset_file.parent
    
    # Create per-asset folder
    asset_folder = assets_dir / uuid
    new_path = asset_folder / asset_file.name
    
    # Check if already migrated
    if new_path.exists():
        return False, f"Skipped {asset_file.name} (already exists in folder)"
    
    if dry_run:
        return True, f"Would move {asset_file.name} -> {uuid}/{asset_file.name}"
    
    # Create folder and move file
    try:
        asset_folder.mkdir(exist_ok=True)
        shutil.move(str(asset_file), str(new_path))
        return True, f"Moved {asset_file.name} -> {uuid}/{asset_file.name}"
    except Exception as e:
        return False, f"Error migrating {asset_file.name}: {e}"


def migrate_graph_assets(graph_id: int, data_dir: Path, dry_run: bool = False) -> Tuple[int, int]:
    """
    Migrate assets for a single graph.
    
    Returns:
        (migrated_count, error_count) tuple
    """
    assets_dir = data_dir / "graphs" / str(graph_id) / "assets"
    
    if not assets_dir.exists():
        print(f"  ⚠️  No assets directory for graph {graph_id}")
        return 0, 0
    
    # Find all asset files
    files = find_asset_files(assets_dir)
    
    if not files:
        print(f"  ✓ No assets to migrate for graph {graph_id} (or already migrated)")
        return 0, 0
    
    print(f"  Found {len(files)} asset(s) to migrate...")
    
    migrated = 0
    errors = 0
    
    for asset_file in files:
        success, message = migrate_asset_file(asset_file, dry_run)
        print(f"    {message}")
        
        if success:
            migrated += 1
        else:
            if "already exists" not in message:
                errors += 1
    
    return migrated, errors


def main():
    """Main migration script."""
    parser = argparse.ArgumentParser(
        description="Migrate assets to per-asset folder structure"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be migrated without making changes"
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path("data"),
        help="Path to data directory (default: ./data)"
    )
    
    args = parser.parse_args()
    
    print("=" * 60)
    print("Asset Migration: Flat → Per-Asset Folders")
    print("=" * 60)
    
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be made")
        print()
    
    # Validate data directory
    if not args.data_dir.exists():
        print(f"❌ Data directory not found: {args.data_dir}")
        print("   Use --data-dir to specify a different location")
        return 1
    
    graphs_dir = args.data_dir / "graphs"
    if not graphs_dir.exists():
        print(f"❌ Graphs directory not found: {graphs_dir}")
        return 1
    
    # Find all graph directories
    graph_dirs = [d for d in graphs_dir.iterdir() if d.is_dir() and d.name.isdigit()]
    
    if not graph_dirs:
        print("ℹ️  No graphs found to migrate")
        return 0
    
    graph_ids = sorted([int(d.name) for d in graph_dirs])
    print(f"📊 Found {len(graph_ids)} graph(s): {graph_ids}")
    print()
    
    total_migrated = 0
    total_errors = 0
    
    for graph_id in graph_ids:
        print(f"🔄 Migrating graph {graph_id}...")
        migrated, errors = migrate_graph_assets(graph_id, args.data_dir, args.dry_run)
        total_migrated += migrated
        total_errors += errors
        print()
    
    # Summary
    print("=" * 60)
    if args.dry_run:
        print(f"🔍 DRY RUN COMPLETE")
        print(f"   Would migrate: {total_migrated} asset(s)")
        print(f"   Errors: {total_errors}")
        print()
        print("Run without --dry-run to perform migration")
    else:
        print(f"✅ MIGRATION COMPLETE")
        print(f"   Migrated: {total_migrated} asset(s)")
        print(f"   Errors: {total_errors}")
        
        if total_errors > 0:
            print()
            print("⚠️  Some assets had errors - review output above")
    
    print("=" * 60)
    
    return 1 if total_errors > 0 else 0


if __name__ == "__main__":
    exit(main())
