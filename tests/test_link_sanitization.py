"""
Tests for link content sanitization functionality.

Verifies that editor artifacts like vscodecontentref are properly stripped
and that malformed link patterns are normalized to canonical format.
"""
import pytest

from app.domain.services.link_service import sanitize_content


class TestLinkSanitization:
    """Test link content sanitization against common editor artifacts."""
    
    def test_sanitize_vscodecontentref_artifacts(self):
        """Test removal of vscodecontentref artifacts from VS Code."""
        # Basic vscodecontentref pattern
        input_text = "Check [[[123]]](http://vscodecontentref/1) for details"
        expected = "Check [[123]] for details"
        assert sanitize_content(input_text) == expected
        
        # Multiple artifacts with different numbers
        input_text = "See [[[456]]](http://vscodecontentref/2) and [[[789]]](http://vscodecontentref/3)"
        expected = "See [[456]] and [[789]]"
        assert sanitize_content(input_text) == expected
    
    def test_sanitize_internal_urls(self):
        """Test normalization of internal:// URL patterns."""
        input_text = "Link to [Some Page](internal://123)"
        expected = "Link to [[123]]"
        assert sanitize_content(input_text) == expected
        
        # Empty display text
        input_text = "Link to [](internal://456)"
        expected = "Link to [[456]]"
        assert sanitize_content(input_text) == expected
    
    def test_sanitize_malformed_brackets(self):
        """Test fixing of malformed bracket patterns."""
        # Triple brackets without URL
        input_text = "Reference [[[123]]] in the document"
        expected = "Reference [[123]] in the document"
        assert sanitize_content(input_text) == expected
        
        # Incomplete bracket normalization
        input_text = "See [[[456]] for more info"
        expected = "See [[456]] for more info"
        assert sanitize_content(input_text) == expected
    
    def test_preserve_valid_links(self):
        """Test that valid [[nodeId]] patterns are preserved."""
        # Basic valid link
        input_text = "Valid link [[123]] remains unchanged"
        expected = "Valid link [[123]] remains unchanged"
        assert sanitize_content(input_text) == expected
        
        # Link with UUID
        input_text = "Tracked link [[456:a1b2c3d4-e5f6-7890-abcd-ef1234567890]] preserved"
        expected = "Tracked link [[456:a1b2c3d4-e5f6-7890-abcd-ef1234567890]] preserved"
        assert sanitize_content(input_text) == expected
    
    def test_preserve_inline_types(self):
        """Test that {{typeId}} patterns are not affected by link sanitization."""
        input_text = "Type reference {{123}} should remain intact"
        expected = "Type reference {{123}} should remain intact"
        assert sanitize_content(input_text) == expected
    
    def test_mixed_content_sanitization(self):
        """Test sanitization of content with multiple pattern types."""
        input_text = ("Mixed content with [[[123]]](http://vscodecontentref/1), "
                      "valid [[456]], broken [[[789]]], internal [text](internal://101), "
                      "and type {{202}}")
        expected = ("Mixed content with [[123]], "
                    "valid [[456]], broken [[789]], internal [[101]], "
                    "and type {{202}}")
        assert sanitize_content(input_text) == expected
    
    def test_empty_and_none_content(self):
        """Test handling of empty/None content."""
        assert sanitize_content("") == ""
        assert sanitize_content(None) is None
        assert sanitize_content("   ") == "   "  # Whitespace preserved
    
    def test_no_changes_needed(self):
        """Test that clean content passes through unchanged."""
        clean_content = "This is clean content with no artifacts."
        assert sanitize_content(clean_content) == clean_content
        
        clean_with_links = "Clean content with [[123]] and {{456}} references."
        assert sanitize_content(clean_with_links) == clean_with_links
    
    def test_complex_real_world_scenarios(self):
        """Test complex scenarios that might occur in real usage."""
        # Copy-paste scenario from VS Code
        input_text = ("Meeting notes: [[[project-update]]](http://vscodecontentref/1) "
                      "and follow-up with [[[team-lead]]](http://vscodecontentref/2). "
                      "Also see [Planning Doc](internal://789) for {{meeting-type}} details.")
        expected = ("Meeting notes: [[project-update]] "
                    "and follow-up with [[team-lead]]. "
                    "Also see [[789]] for {{meeting-type}} details.")
        assert sanitize_content(input_text) == expected
        
        # Mixed malformed patterns
        input_text = "References: [[[123]]], [[[456]], [[789]], [text](internal://101)"
        expected = "References: [[123]], [[456]], [[789]], [[101]]"
        assert sanitize_content(input_text) == expected