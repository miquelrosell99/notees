"""Unit tests for the pattern-driven citekey generator."""

from __future__ import annotations

import pytest

from app.domain.services.citekey import (
    DEFAULT_CITEKEY_PATTERN,
    extract_year,
    first_title_word,
    generate_citekey,
    render_citekey_pattern,
    resolve_citekey_collision,
)

pytestmark = pytest.mark.unit


class TestRenderCitekeyPattern:
    def test_default_pattern_family_and_year(self) -> None:
        result = render_citekey_pattern(
            DEFAULT_CITEKEY_PATTERN,
            family_name="Herbert",
            year="1965",
            title="Dune",
        )
        assert result == "herbert1965"

    def test_upper_modifier(self) -> None:
        result = render_citekey_pattern(
            "{family_name:upper}{year}",
            family_name="Herbert",
            year="1965",
        )
        assert result == "HERBERT1965"

    def test_no_modifier_keeps_case(self) -> None:
        result = render_citekey_pattern("{family_name}", family_name="Herbert")
        assert result == "Herbert"

    def test_organization_name_token(self) -> None:
        result = render_citekey_pattern(
            "{organization_name:lower}{year}",
            organization_name="Penguin Books",
            year="2001",
        )
        assert result == "penguinbooks2001"

    def test_title_word_token_skips_stop_words(self) -> None:
        result = render_citekey_pattern("{title_word:lower}", title="The Dune Encyclopedia")
        assert result == "dune"

    def test_unresolved_token_falls_back_to_title_word(self) -> None:
        """No family name → title-derived value instead of an empty key."""
        result = render_citekey_pattern("{family_name:lower}{year}", year="1965", title="Dune")
        assert result == "dune1965"

    def test_unknown_token_falls_back_to_title_word(self) -> None:
        result = render_citekey_pattern("{unknown_token:lower}", title="Dune")
        assert result == "dune"

    def test_unresolvable_pattern_falls_back_to_untitled(self) -> None:
        result = render_citekey_pattern("{family_name:lower}{year}")
        assert result == "untitled"

    def test_literal_text_is_preserved(self) -> None:
        result = render_citekey_pattern("{family_name:lower}_{year}", family_name="Herbert", year="1965")
        assert result == "herbert_1965"


class TestHelpers:
    def test_first_title_word(self) -> None:
        assert first_title_word("The Dune Encyclopedia") == "Dune"
        assert first_title_word("Dune") == "Dune"
        assert first_title_word("") is None
        assert first_title_word(None) is None
        assert first_title_word("the and of") is None

    def test_extract_year(self) -> None:
        assert extract_year("1965") == "1965"
        assert extract_year("August 1965") == "1965"
        assert extract_year("1965-08-01") == "1965"
        assert extract_year("no date") is None
        assert extract_year(None) is None


class TestCollisionResolution:
    def test_no_collision_returns_base(self) -> None:
        assert resolve_citekey_collision("herbert1965", set()) == "herbert1965"

    def test_letter_suffixes(self) -> None:
        existing = {"herbert1965"}
        assert resolve_citekey_collision("herbert1965", existing) == "herbert1965a"
        existing.add("herbert1965a")
        assert resolve_citekey_collision("herbert1965", existing) == "herbert1965b"

    def test_suffixes_past_z(self) -> None:
        existing = {"key"} | {f"key{chr(ord('a') + i)}" for i in range(26)}
        assert resolve_citekey_collision("key", existing) == "keyaa"

    def test_deterministic(self) -> None:
        existing = {"herbert1965", "herbert1965a"}
        first = resolve_citekey_collision("herbert1965", existing)
        second = resolve_citekey_collision("herbert1965", existing)
        assert first == second == "herbert1965b"


class TestGenerateCitekey:
    def test_full_pipeline(self) -> None:
        key = generate_citekey(
            creators=[{"given_name": "Frank", "family_name": "Herbert"}],
            publication_date="August 1965",
            title="Dune",
        )
        assert key == "herbert1965"

    def test_collision_resolution_integrated(self) -> None:
        creators = [{"given_name": "Frank", "family_name": "Herbert"}]
        first = generate_citekey(creators=creators, publication_date="1965", title="Dune")
        second = generate_citekey(
            creators=creators,
            publication_date="1965",
            title="Dune Messiah",
            existing={first},
        )
        assert first == "herbert1965"
        assert second == "herbert1965a"

    def test_organization_creators(self) -> None:
        key = generate_citekey(
            "{organization_name:lower}{year}",
            creators=[{"organization_name": "Penguin Books"}],
            publication_date="2001",
            title="Some Anthology",
        )
        assert key == "penguinbooks2001"

    def test_pattern_change_affects_only_new_keys(self) -> None:
        """An existing key is untouched; a new generation uses the new pattern."""
        creators = [{"given_name": "Frank", "family_name": "Herbert"}]
        old_key = generate_citekey(creators=creators, publication_date="1965", title="Dune")
        new_key = generate_citekey(
            "{title_word:lower}{year}",
            creators=creators,
            publication_date="1965",
            title="Dune",
            existing={old_key},
        )
        assert old_key == "herbert1965"
        assert new_key == "dune1965"

    def test_empty_pattern_uses_default(self) -> None:
        key = generate_citekey(
            "  ",
            creators=[{"family_name": "Herbert"}],
            publication_date="1965",
        )
        assert key == "herbert1965"

    def test_no_metadata_yields_untitled_with_suffixes(self) -> None:
        first = generate_citekey()
        second = generate_citekey(existing={first})
        assert first == "untitled"
        assert second == "untitleda"
