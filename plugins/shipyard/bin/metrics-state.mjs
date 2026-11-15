/**
 * metrics-state — the one reader/writer of `memory/metrics.json` (authoritative)
 * and the generated `memory/metrics.md`. Extracted from shipyard-data.mjs (F011)
 * so `shipyard-data capacity` and `archive-sprint` share one loader without a
 * module cycle. Leaf module: node built-ins only.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function emptyMetricsState() {
  return {
    schema_version: 1,
    velocity: { all_time: { count: 0, total: 0, min: null, max: null, average: null }, recent: [] },
    throughput: { all_time: { count: 0, total: 0, min: null, max: null, average: null }, recent: [] },
    retro: { recent: [] },
  };
}

export function normalizeMetricsState(raw) {
  const state = emptyMetricsState();
  if (!raw || typeof raw !== "object") return state;
  for (const key of ["velocity", "throughput"]) {
    const src = raw[key] && typeof raw[key] === "object" ? raw[key] : {};
    const all = src.all_time && typeof src.all_time === "object" ? src.all_time : src;
    state[key].all_time.count = Number.isFinite(Number(all.count)) ? Number(all.count) : 0;
    state[key].all_time.total = Number.isFinite(Number(all.total)) ? Number(all.total) : 0;
    state[key].all_time.min = all.min === null || all.min === undefined ? null : Number(all.min);
    state[key].all_time.max = all.max === null || all.max === undefined ? null : Number(all.max);
    state[key].all_time.average = all.average === null || all.average === undefined ? null : Number(all.average);
    state[key].recent = Array.isArray(src.recent) ? src.recent : [];
  }
  state.retro.recent = Array.isArray(raw.retro?.recent) ? raw.retro.recent : [];
  return state;
}

export function loadMetricsState(dataDir) {
  const jsonPath = join(dataDir, "memory", "metrics.json");
  if (existsSync(jsonPath)) {
    try {
      return normalizeMetricsState(JSON.parse(readFileSync(jsonPath, "utf8")));
    } catch {
      return emptyMetricsState();
    }
  }
  return loadLegacyMetricsState(dataDir);
}

export function loadLegacyMetricsState(dataDir) {
  const state = emptyMetricsState();
  const metricsPath = join(dataDir, "memory", "metrics.md");
  if (!existsSync(metricsPath)) return state;
  let content = "";
  try {
    content = readFileSync(metricsPath, "utf8");
  } catch {
    return state;
  }
  for (const line of content.split(/\r?\n/)) {
    const velocity = line.match(/\bVelocity:\s*(\d+)\s*pts\b/i);
    const sprint = line.match(/\b(sprint-\d{3,})\b/i);
    if (velocity && sprint) {
      state.velocity.recent.push({
        sprint: sprint[1].toLowerCase(),
        points: Number.parseInt(velocity[1], 10),
        features: parseFeatureSummary(line),
        recorded_at: null,
      });
    }
    const throughput = line.match(/\bThroughput:\s*([0-9]+(?:\.[0-9]+)?)\s*pts\/hr\b/i);
    if (throughput && sprint) {
      state.throughput.recent.push({
        sprint: sprint[1].toLowerCase(),
        points_per_hour: Number(throughput[1]),
        recorded_at: null,
      });
    }
  }
  state.velocity.recent = dedupeSprintRecords(sortSprintRecords(state.velocity.recent));
  state.throughput.recent = dedupeSprintRecords(sortSprintRecords(state.throughput.recent));
  recomputeAggregateFromRecent(state.velocity, "points");
  recomputeAggregateFromRecent(state.throughput, "points_per_hour");
  state.velocity.recent = state.velocity.recent.slice(-10);
  state.throughput.recent = state.throughput.recent.slice(-10);
  return state;
}

export function parseFeatureSummary(line) {
  const m = line.match(/\bfeatures=([^#\n]+)/);
  if (!m) return [];
  return m[1].split(",").map((part) => {
    const [id, points] = part.trim().split(":");
    return { id, points: Number.parseInt(points, 10) || 0 };
  // Child/sub-feature ids (F071d) are legitimate — see FID_RE in
  // spec-state-cli.mjs. A plain /^F\d+$/ silently dropped them from every
  // sprint feature summary, so their story points vanished from metrics.
  }).filter((f) => /^F\d+[a-z]?$/.test(f.id));
}

export function sortSprintRecords(records) {
  return [...records].sort((a, b) => sprintSortKey(a.sprint) - sprintSortKey(b.sprint));
}

export function sprintSortKey(sprint) {
  const n = String(sprint || "").match(/sprint-(\d+)/i)?.[1];
  return n ? Number.parseInt(n, 10) : 0;
}

export function dedupeSprintRecords(records) {
  const bySprint = new Map();
  for (const record of records) bySprint.set(record.sprint, record);
  return [...bySprint.values()];
}

export function recomputeAggregateFromRecent(bucket, valueKey) {
  const values = bucket.recent
    .map((r) => Number(r[valueKey]))
    .filter((n) => Number.isFinite(n));
  bucket.all_time.count = values.length;
  bucket.all_time.total = roundMetric(values.reduce((sum, n) => sum + n, 0));
  bucket.all_time.min = values.length ? roundMetric(Math.min(...values)) : null;
  bucket.all_time.max = values.length ? roundMetric(Math.max(...values)) : null;
  bucket.all_time.average = values.length ? roundMetric(bucket.all_time.total / values.length) : null;
}

export function updateMetricAggregate(bucket, value, replacingValue = undefined) {
  const n = roundMetric(Number(value));
  if (!Number.isFinite(n)) return;
  const all = bucket.all_time;
  if (Number.isFinite(Number(replacingValue))) {
    const previous = Number(replacingValue);
    all.total = roundMetric(all.total - previous + n);
    all.average = all.count > 0 ? roundMetric(all.total / all.count) : null;
    if (all.min === null || n < all.min) all.min = n;
    if (all.max === null || n > all.max) all.max = n;
    return;
  }
  all.count += 1;
  all.total = roundMetric(all.total + n);
  all.min = all.min === null ? n : Math.min(all.min, n);
  all.max = all.max === null ? n : Math.max(all.max, n);
  all.average = roundMetric(all.total / all.count);
}

export function roundMetric(n) {
  return Math.round(n * 100) / 100;
}

export function writeMetricsState(dataDir, state) {
  const metricsDir = join(dataDir, "memory");
  mkdirSync(metricsDir, { recursive: true });
  const normalized = normalizeMetricsState(state);
  normalized.velocity.recent = sortSprintRecords(normalized.velocity.recent).slice(-10);
  normalized.throughput.recent = sortSprintRecords(normalized.throughput.recent).slice(-10);
  normalized.retro.recent = sortSprintRecords(normalized.retro.recent).slice(-10);

  const jsonPath = join(metricsDir, "metrics.json");
  const jsonTmp = jsonPath + ".tmp";
  writeFileSync(jsonTmp, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  renameSync(jsonTmp, jsonPath);

  const mdPath = join(metricsDir, "metrics.md");
  const mdTmp = mdPath + ".tmp";
  writeFileSync(mdTmp, renderMetricsMarkdown(normalized), "utf8");
  renameSync(mdTmp, mdPath);
}

export function renderMetricsMarkdown(state) {
  const lines = [
    "# Metrics",
    "",
    "Generated by `shipyard-data metrics` and `shipyard-data archive-sprint`. Do not edit by hand.",
    "",
    "## Summary",
  ];
  const velocityAll = state.velocity.all_time;
  const throughputAll = state.throughput.all_time;
  if (velocityAll.count > 0) {
    lines.push(`Velocity average: ${velocityAll.average} pts/sprint`);
    lines.push(`Velocity range: ${velocityAll.min}-${velocityAll.max} pts/sprint`);
    lines.push(`Velocity total: ${velocityAll.total} pts across ${velocityAll.count} sprint${velocityAll.count === 1 ? "" : "s"}`);
    lines.push(`Velocity records retained: ${state.velocity.recent.length} sprint${state.velocity.recent.length === 1 ? "" : "s"}`);
  } else {
    lines.push("Velocity: no completed sprints recorded");
  }
  if (throughputAll.count > 0) {
    lines.push(`Throughput average: ${throughputAll.average} pts/hr`);
    lines.push(`Throughput range: ${throughputAll.min}-${throughputAll.max} pts/hr`);
  }
  lines.push("", "## Recent Sprint Velocity");
  if (state.velocity.recent.length === 0) {
    lines.push("- none");
  } else {
    for (const r of sortSprintRecords(state.velocity.recent).slice().reverse()) {
      const features = Array.isArray(r.features) && r.features.length
        ? `; features=${r.features.map((f) => `${f.id}:${f.points}`).join(",")}`
        : "";
      lines.push(`Velocity: ${r.points} pts  # ${r.sprint}${features}`);
    }
  }
  lines.push("", "## Recent Throughput");
  if (state.throughput.recent.length === 0) {
    lines.push("- none");
  } else {
    for (const r of sortSprintRecords(state.throughput.recent).slice().reverse()) {
      const detail = Number.isFinite(Number(r.points)) && Number.isFinite(Number(r.active_hours))
        ? ` (${r.points} pts in ${r.active_hours} hrs active)`
        : "";
      lines.push(`Throughput: ${r.points_per_hour} pts/hr${detail}  # ${r.sprint}`);
    }
  }
  if (state.retro.recent.length > 0) {
    lines.push("", "## Recent Retro Metrics");
    for (const r of sortSprintRecords(state.retro.recent).slice().reverse()) {
      const parts = [];
      for (const key of ["carry_over", "bug_rate", "estimate_accuracy", "flags"]) {
        if (r[key]) parts.push(`${key}=${r[key]}`);
      }
      lines.push(`- ${r.sprint}: ${parts.length ? parts.join("; ") : "recorded"}`);
    }
  }
  return lines.join("\n") + "\n";
}

