"""Configuration management for Notees.

Centralizes all configuration settings with environment variable support.
"""

import urllib.parse
from pathlib import Path

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings with environment variable support."""

    # Security
    secret_key: str = ""  # Required - must be set via SECRET_KEY env var
    algorithm: str = "HS256"
    access_token_expire_hours: float = 0.25  # 15 minutes
    refresh_token_expire_days: int = 7  # 7 days
    refresh_token_remember_me_days: int = 90  # 90 days for "keep me signed in"
    registration_enabled: bool = False  # Disabled by default; set REGISTRATION_ENABLED=true to allow open registration
    admin_password: str | None = None  # Initial admin password; if unset, first registration is rejected

    @field_validator("algorithm", mode="after")
    @classmethod
    def validate_algorithm(cls, v):
        """Reject insecure or unsupported JWT algorithms."""
        allowed = {"HS256", "HS384", "HS512"}
        normalized = v.upper()
        if normalized == "NONE":
            raise ValueError('JWT algorithm "none" is not allowed')
        if normalized not in allowed:
            raise ValueError(f"JWT algorithm must be one of {allowed}, got {v}")
        return normalized

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
    environment: str = "development"
    reload: bool = True

    @field_validator("reload", mode="before")
    @classmethod
    def derive_reload_from_environment(cls, v, info):
        """Default reload to False in production when not explicitly set."""
        if v is not None:
            return v
        env = (info.data.get("environment") or "").lower()
        return env != "production"

    # Database
    database_dir: Path = Path("data")
    database_url: str = ""
    postgres_user: str = "notees"
    postgres_password: str | None = None
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_db: str = "notees"
    postgres_pool_min: int = 5
    postgres_pool_max: int = 50
    postgres_pool_max_inactive_time: float = 300
    postgres_statement_cache_size: int = 100

    # Backup
    backup_interval_seconds: int = 3600  # 1 hour
    max_backups: int = 50

    # Cleanup
    cleanup_interval_seconds: int = 86400  # 24 hours
    cleanup_workspace_max_age_days: int = 30  # 0 = disabled
    cleanup_user_max_age_days: int = 30  # 0 = disabled

    # Retention (workspace settings override these defaults)
    default_trash_retention_days: int = 30  # 0 = never auto-delete
    activity_log_retention_enabled: bool = True
    activity_log_retention_days: int = 90
    task_completion_retention_enabled: bool = True
    task_completion_retention_days: int = 365

    # Logging
    log_level: str = "INFO"
    log_file: str | None = None

    # Redis (for real-time collaboration pub/sub)
    redis_url: str = "redis://localhost:6379/0"

    # CORS (if needed) - Must be explicitly configured
    cors_origins: list[str] | str = []  # Must be explicitly configured

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, v):
        """Parse CORS origins from string or list; drop empty entries."""
        if isinstance(v, str):
            # Handle comma-separated values or single value
            if "," in v:
                return [origin.strip() for origin in v.split(",") if origin.strip()]
            stripped = v.strip()
            return [stripped] if stripped else []
        if isinstance(v, list):
            return [origin.strip() for origin in v if origin and origin.strip()]
        return v

    @field_validator("cors_origins", mode="after")
    @classmethod
    def reject_insecure_cors_wildcard(cls, v, info):
        """Reject wildcard CORS when credentials are enabled in any environment."""
        if "*" in v:
            raise ValueError(
                "CORS_ORIGINS='*' is not allowed when allow_credentials=True. "
                "Set CORS_ORIGINS to specific allowed origins."
            )
        return v

    # Email / SMTP (optional — invitations work without SMTP by returning links)
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: str | None = None
    smtp_tls: bool = True
    smtp_from: str | None = None
    public_url: str = "http://localhost:8000"

    @field_validator("public_url", mode="after")
    @classmethod
    def strip_trailing_slash(cls, v: str) -> str:
        return v.rstrip("/")

    @model_validator(mode="after")
    def derive_database_url(self):
        """Build DATABASE_URL from PostgreSQL components when not provided directly."""
        if self.database_url:
            return self
        password = urllib.parse.quote(self.postgres_password or "", safe="")
        self.database_url = (
            f"postgresql://{self.postgres_user}:{password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )
        return self

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", case_sensitive=False, extra="ignore")


# Global settings instance
settings = Settings()


# Ensure required directories exist
def ensure_directories():
    """Create required directories if they don't exist."""
    settings.database_dir.mkdir(parents=True, exist_ok=True)
    (settings.database_dir / "users").mkdir(exist_ok=True)
