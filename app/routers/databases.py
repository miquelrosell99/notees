"""Database management router (refactored).

Handles database creation, switching, import/export.
Uses domain types where applicable.
"""
from fastapi import APIRouter, HTTPException, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse
from pathlib import Path
import tempfile
import shutil

from ..models import DatabaseCreate, User
from ..domain import DatabaseNotFoundError, DuplicateDatabaseError
from .auth import get_current_user

# Import legacy db - database management is infrastructure-level
from .. import database as db

router = APIRouter(prefix="/api/databases", tags=["Databases"])


def _db_error_to_http(error: Exception) -> HTTPException:
    """Convert domain errors to HTTP exceptions."""
    if isinstance(error, DatabaseNotFoundError):
        return HTTPException(status_code=404, detail=error.message)
    elif isinstance(error, DuplicateDatabaseError):
        return HTTPException(status_code=409, detail=error.message)
    else:
        return HTTPException(status_code=500, detail=str(error))


@router.get("")
async def list_databases(user: User = Depends(get_current_user)):
    """List all available databases for current user."""
    databases = await db.list_databases(user.id)
    active = db.get_active_db_name(user.id)
    return {"databases": databases, "active": active}


@router.get("/check-name/{name}")
async def check_database_name(name: str, user: User = Depends(get_current_user)):
    """Check if a database name is available."""
    databases = await db.list_databases(user.id)
    exists = any(d['name'] == name for d in databases)
    return {"available": not exists, "name": name}


@router.post("")
async def create_database(data: DatabaseCreate, user: User = Depends(get_current_user)):
    """Create a new database."""
    try:
        database = await db.create_database(user.id, data.name)
        return database
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{name}/switch")
async def switch_database(name: str, user: User = Depends(get_current_user)):
    """Switch to a different database."""
    success = await db.switch_database(user.id, name)
    if not success:
        raise HTTPException(status_code=404, detail=f"Database '{name}' not found")
    return {"status": "ok", "active": name}


@router.put("/{name}/rename")
async def rename_database(name: str, data: DatabaseCreate, user: User = Depends(get_current_user)):
    """Rename a database."""
    try:
        database = await db.rename_database(user.id, name, data.name)
        return database
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{name}")
async def delete_database(name: str, user: User = Depends(get_current_user)):
    """Delete a database."""
    try:
        success = await db.delete_database(user.id, name)
        if not success:
            raise HTTPException(status_code=404, detail=f"Database '{name}' not found")
        return {"status": "ok"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{name}/export")
async def export_database(name: str, user: User = Depends(get_current_user)):
    """Export a database file for download."""
    try:
        export_path = await db.export_database(user.id, name)
        return FileResponse(
            export_path,
            filename=export_path.name,
            media_type="application/octet-stream"
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/import")
async def import_database(
    file: UploadFile = File(...),
    name: str = Form(...),
    user: User = Depends(get_current_user)
):
    """Import a database file."""
    # Save uploaded file temporarily
    with tempfile.NamedTemporaryFile(delete=False, suffix=".db") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = Path(tmp.name)
    
    try:
        database = await db.import_database(user.id, tmp_path, name)
        return database
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        tmp_path.unlink(missing_ok=True)
