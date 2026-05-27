"""Configuration management for Notees.

Centralizes all configuration settings with environment variable support.
"""

from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings with environment variable support."""

    # Security
    secret_key: str = ""  # Required - must be set via SECRET_KEY env var
    algorithm: str = "HS256"
    access_token_expire_hours: int = 24  # 1 day

    @field_validator("secret_key", mode="after")
    @classmethod
    def validate_secret_key(cls, v):
        """Ensure secret key is set and not the insecure default."""
        if not v or v == "notees-secret-key-change-in-production":
            raise ValueError(
                "SECRET_KEY environment variable must be set to a secure random value. "
                'Generate one with: python -c "import secrets; print(secrets.token_urlsafe(32))"'
            )
        if len(v) < 32:
            raise ValueError("SECRET_KEY must be at least 32 characters long")
        return v

    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    reload: bool = True

    # Database
    database_dir: Path = Path("data")

    # Backup
    backup_interval_seconds: int = 3600  # 1 hour
    max_backups: int = 50

    # Cleanup
    cleanup_interval_seconds: int = 86400  # 24 hours
    cleanup_workspace_max_age_days: int = 30  # 0 = disabled
    cleanup_user_max_age_days: int = 30  # 0 = disabled

    # Logging
    log_level: str = "INFO"
    log_file: str | None = None

    # CORS (if needed) - Must be explicitly configured
    cors_origins: list[str] | str = []  # Must be explicitly configured

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, v):
        """Parse CORS origins from string or list."""
        if isinstance(v, str):
            # Handle comma-separated values or single value
            if "," in v:
                return [origin.strip() for origin in v.split(",")]
            return [v.strip()]
        return v

    @field_validator("cors_origins", mode="after")
    @classmethod
    def warn_cors_wildcard(cls, v):
        """Warn if using wildcard CORS in production."""
        if "*" in v:
            import warnings

            warnings.warn(
                "CORS is configured with wildcard '*'. This is insecure for production. "
                "Set CORS_ORIGINS to specific allowed origins.",
                UserWarning,
            )
        return v

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", case_sensitive=False, extra="ignore")


# Global settings instance
settings = Settings()


# Ensure required directories exist
def ensure_directories():
    """Create required directories if they don't exist."""
    settings.database_dir.mkdir(parents=True, exist_ok=True)
    (settings.database_dir / "users").mkdir(exist_ok=True)
