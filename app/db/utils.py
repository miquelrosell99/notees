"""Utility functions for database operations."""
import json
import uuid as uuid_module
from typing import Any, Dict


import re

def generate_uuid() -> str:
    """Generate a UUID for nodes."""
    return str(uuid_module.uuid4())


def parse_node(row) -> Dict[str, Any]:
    """Parse database row into node dict."""
    node = dict(row)
    node["tags"] = json.loads(node.get("tags") or "[]")
    node["properties"] = json.loads(node.get("properties") or "{}")
    node["deleted"] = bool(node.get("deleted", 0))
    # System Flags
    node["is_system"] = bool(node.get("is_system", 0))
    # Core Structures
    node["is_page"] = bool(node.get("is_page", 0))
    node["is_tag"] = bool(node.get("is_tag", 0))
    node["is_property"] = bool(node.get("is_property", 0))
    # Functional Types
    node["is_task"] = bool(node.get("is_task", 0))
    node["is_template"] = bool(node.get("is_template", 0))
    # Time/Journal Types
    node["is_daily"] = bool(node.get("is_daily", 0))
    node["is_monthly"] = bool(node.get("is_monthly", 0))
    node["is_yearly"] = bool(node.get("is_yearly", 0))
    return node


def format_date_display(date_str: str, format_str: str = "YYYY-MM-DD") -> str:
    """Format a YYYYMMdd date string for display."""
    if not date_str:
        return date_str
    
    # Pad inputs if they are just YYYY or YYYYMM
    if len(date_str) == 4: # Year
        year = date_str
        month = "01"
        day = "01"
    elif len(date_str) == 6: # Month
        year = date_str[:4]
        month = date_str[4:6]
        day = "01"
    elif len(date_str) >= 8: # Day
        year = date_str[:4]
        month = date_str[4:6]
        day = date_str[6:8]
    else:
        return date_str

    # Handle format replacements
    # If format is specifically just for Year or Month, we might want to respect that?
    # But usually this is called with a full date format.
    # We'll just replace what is present.
    
    result = format_str.replace("YYYY", year).replace("MM", month).replace("DD", day)
    return result


def is_any_date_format(text: str) -> bool:
    """Check if text matches any reserved date format patterns."""
    if not text:
        return False
        
    text = text.strip()
    
    # Common separators: -, /, ., space, none
    # Year: 4 digits
    # Month: 1-2 digits
    # Day: 1-2 digits
    
    patterns = [
        r'^\d{4}$', # YYYY (e.g. 2026)
        r'^\d{4}[-/. ]\d{1,2}$', # YYYY-MM
        r'^\d{4}[-/. ]\d{1,2}[-/. ]\d{1,2}$', # YYYY-MM-DD
        r'^\d{1,2}[-/. ]\d{1,2}[-/. ]\d{4}$', # DD-MM-YYYY or MM-DD-YYYY
        r'^\d{8}$', # YYYYMMDD
        r'^\d{6}$', # YYYYMM
    ]
    
    for pattern in patterns:
        if re.match(pattern, text):
            return True
            
    return False



from .connection import get_db
from typing import Optional

async def get_user_setting(user_id: str, key: str) -> Optional[str]:
    """Get a user setting (from settings table)."""
    db = await get_db(user_id)
    try:
        cursor = await db.execute("SELECT value FROM settings WHERE key = ?", (key,))
        row = await cursor.fetchone()
        if row:
            return row["value"]
        return None
    finally:
        await db.close()


async def set_user_setting(user_id: str, key: str, value: str):
    """Set a user setting (in settings table)."""
    db = await get_db(user_id)
    try:
        await db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value))
        await db.commit()
    finally:
        await db.close()
