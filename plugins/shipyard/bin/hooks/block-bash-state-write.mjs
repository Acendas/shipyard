/**
 * PreToolUse hook: block Bash echo/redirect writes to SHIPYARD_DATA.
 *
 * When Claude writes state files (`.active-session.json`, `.active-execution.json`,
 * `.active-logcap-session`, PROGRESS.md, task files, etc.) via Bash echo/printf/cat
 * redirect instead of the Write tool, the auto-approve hook cannot fire — the user
 * gets a permission prompt on every state write, stalling execution.
 *
 * This hook detects Bash commands that redirect output to paths inside SHIPYARD_DATA
 * and blocks them with a message telling Claude to use the Write tool instead.
 *
 * STDOUT CONTRACT: PreToolUse hooks that block return exit code 2. Messages go to
 * stderr. Stdout is unused (Claude Code bug #40262).
 */

import { resolveShipyardData, logEvent, sanitizeForLog } from "../_hook_lib.mjs";

// Patterns that indicate a write-to-file via shell redirect.
// Matches: echo "..." > file, echo "..." >> file, printf "..." > file,
// cat <<EOF > file, cat > file, etc.
const REDIRECT_RE = /(?:echo|printf|cat)\b.*?(?:>{1,2})\s*["']?([^\s"'|;]+)/;

// Also catch heredoc-to-file: cat <<'EOF' > file, cat << EOF > file
const HEREDOC_REDIRECT_RE = /cat\s+<<['"\\]?\w+['"\\]?\s*>{1,2}\s*["']?([^\s"'|;]+)/;

// Also catch simple redirect: > file (truncate and write)
const BARE_REDIRECT_RE = /^\s*>{1,2}\s*["']?([^\s"'|;]+)/;

// Catch tee writing to a file (tee writes to its argument, not via redirect):
// echo "content" | tee /path/to/file, tee -a /path/to/file
const TEE_RE = /\btee\s+(?:-[a-z]*\s+)*["']?([^\s"'|;]+)/;

function extractRedirectTarget(command) {
  for (const re of [REDIRECT_RE, HEREDOC_REDIRECT_RE, BARE_REDIRECT_RE, TEE_RE]) {
    const match = re.exec(command);
    if (match && match[1]) return match[1];
  }
  return null;
}

function pathLooksLikeShipyardData(target, dataDir) {
  if (!target) return false;

  // Check for SHIPYARD_DATA variable references — works even when the
  // resolver fails and dataDir is empty (the most common case for this
  // hook: Claude writes `echo ... > "$SHIPYARD_DATA/..."`)
  if (target.includes("SHIPYARD_DATA") || target.includes("shipyard-data")) return true;

  // Check for known state file names that are always in the data dir
  const stateFiles = [
    ".active-session.json",
    ".active-execution.json",
    ".active-logcap-session",
    ".active-agents.json",
  ];
  for (const sf of stateFiles) {
    if (target.includes(sf)) return true;
  }

  // If we have a resolved data dir, check if the target path starts with it.
  // NOTE: this is string-level pattern matching on the command text, NOT
  // filesystem containment — CLAUDE.md's startsWith prohibition applies to
  // resolved filesystem paths with symlink TOCTOU risk, not command strings.
  if (dataDir) {
    const cleaned = target.replace(/^["']|["']$/g, "").replace(/\$\{?SHIPYARD_DATA\}?/g, dataDir);
    if (cleaned.startsWith(dataDir)) return true;
  }

  return false;
}

export async function run(hookInput, _env) {
  const toolName = hookInput?.tool_name || "";
  if (toolName !== "Bash") return 0;

  const command = hookInput?.tool_input?.command || String(hookInput?.tool_input || "");
  if (!command) return 0;

  const target = extractRedirectTarget(command);
  if (!target) return 0;

  const dataDir = await resolveShipyardData();

  if (pathLooksLikeShipyardData(target, dataDir)) {
    logEvent(dataDir, "bash_state_write_blocked", {
      target: sanitizeForLog(target, 120),
      command: sanitizeForLog(command, 200),
    });

    process.stderr.write(
      "❌ BLOCKED: Do not use Bash echo/redirect to write Shipyard state files.\n" +
      "\n" +
      `  Blocked command target: ${sanitizeForLog(target, 120)}\n` +
      "\n" +
      "  Use the Write tool instead — it is auto-approved for Shipyard data files\n" +
      "  and does not trigger permission prompts.\n" +
      "\n" +
      "  Example: Write({ file_path: \"<SHIPYARD_DATA>/...\", content: \"...\" })\n",
    );
    return 2;
  }

  return 0;
}
