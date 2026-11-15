"""F006 AC-6: eval-run's check_skill_dir_hygiene names empty / SKILL.md-less skill dirs."""

import importlib.util
import tempfile
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent


def _load():
    spec = importlib.util.spec_from_file_location("eval_run", TESTS_DIR / "eval-run.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _run(skills_dir):
    mod = _load()
    result = mod.Result()
    mod.check_skill_dir_hygiene(result, skills_dir=skills_dir)
    return result


def test_flags_empty_dir_and_missing_skill_md_naming_each():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "good").mkdir()
        (root / "good" / "SKILL.md").write_text("---\nname: good\n---\n")
        (root / "good" / "references").mkdir()
        (root / "good" / "references" / "a.md").write_text("x")
        (root / "empty-skill").mkdir()
        (root / "no-skill-md").mkdir()
        (root / "no-skill-md" / "notes.md").write_text("x")
        result = _run(root)
        detail = " ".join(f"{c} {d}" for c, d in result.failed)
        assert "empty-skill" in detail
        assert "no-skill-md" in detail
        assert "good" not in detail.replace("no-skill-md", "")


def test_flags_empty_subdir_inside_valid_skill():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "s").mkdir()
        (root / "s" / "SKILL.md").write_text("x")
        (root / "s" / "references").mkdir()
        result = _run(root)
        assert any("references" in f"{c} {d}" for c, d in result.failed)


def test_clean_tree_passes():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "s").mkdir()
        (root / "s" / "SKILL.md").write_text("x")
        assert not _run(root).failed


def test_real_skills_tree_is_clean():
    mod = _load()
    assert not _run(mod.SKILLS_DIR).failed
