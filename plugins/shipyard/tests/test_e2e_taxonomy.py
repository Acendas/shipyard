#!/usr/bin/env python3
"""Tests for the E2E acceptance criteria taxonomy reference file.

The taxonomy at skills/discovering-edge-cases/references/e2e-taxonomy.md is
consumed by the `validating-e2e-coverage` capability skill to map feature
touch surfaces to mandatory acceptance-criteria categories. These tests pin
the structural invariants the skill relies on:

  1. File exists and is non-empty.
  2. Touch Surface Detection Table exists with >= 10 pattern rows.
  3. Categories section exists with exactly 18 categories.
  4. Every category has the required structure (heading, verification_type,
     at least one type subsection, at least one GWT example).
  5. No duplicate category slugs.
  6. Touch surface table references only valid category slugs.
  7. Every GWT example has all three Given/When/Then parts.
"""

import os
import re

import pytest

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_ROOT = os.path.dirname(TESTS_DIR)
TAXONOMY_PATH = os.path.join(
    PLUGIN_ROOT,
    "skills",
    "discovering-edge-cases",
    "references",
    "e2e-taxonomy.md",
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def taxonomy_text():
    """Read the taxonomy file once for the entire module."""
    with open(TAXONOMY_PATH, "r", encoding="utf-8") as f:
        return f.read()


@pytest.fixture(scope="module")
def taxonomy_lines(taxonomy_text):
    """Split into lines for line-oriented parsing."""
    return taxonomy_text.splitlines()


@pytest.fixture(scope="module")
def category_headings(taxonomy_lines):
    """Extract all category heading lines (### N. slug-name (...))."""
    pat = re.compile(r"^### (\d+)\.\s+(\S+)\s+\((.+)\)\s*$")
    results = []
    for line in taxonomy_lines:
        m = pat.match(line)
        if m:
            results.append(
                {
                    "number": int(m.group(1)),
                    "slug": m.group(2),
                    "display_name": m.group(3),
                    "line": line,
                }
            )
    return results


@pytest.fixture(scope="module")
def category_sections(taxonomy_text):
    """Split the text into per-category sections keyed by slug.

    Each section spans from the category heading to the next category heading
    (or end of file).
    """
    pat = re.compile(
        r"^### (\d+)\.\s+(\S+)\s+\(.+\)\s*$", re.MULTILINE
    )
    matches = list(pat.finditer(taxonomy_text))
    sections = {}
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(taxonomy_text)
        slug = m.group(2)
        sections[slug] = taxonomy_text[start:end]
    return sections


# ---------------------------------------------------------------------------
# 1. File exists and is non-empty
# ---------------------------------------------------------------------------


def test_file_exists():
    assert os.path.isfile(TAXONOMY_PATH), f"Taxonomy file missing at {TAXONOMY_PATH}"


def test_file_non_empty():
    size = os.path.getsize(TAXONOMY_PATH)
    assert size > 0, "Taxonomy file is empty"


# ---------------------------------------------------------------------------
# 2. Touch Surface Detection Table exists with >= 10 rows
# ---------------------------------------------------------------------------


def test_touch_surface_table_section_exists(taxonomy_text):
    assert "## Touch Surface Detection Table" in taxonomy_text


def test_touch_surface_table_has_at_least_10_rows(taxonomy_lines):
    """Count data rows in the detection table (lines starting with | that are
    not the header or separator rows)."""
    in_table = False
    header_seen = False
    separator_seen = False
    data_rows = 0

    for line in taxonomy_lines:
        stripped = line.strip()
        if stripped == "## Touch Surface Detection Table":
            in_table = True
            continue
        if in_table and stripped.startswith("## "):
            # We've hit the next section — stop.
            break
        if in_table and stripped.startswith("|"):
            if not header_seen:
                header_seen = True
                continue
            if not separator_seen:
                separator_seen = True
                continue
            data_rows += 1

    assert data_rows >= 10, (
        f"Touch Surface Detection Table has {data_rows} data rows, expected >= 10"
    )


# ---------------------------------------------------------------------------
# 3. Categories section exists
# ---------------------------------------------------------------------------


def test_categories_section_exists(taxonomy_text):
    assert "## Categories" in taxonomy_text


# ---------------------------------------------------------------------------
# 4. Every category has required structure
# ---------------------------------------------------------------------------

VALID_VERIFICATION_TYPES = {"probe", "tool", "manual"}


def test_category_headings_format(category_headings):
    """Every category heading matches ### N. slug-name (Display Name)."""
    assert len(category_headings) > 0, "No category headings found"
    for ch in category_headings:
        assert 1 <= ch["number"] <= 18, (
            f"Category number {ch['number']} out of 1-18 range: {ch['line']}"
        )
        # Slug should be kebab-case lowercase.
        assert re.match(r"^[a-z][a-z0-9-]+$", ch["slug"]), (
            f"Slug is not kebab-case: {ch['slug']}"
        )


def test_category_has_verification_type(category_sections):
    """Each category section has **Default verification_type:** with a valid value."""
    pat = re.compile(r"\*\*Default verification_type:\*\*\s*(\S+)")
    for slug, body in category_sections.items():
        m = pat.search(body)
        assert m, f"Category '{slug}' missing **Default verification_type:**"
        vtype = m.group(1)
        assert vtype in VALID_VERIFICATION_TYPES, (
            f"Category '{slug}' has invalid verification_type '{vtype}'; "
            f"expected one of {VALID_VERIFICATION_TYPES}"
        )


def test_category_has_at_least_one_type_subsection(category_sections):
    """Each category has at least one type heading like **N.N ..."""
    pat = re.compile(r"^\*\*\d+\.\d+\s+", re.MULTILINE)
    for slug, body in category_sections.items():
        matches = pat.findall(body)
        assert len(matches) >= 1, (
            f"Category '{slug}' has no type subsection (expected **N.N ...)"
        )


def test_category_has_at_least_one_gwt_example(category_sections):
    """Each category has at least one GWT example in blockquote lines."""
    for slug, body in category_sections.items():
        blockquote_lines = [
            line for line in body.splitlines() if line.startswith("> ")
        ]
        has_given = any("Given" in l for l in blockquote_lines)
        has_when = any("When" in l for l in blockquote_lines)
        has_then = any("Then" in l for l in blockquote_lines)
        assert has_given and has_when and has_then, (
            f"Category '{slug}' missing GWT example "
            f"(Given={has_given}, When={has_when}, Then={has_then})"
        )


# ---------------------------------------------------------------------------
# 5. No duplicate category slugs
# ---------------------------------------------------------------------------


def test_no_duplicate_slugs(category_headings):
    slugs = [ch["slug"] for ch in category_headings]
    seen = set()
    duplicates = []
    for s in slugs:
        if s in seen:
            duplicates.append(s)
        seen.add(s)
    assert not duplicates, f"Duplicate category slugs: {duplicates}"


# ---------------------------------------------------------------------------
# 6. Category count is exactly 18
# ---------------------------------------------------------------------------


def test_category_count_is_18(category_headings):
    assert len(category_headings) == 18, (
        f"Expected 18 categories, found {len(category_headings)}: "
        f"{[ch['slug'] for ch in category_headings]}"
    )


# ---------------------------------------------------------------------------
# 7. Touch surface table references valid categories
# ---------------------------------------------------------------------------


def test_touch_surface_table_references_valid_categories(
    taxonomy_lines, category_headings
):
    """Every slug in the detection table's 'Activates Categories' column
    exists as a category heading."""
    valid_slugs = {ch["slug"] for ch in category_headings}

    in_table = False
    header_seen = False
    separator_seen = False
    invalid_refs = []

    for line in taxonomy_lines:
        stripped = line.strip()
        if stripped == "## Touch Surface Detection Table":
            in_table = True
            continue
        if in_table and stripped.startswith("## "):
            break
        if in_table and stripped.startswith("|"):
            if not header_seen:
                header_seen = True
                continue
            if not separator_seen:
                separator_seen = True
                continue
            # Data row — extract the last column (Activates Categories).
            # The first column may contain escaped pipes (\|) inside
            # backtick spans, so naive split("|") breaks. Instead, use
            # rfind to grab the last column between the final two |.
            last_pipe = stripped.rfind("|")
            second_last_pipe = stripped.rfind("|", 0, last_pipe)
            if second_last_pipe != -1:
                categories_col = stripped[second_last_pipe + 1 : last_pipe].strip()
                # Categories are comma-separated slugs.
                slugs_in_row = [
                    s.strip() for s in categories_col.split(",") if s.strip()
                ]
                for slug in slugs_in_row:
                    if slug not in valid_slugs:
                        invalid_refs.append(slug)

    assert not invalid_refs, (
        f"Touch surface table references unknown category slugs: "
        f"{sorted(set(invalid_refs))}"
    )


# ---------------------------------------------------------------------------
# 8. Every GWT example has all three parts (Given, When, Then)
# ---------------------------------------------------------------------------


def test_every_gwt_block_has_all_three_parts(category_sections):
    """Scan each category for contiguous blockquote blocks (separated by
    non-blockquote lines). Each block must contain Given, When, and Then."""
    incomplete = []

    for slug, body in category_sections.items():
        lines = body.splitlines()
        # Collect contiguous blockquote blocks.
        blocks = []
        current_block = []
        for line in lines:
            if line.startswith("> "):
                current_block.append(line)
            else:
                if current_block:
                    blocks.append(current_block)
                    current_block = []
        if current_block:
            blocks.append(current_block)

        for i, block in enumerate(blocks):
            text = " ".join(block)
            has_given = "Given" in text
            has_when = "When" in text
            has_then = "Then" in text
            if not (has_given and has_when and has_then):
                incomplete.append(
                    f"{slug} block {i + 1} "
                    f"(Given={has_given}, When={has_when}, Then={has_then})"
                )

    assert not incomplete, (
        f"GWT blocks missing parts:\n" + "\n".join(f"  - {x}" for x in incomplete)
    )
