"""Input validation utilities for node operations."""
import re
from typing import Optional
from .errors import DomainError


# Validation constants
MAX_NAME_LENGTH = 50 * 1024  # 50KB
MAX_ICON_LENGTH = 100
MAX_COLOR_LENGTH = 50

# Regex patterns
CONTROL_CHAR_PATTERN = re.compile(r'[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]')  # Exclude \n (\x0A) and \r (\x0D)
VALID_COLOR_PATTERN = re.compile(r'^#[0-9A-Fa-f]{6}$|^rgb\(|^rgba\(|^hsl\(|^hsla\(|^[a-z]+$')


class ValidationError(DomainError):
    """Raised when input validation fails."""
    
    def __init__(self, message: str):
        super().__init__(message=message, code="VALIDATION_ERROR")


def validate_node_name(name: str) -> None:
    """Validate node name/content.
    
    Args:
        name: The node name/content to validate
        
    Raises:
        ValidationError: If validation fails
    """
    if name is None:
        return  # Empty names are allowed
    
    if len(name) > MAX_NAME_LENGTH:
        raise ValidationError(
            f"Node name is too long (max {MAX_NAME_LENGTH} characters, got {len(name)})"
        )
    
    # Check for null bytes and other dangerous control characters
    # Allow newlines (\n) and carriage returns (\r) for multiline content
    if CONTROL_CHAR_PATTERN.search(name):
        raise ValidationError(
            "Node name contains invalid control characters"
        )


def validate_icon(icon: Optional[str]) -> None:
    """Validate icon string.
    
    Args:
        icon: The icon string to validate (emoji or icon identifier)
        
    Raises:
        ValidationError: If validation fails
    """
    if icon is None:
        return
    
    if len(icon) > MAX_ICON_LENGTH:
        raise ValidationError(
            f"Icon string exceeds maximum length of {MAX_ICON_LENGTH} characters "
            f"(got {len(icon)} characters)"
        )
    
    # Check for control characters
    if CONTROL_CHAR_PATTERN.search(icon):
        raise ValidationError(
            "Icon string contains invalid control characters"
        )


def validate_color(color: Optional[str]) -> None:
    """Validate color string.
    
    Args:
        color: The color string to validate (hex, rgb, rgba, hsl, hsla, or named color)
        
    Raises:
        ValidationError: If validation fails
    """
    if color is None:
        return
    
    if len(color) > MAX_COLOR_LENGTH:
        raise ValidationError(
            f"Color string exceeds maximum length of {MAX_COLOR_LENGTH} characters "
            f"(got {len(color)} characters)"
        )
    
    # Basic color format validation
    if not VALID_COLOR_PATTERN.match(color.lower()):
        raise ValidationError(
            f"Invalid color format: {color}. "
            "Expected hex (#RRGGBB), rgb(), rgba(), hsl(), hsla(), or named color"
        )


def validate_node_create(name: str, icon: Optional[str] = None, color: Optional[str] = None) -> None:
    """Validate all fields for node creation.
    
    Args:
        name: Node name/content
        icon: Optional icon string
        color: Optional color string
        
    Raises:
        ValidationError: If any field validation fails
    """
    validate_node_name(name)
    validate_icon(icon)
    validate_color(color)


def validate_node_update(name: Optional[str] = None, icon: Optional[str] = None, color: Optional[str] = None) -> None:
    """Validate all fields for node update.
    
    Args:
        name: Optional node name/content
        icon: Optional icon string  
        color: Optional color string
        
    Raises:
        ValidationError: If any field validation fails
    """
    if name is not None:
        validate_node_name(name)
    if icon is not None:
        validate_icon(icon)
    if color is not None:
        validate_color(color)
