"""F016 AC-5: the onboarding gate's single home is SHIPYARD_ONBOARDING_INSTRUCTION
(bin/init-data.mjs); a restated gate paragraph in a skill fails the single-home check."""

import importlib.util
import tempfile

import pytest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = TESTS_DIR.parent

CLI = (
    'const CANONICAL_STARTUP_RULES = [\n'
    '  "SHIPYARD_STARTUP_RULES:",\n'
    '  "Render before asking. Before every AskUserQuestion, render the decision context as assistant chat text first.",\n'
    '  "A dossier file does not count as rendered; Question strings display as a compact card.",\n'
    '  "Recovery: stop and render.",\n'
    '  "Paths: use the absolute prefix.",\n'
    '];\n'
)
OLD_GATE = (
    "**Onboarding gate.** If the bundled context contains `SHIPYARD_ONBOARDING_REQUIRED=true`, "
    "run the exact `SHIPYARD_ONBOARDING_COMMAND` once with Bash, report the CLI output to the user, "
    "and STOP. Do not infer setup state by reading or writing Shipyard state files; onboarding "
    "decisions are CLI-owned."
)
POINTER = ("**Render before asking.** Follow the startup SHIPYARD_STARTUP_RULES and "
           "SHIPYARD_ONBOARDING_INSTRUCTION. AskUserQuestion.")


def _load():
    spec = importlib.util.spec_from_file_location("eval_run", TESTS_DIR / "eval-run.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _run(tmp, body, extra=None):
    mod = _load()
    root = Path(tmp)
    (root / "bin").mkdir()
    (root / "bin" / "shipyard-context.mjs").write_text(CLI)
    (root / "bin" / "init-data.mjs").write_text(
        (PLUGIN_ROOT / "bin" / "init-data.mjs").read_text())
    sd = root / "skills"
    (sd / "scratch").mkdir(parents=True)
    (sd / "scratch" / "SKILL.md").write_text("---\nname: scratch\n---\n%s\n" % body)
    for rel, text in (extra or {}).items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    result = mod.Result()
    mod.check_render_before_ask(result, skills_dir=sd, plugin_root=root, enforce_single_home=True)
    return result


def _detail(result):
    return " ".join(f"{c} {d}" for c, d in result.failed)


def test_instruction_parsed_from_real_init_data():
    mod = _load()
    text = mod.onboarding_instruction_parse((PLUGIN_ROOT / "bin" / "init-data.mjs").read_text())
    assert text and text.startswith("SHIPYARD_ONBOARDING_INSTRUCTION: Run the exact SHIPYARD_ONBOARDING_COMMAND")
    assert "CONTINUE the skill in this same turn" in text


def test_readded_old_gate_paragraph_fails():
    with tempfile.TemporaryDirectory() as tmp:
        r = _run(tmp, POINTER + "\n\n" + OLD_GATE)
        assert "skills/scratch/SKILL.md:duplicated_canonical" in _detail(r), _detail(r)
    # the paragraph rule alone catches it (not only the verbatim-sentence scan)
    hits = _load().find_onboarding_gate_copies(POINTER + "\n\n" + OLD_GATE)
    assert len(hits) == 1 and hits[0][0] == 3 and "onboarding gate" in hits[0][1], hits
    assert _load().find_onboarding_gate_copies(POINTER) == []


def test_gate_paragraph_in_reference_or_agent_fails():
    for rel in ("skills/scratch/references/x.md", "agents/ag.md"):
        with tempfile.TemporaryDirectory() as tmp:
            r = _run(tmp, POINTER, {rel: "Intro.\n\n" + OLD_GATE + "\n"})
            assert f"{rel}:duplicated_canonical" in _detail(r), (rel, _detail(r))


def test_paraphrased_gate_with_stop_fails():
    para = "When SHIPYARD_ONBOARDING_REQUIRED=true appears, run the onboarding command and STOP."
    with tempfile.TemporaryDirectory() as tmp:
        r = _run(tmp, POINTER + "\n\n" + para)
        assert "skills/scratch/SKILL.md:duplicated_canonical" in _detail(r)


@pytest.mark.parametrize("copy", [
    "If onboarding is required -> run the CLI command surfaced in `SHIPYARD_ONBOARDING_COMMAND`, report the CLI output, and stop.",
    "## Rules\n- Be concise\n- If onboarding is required, run the CLI command surfaced by context, report it, and stop\n- Keep it short",
])
def test_short_gate_restatement_fails(copy):
    # the two short copies ship-status and ship-help carried until F016's AC-2 fix
    with tempfile.TemporaryDirectory() as tmp:
        r = _run(tmp, POINTER + "\n\n" + copy)
        assert "skills/scratch/SKILL.md:duplicated_canonical" in _detail(r), _detail(r)


def test_onboarding_mentions_without_stop_pass():
    ok = ("**Shell.** Bash is for `shipyard-context` (reads) and the onboarding command surfaced by context.\n\n"
          "Onboarding is required on a fresh project; the startup CLI says so.")
    with tempfile.TemporaryDirectory() as tmp:
        r = _run(tmp, POINTER + "\n\n" + ok)
        assert not r.failed, _detail(r)


def test_verbatim_instruction_sentence_fails_without_required_literal():
    sentence = ("Run the exact SHIPYARD_ONBOARDING_COMMAND once with Bash (it writes only Shipyard's own "
                "config.md — do not ask first), say in one line what it set up, then re-run the shipyard-context "
                "command this skill's preamble ran and CONTINUE the skill in this same turn — never tell the user "
                "to re-type the command.")
    with tempfile.TemporaryDirectory() as tmp:
        r = _run(tmp, POINTER + "\n\n" + sentence)
        assert "skills/scratch/SKILL.md:duplicated_canonical" in _detail(r)


def test_pointer_line_passes():
    with tempfile.TemporaryDirectory() as tmp:
        r = _run(tmp, POINTER)
        assert not r.failed, _detail(r)
        assert "render_before_ask:onboarding:instruction_parsed" in [c for c, _ in r.passed]


def test_unparseable_instruction_fails():
    mod = _load()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "bin").mkdir()
        (root / "bin" / "shipyard-context.mjs").write_text(CLI)
        (root / "bin" / "init-data.mjs").write_text("// instruction removed\n")
        sd = root / "skills"
        sd.mkdir()
        result = mod.Result()
        mod.check_render_before_ask(result, skills_dir=sd, plugin_root=root, enforce_single_home=True)
        assert "render_before_ask:onboarding:parse" in _detail(result)


def test_real_tree_parses_instruction_and_is_clean():
    mod = _load()
    result = mod.Result()
    mod.check_render_before_ask(result, enforce_single_home=True)
    assert not result.failed, _detail(result)
    assert "render_before_ask:onboarding:instruction_parsed" in [c for c, _ in result.passed]
