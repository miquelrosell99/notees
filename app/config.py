"""Configuration management for Notees.

Centralizes all configuration settings with environment variable support.
"""
import os
from pathlib import Path
from typing import Optional, Union
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings with environment variable support."""
    
    # Security
    secret_key: str = "notees-secret-key-change-in-production"
    algorithm: str = "HS256"
    access_token_expire_hours: int = 24 * 7  # 1 week
    
    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    reload: bool = True
    
    # Database
    database_dir: Path = Path("data")
    
    # Backup
    backup_interval_seconds: int = 3600  # 1 hour
    max_backups: int = 50
    
    # Logging
    log_level: str = "INFO"
    log_file: Optional[str] = None
    
    # CORS (if needed)
    cors_origins: Union[list[str], str] = ["*"]
    
    @field_validator('cors_origins', mode='before')
    @classmethod
    def parse_cors_origins(cls, v):
        """Parse CORS origins from string or list."""
        if isinstance(v, str):
            # Handle comma-separated values or single value
            if ',' in v:
                return [origin.strip() for origin in v.split(',')]
            return [v.strip()]
        return v
    
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore"
    )


# Global settings instance
settings = Settings()


# Ensure required directories exist
def ensure_directories():
    """Create required directories if they don't exist."""
    settings.database_dir.mkdir(parents=True, exist_ok=True)
    (settings.database_dir / "users").mkdir(exist_ok=True)


ensure_directories()
