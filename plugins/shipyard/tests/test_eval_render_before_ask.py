"""F016 AC-4/AC-5: eval-run's render-before-ask check targets the canonical CLI home."""

import importlib.util
import tempfile
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = TESTS_DIR.parent


def _load():
    spec = importlib.util.spec_from_file_location("eval_run", TESTS_DIR / "eval-run.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


CLI = (
    'const CANONICAL_STARTUP_RULES = [\n'
    '  "SHIPYARD_STARTUP_RULES:",\n'
    '  "Render before asking. Before every AskUserQuestion, render the decision context as assistant chat text first.",\n'
    '  "A dossier file does not count as rendered; Question strings display as a compact card.",\n'
    '  "Recovery: stop and render.",\n'
    '  "Paths: use the absolute prefix.",\n'
    '];\n'
)
SENTENCE = "Before every AskUserQuestion, render the decision context as assistant chat text first."


def _layout(root, skills, cli=CLI):
    (root / "bin").mkdir()
    (root / "bin" / "shipyard-context.mjs").write_text(cli)
    sd = root / "skills"
    for name, body in skills.items():
        (sd / name).mkdir(parents=True)
        (sd / name / "SKILL.md").write_text("---\nname: %s\n---\n%s\n" % (name, body))
    return sd


def _run(root, skills, cli=CLI, **kw):
    mod = _load()
    result = mod.Result()
    sd = _layout(root, skills, cli)
    mod.check_render_before_ask(result, skills_dir=sd, plugin_root=root, **kw)
    return result


def _detail(result):
    return " ".join(f"{c} {d}" for c, d in result.failed)


def test_plugin_target_resolves_relpath():
    mod = _load()
    text = mod.read_plugin_relpath("bin/shipyard-context.mjs")
    assert "CANONICAL_STARTUP_RULES" in text
    assert mod.read_plugin_relpath("bin/does-not-exist.mjs") == ""


def test_plugin_target_rejects_path_escape():
    mod = _load()
    assert mod.read_plugin_relpath("../../README.md") == ""
    assert mod.read_plugin_relpath("bin/../../../CLAUDE.md") == ""
    assert mod.read_plugin_relpath(str(PLUGIN_ROOT / "bin" / "shipyard-context.mjs")) == ""


def test_check_passes_on_canonical_layout():
    with tempfile.TemporaryDirectory() as tmp:
        r = _run(Path(tmp), {
            "a": "Render before asking. Use AskUserQuestion.",
            "b": "No questions here.",
        }, enforce_single_home=True)
        assert not r.failed, _detail(r)
        assert any("canonical" in str(c) for c in r.passed)


def test_check_fails_when_reminder_missing():
    with tempfile.TemporaryDirectory() as tmp:
        r = _run(Path(tmp), {"a": "Use AskUserQuestion with no reminder."})
        assert "render_before_ask:a:missing_reminder" in _detail(r)


def test_check_fails_when_canonical_clause_missing_from_cli():
    with tempfile.TemporaryDirectory() as tmp:
        r = _run(Path(tmp), {"a": "Render before asking. AskUserQuestion."}, cli="// no rules here\n")
        assert "render_before_ask:canonical" in _detail(r)


def test_single_home_switch_gates_duplicate_detection():
    skills = {"a": "Render before asking. AskUserQuestion. %s" % SENTENCE}
    with tempfile.TemporaryDirectory() as tmp:
        assert not _run(Path(tmp), skills, enforce_single_home=False).failed
    with tempfile.TemporaryDirectory() as tmp:
        r = _run(Path(tmp), skills, enforce_single_home=True)
        assert "render_before_ask:skills/a/SKILL.md:duplicated_canonical" in _detail(r)


def test_real_tree_passes_with_default_switch():
    mod = _load()
    result = mod.Result()
    mod.check_render_before_ask(result)
    assert not result.failed, _detail(result)
    assert len(result.passed) > 10


# --- single-home blind spots (a)-(d), reminder-not-flagged, partial parse ---

REMINDER = "Render before asking. Before any AskUserQuestion, render the decision context in chat first."
LONG_PARA = ("Render before asking. A dossier file does not count as rendered; "
             "the question strings display as a compact card.")


def _run_files(tmp, skills, extra=None, cli=CLI, **kw):
    """Like _run but also writes extra files (relpath -> text) under the plugin root."""
    mod = _load()
    root = Path(tmp)
    sd = _layout(root, skills, cli)
    for rel, text in (extra or {}).items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    result = mod.Result()
    mod.check_render_before_ask(result, skills_dir=sd, plugin_root=root, enforce_single_home=True, **kw)
    return result


def test_single_home_flags_reference_file_copy():  # (a)
    with tempfile.TemporaryDirectory() as tmp:
        r = _run_files(tmp, {"a": REMINDER + " AskUserQuestion"},
                       {"skills/a/references/x.md": "Intro.\n\n" + SENTENCE + "\n"})
        assert "skills/a/references/x.md:duplicated_canonical" in _detail(r)


def test_single_home_flags_skill_without_askuserquestion():  # (b)
    with tempfile.TemporaryDirectory() as tmp:
        r = _run_files(tmp, {"acquiring-skill-lock": "Locks things. " + SENTENCE})
        assert "acquiring-skill-lock/SKILL.md:duplicated_canonical" in _detail(r)


def test_single_home_flags_wrapped_and_decorated_copy():  # (c)
    wrapped = ("- **Before every** AskUserQuestion, render the\n"
               "  decision context as `assistant chat text`\n"
               "  first.\n")
    with tempfile.TemporaryDirectory() as tmp:
        r = _run_files(tmp, {"a": "Render before asking. AskUserQuestion.\n\n" + wrapped})
        assert "skills/a/SKILL.md:duplicated_canonical" in _detail(r)
    dash_cli = CLI.replace('"Recovery: stop and render."',
                           '"Recovery: if the user says \\"show me\\", stop \u2014 render the full content as chat text first."')
    curly = "Recovery: if the user says \u201cshow me\u201d, stop - render the full content as chat text first."
    with tempfile.TemporaryDirectory() as tmp:
        r = _run_files(tmp, {"a": "x"}, {"agents/ag.md": curly}, cli=dash_cli)
        assert "agents/ag.md:duplicated_canonical" in _detail(r)


def test_single_home_flags_paraphrased_long_copy():  # (d)
    with tempfile.TemporaryDirectory() as tmp:
        r = _run_files(tmp, {"a": "AskUserQuestion.\n\n" + LONG_PARA.replace("; ", ";\n")})
        assert "skills/a/SKILL.md:duplicated_canonical" in _detail(r)
    paths = ("**Paths.** Use the absolute SHIPYARD_DATA prefix. No `$HOME` or shell\nvariables in file_path.")
    with tempfile.TemporaryDirectory() as tmp:
        r = _run_files(tmp, {"a": "x"}, {"skills/a/references/p.md": paths})
        assert "p.md:duplicated_canonical" not in _detail(r)  # one signature only
    cli = CLI.replace('"Paths: use the absolute prefix."',
                      '"Paths: use the absolute SHIPYARD_DATA prefix; no shell variables; no shell redirects."')
    with tempfile.TemporaryDirectory() as tmp:
        r = _run_files(tmp, {"a": "x"},
                       {"skills/a/references/p.md": "Use the absolute SHIPYARD_DATA prefix, never shell redirects."},
                       cli=cli)
        assert "p.md:duplicated_canonical" in _detail(r)


def test_single_home_does_not_flag_short_reminder():
    with tempfile.TemporaryDirectory() as tmp:
        r = _run_files(tmp, {"a": REMINDER + " AskUserQuestion. A dossier does not count as rendered."},
                       {"agents/ag.md": REMINDER + "\n"})
        assert not r.failed, _detail(r)


def test_switch_is_on_and_real_tree_is_clean_with_switch_on():
    mod = _load()
    assert mod.ENFORCE_SINGLE_HOME is True
    result = mod.Result()
    mod.check_render_before_ask(result, enforce_single_home=True)
    assert not result.failed, _detail(result)


def test_readded_long_copy_fails_with_switch_on():
    with tempfile.TemporaryDirectory() as tmp:
        r = _run_files(tmp, {"a": REMINDER + " AskUserQuestion. " + LONG_PARA + " " + SENTENCE})
        assert "skills/a/SKILL.md:duplicated_canonical" in _detail(r)


def _parse(entries):
    mod = _load()
    cli = "const CANONICAL_STARTUP_RULES = [\n" + "\n".join(entries) + "\n];\n"
    return mod, cli, mod.canonical_startup_parse(cli)


def test_parse_accounts_for_single_quote_and_plus_entries():
    mod, cli, (clauses, errors) = _parse([
        '  "double one",',
        "  'single \\'quoted\\' one',",
        '  "split " + "across" +\n    " lines",',
        "  `template one`,",
    ])
    assert not errors
    assert clauses == ["double one", "single 'quoted' one", "split across lines", "template one"]


def test_unparseable_entry_is_a_fail_not_a_silent_drop():
    mod, cli, (clauses, errors) = _parse(['  "ok",', "  someIdentifier,", '  "after",'])
    assert errors and errors[0][0] == 1 and "someIdentifier" in errors[0][1]
    with tempfile.TemporaryDirectory() as tmp:
        r = _run(Path(tmp), {"a": "Render before asking. AskUserQuestion."}, cli=cli)
        assert "render_before_ask:canonical:entry_1_unparsed" in _detail(r)
    mod, cli, (clauses, errors) = _parse(['  `has ${interp}`,'])
    assert errors


def test_every_signature_phrase_is_in_the_real_cli_rules():
    # The single-home gate silently drops a signature phrase the CLI no longer
    # carries; pin that the terse canonical wording keeps all of them.
    mod = _load()
    clauses = mod.canonical_startup_clauses((PLUGIN_ROOT / "bin" / "shipyard-context.mjs").read_text())
    flat = mod._flat(" ".join(clauses)).lower()
    missing = [s for s in mod.SIGNATURE_PHRASES if s.lower() not in flat]
    assert not missing, missing
