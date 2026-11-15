/**
 * One short, structured answer from a model, through the user's own Claude
 * Code login (`claude -p`). No API key, no SDK (v4.11).
 *
 * Probed 2026-11-14 on Claude Code 2.1.325, one-line classification on Haiku:
 *
 *   call shape                                        wall    cost      context
 *   default `claude -p`                               7.8 s   $0.0094   ~45k tokens
 *   + --effort low                                    7.1 s   $0.0094   ~45k
 *   lean (below), reply parsed from text, 1 turn      4.0 s   $0.0012   ~5k
 *   lean + --json-schema (validated), 2 turns         4.2-5.1 $0.0012   ~5k
 *   --bare                                            refused: "Not logged in"
 *   MAX_THINKING_TOKENS=0                             no effect on output tokens
 *
 * So the lever is what the session loads, not the model's effort: a default
 * `-p` run carries the whole tool list, the system prompt, MCP servers and
 * skills for a question that uses none of them. The lean shape replaces the
 * system prompt, passes no tools, skips MCP and slash commands, and saves no
 * session. `--effort low` stays on (right direction, within noise here).
 * `--json-schema` costs one extra turn and guarantees the shape; the text
 * reply is still parsed as a fallback.
 */
import { spawnSync } from "node:child_process";

export const QUICK_TIMEOUT_MS = 45000;

export function quickArgs({ model = "haiku", system, prompt, schema = null, effort = "low" }) {
  const argv = ["-p"];
  if (model) argv.push("--model", model);
  if (effort) argv.push("--effort", effort);
  argv.push("--output-format", "json", "--max-turns", schema ? "3" : "1");
  if (schema) argv.push("--json-schema", JSON.stringify(schema));
  argv.push("--system-prompt", system, "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", prompt);
  return argv;
}

/**
 * @returns {{ ok: boolean, data?: object, latency_ms: number, cost_usd?: number|null, structured?: boolean, error?: string }}
 * Never throws.
 */
export function runQuick({ model = "haiku", system, prompt, schema = null, effort = "low", timeoutMs = QUICK_TIMEOUT_MS, exec = spawnSync }) {
  const t0 = Date.now();
  let r;
  // SHIPYARD_CLAUDE_BIN: a wrapper or a second install (e.g. a work profile's launcher); also how tests stub the model.
  try { r = exec(process.env.SHIPYARD_CLAUDE_BIN || "claude", quickArgs({ model, system, prompt, schema, effort }), { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { r = { error: e }; }
  const latency = Date.now() - t0;
  let outer = null;
  try { outer = r && typeof r.stdout === "string" && r.stdout ? JSON.parse(r.stdout) : null; } catch { outer = null; }
  if (!r || r.error || r.status !== 0 || outer?.is_error) {
    const why = r?.error?.message || (outer?.is_error ? String(outer.result ?? "").slice(0, 160) : "") || (r?.stderr || "").trim().split("\n").pop() || `exit ${r?.status}`;
    return { ok: false, latency_ms: latency, error: why };
  }
  if (!outer) return { ok: false, latency_ms: latency, error: "non-JSON output from claude -p" };
  const cost = outer.total_cost_usd ?? null;
  if (outer.structured_output && typeof outer.structured_output === "object") return { ok: true, data: outer.structured_output, structured: true, latency_ms: latency, cost_usd: cost };
  const m = typeof outer.result === "string" ? outer.result.match(/\{[\s\S]*\}/) : null;
  let inner = null;
  try { inner = m ? JSON.parse(m[0]) : null; } catch { inner = null; }
  if (!inner || typeof inner !== "object") return { ok: false, latency_ms: latency, cost_usd: cost, error: "no JSON object in the reply" };
  return { ok: true, data: inner, structured: false, latency_ms: latency, cost_usd: cost };
}
