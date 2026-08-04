#!/usr/bin/env node
/**
 * Deterministic review fix planning.
 *
 * `/ship-review` scanners write one JSON artifact with findings. This command
 * turns that artifact into stable fix batches and parallel-safe waves so the
 * skill does not serially improvise one finding/fix/test loop at a time.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const DEFAULT_FINAL_VALIDATION = ["full-build", "full-test"];

function usage() {
  return [
    "shipyard-data review plan <findings.json> [--out <path>]",
    "",
    "Input shape:",
    "  { findings: [{ id, title, severity, files, required_validation, confidence }] }",
    "or a bare array of finding objects.",
  ].join("\n");
}

function parseArgs(args) {
  if (args[0] !== "plan") {
    throw Object.assign(new Error(`unknown review subcommand "${args[0] ?? ""}"\n${usage()}`), { exitCode: 2 });
  }
  const rest = args.slice(1);
  const outIdx = rest.indexOf("--out");
  let outPath = null;
  if (outIdx !== -1) {
    outPath = rest[outIdx + 1];
    if (!outPath) {
      throw Object.assign(new Error("shipyard-data review plan: --out requires a path"), { exitCode: 2 });
    }
    rest.splice(outIdx, 2);
  }
  const inputPath = rest[0];
  if (!inputPath || rest.length !== 1) {
    throw Object.assign(new Error(`shipyard-data review plan: expected one findings JSON path\n${usage()}`), { exitCode: 2 });
  }
  return { inputPath, outPath };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.findings)) return value.findings;
  throw Object.assign(new Error("shipyard-data review plan: input must be an array or { findings: [...] }"), { exitCode: 2 });
}

function normalizeSeverity(raw) {
  const s = String(raw ?? "medium").trim().toLowerCase().replace(/[_ ]+/g, "-");
  if (["critical", "blocker", "must-fix", "must"].includes(s)) return "critical";
  if (["high", "security"].includes(s)) return "high";
  if (["medium", "should-fix", "should"].includes(s)) return "medium";
  if (["low", "advisory", "consider"].includes(s)) return "low";
  return "medium";
}

function actionable(severity, finding) {
  const status = String(finding.status ?? finding.action ?? "").toLowerCase();
  if (status.includes("ignore") || status.includes("false-positive")) return false;
  if (status.includes("consider")) return false;
  return severity !== "low";
}

function normalizeFiles(finding) {
  const raw = finding.files ?? finding.paths ?? finding.file ? finding.files ?? finding.paths ?? [finding.file] : [];
  return [...new Set(raw.flatMap((f) => String(f).split(",")).map((f) => f.trim()).filter(Boolean))].sort();
}

function normalizeProbes(finding) {
  const raw = finding.required_validation ?? finding.required_probes ?? finding.probes ?? [];
  const list = Array.isArray(raw) ? raw : String(raw).split("\n");
  return [...new Set(list.map((p) => String(p).trim()).filter(Boolean))].sort();
}

function sanitizeId(raw, idx) {
  const source = String(raw ?? `R${String(idx + 1).padStart(3, "0")}`).trim();
  return source.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || `R${String(idx + 1).padStart(3, "0")}`;
}

function areaFor(files, fallbackId) {
  if (files.length === 0) return fallbackId.toLowerCase();
  const first = files[0].split("/").filter(Boolean);
  if (first.length >= 2 && ["src", "app", "lib", "tests", "test"].includes(first[0])) {
    return `${first[0]}-${first[1]}`;
  }
  return first[0] || basename(files[0]) || fallbackId.toLowerCase();
}

function overlaps(a, b) {
  return a.some((item) => b.includes(item));
}

function normalizedFindings(inputFindings) {
  return inputFindings.map((finding, idx) => {
    const severity = normalizeSeverity(finding.severity ?? finding.priority);
    const id = sanitizeId(finding.id ?? finding.finding_id, idx);
    const files = normalizeFiles(finding);
    const probes = normalizeProbes(finding);
    return {
      id,
      title: String(finding.title ?? finding.summary ?? id).trim(),
      severity,
      confidence: Number.isFinite(Number(finding.confidence)) ? Number(finding.confidence) : null,
      files,
      required_probes: probes,
      actionable: actionable(severity, finding),
      source: String(finding.source ?? finding.kind ?? "scanner").trim(),
      area: areaFor(files, id),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function mergeBatch(batch, finding) {
  batch.findings.push(finding.id);
  batch.files = [...new Set([...batch.files, ...finding.files])].sort();
  batch.required_probes = [...new Set([...batch.required_probes, ...finding.required_probes])].sort();
  batch.risk = batch.risk === "high" || ["critical", "high"].includes(finding.severity) ? "high" : "normal";
  batch.sources = [...new Set([...batch.sources, finding.source])].sort();
}

function buildBatches(findings) {
  const batches = [];
  for (const finding of findings.filter((f) => f.actionable)) {
    let target = batches.find((batch) => overlaps(batch.files, finding.files));
    if (!target && finding.required_probes.length > 0) {
      target = batches.find((batch) => overlaps(batch.required_probes, finding.required_probes));
    }
    if (!target) {
      target = {
        id: "",
        findings: [],
        files: [],
        required_probes: [],
        risk: "normal",
        sources: [],
        parallel_group: finding.area.replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase(),
        wave: null,
      };
      batches.push(target);
    }
    mergeBatch(target, finding);
  }

  batches.sort((a, b) => {
    const aKey = `${a.parallel_group}:${a.findings.join(",")}`;
    const bKey = `${b.parallel_group}:${b.findings.join(",")}`;
    return aKey.localeCompare(bKey);
  });
  batches.forEach((batch, idx) => {
    batch.id = `review-fix-${idx + 1}`;
  });
  return batches;
}

function assignWaves(batches) {
  const waves = [];
  for (const batch of batches) {
    let placed = false;
    for (const wave of waves) {
      const usedFiles = wave.batches.flatMap((b) => b.files);
      if (!overlaps(usedFiles, batch.files)) {
        wave.batches.push(batch);
        batch.wave = wave.index;
        placed = true;
        break;
      }
    }
    if (!placed) {
      const wave = { index: waves.length + 1, batches: [batch] };
      waves.push(wave);
      batch.wave = wave.index;
    }
  }
  return waves.map((wave) => ({
    index: wave.index,
    batch_ids: wave.batches.map((b) => b.id),
  }));
}

export function createReviewPlan(input) {
  const findings = normalizedFindings(asArray(input));
  const batches = buildBatches(findings);
  const waves = assignWaves(batches);
  const targeted = [...new Set(batches.flatMap((b) => b.required_probes))].sort();
  return {
    schema_version: 1,
    counts: {
      findings_total: findings.length,
      findings_actionable: findings.filter((f) => f.actionable).length,
      batches: batches.length,
      waves: waves.length,
    },
    findings,
    batches,
    waves,
    validation_ladder: {
      per_batch: "Run each batch's required_probes before accepting its return.",
      wave_boundary: targeted,
      final_validation: DEFAULT_FINAL_VALIDATION,
    },
  };
}

export function reviewPlanCmd(args) {
  const { inputPath, outPath } = parseArgs(args);
  const parsed = JSON.parse(readFileSync(inputPath, "utf8"));
  const plan = createReviewPlan(parsed);
  const rendered = `${JSON.stringify(plan, null, 2)}\n`;
  if (outPath) {
    writeFileSync(outPath, rendered);
    process.stdout.write(`${outPath}\n`);
  } else {
    process.stdout.write(rendered);
  }
}
