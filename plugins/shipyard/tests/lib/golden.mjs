// Golden-pin helper: compare actual output to tests/golden/<name>.json.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const defaultGoldenDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'golden');

export function pin(name, meta, actual, goldenDir = defaultGoldenDir) {
  if (!meta || !['identical', 'changes'].includes(meta.rename)) {
    throw new Error(`pin(${name}): rename must be 'identical' or 'changes'`);
  }
  if (typeof meta.alias !== 'string' || !/^[A-Z]+-\d+$/.test(meta.alias)) {
    throw new Error(`pin(${name}): alias must be an alias row id like 'A-01'`);
  }
  const file = path.join(goldenDir, `${name}.json`);
  const text = JSON.stringify(actual, null, 2) + '\n';
  if (process.env.SHIPYARD_GOLDEN_RECORD === '1') {
    fs.mkdirSync(goldenDir, { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  if (!fs.existsSync(file)) {
    assert.fail(`missing golden fixture ${file}; record it from the unmodified tree with SHIPYARD_GOLDEN_RECORD=1`);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), JSON.parse(text));
}

// Static check: returns problems for each pin( call lacking rename/alias.
export function checkPinSource(src) {
  const problems = [];
  const re = /(?<![\w.])pin\(\s*(['"`])([^'"`]*)\1\s*,\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(src))) {
    const body = m[3];
    if (!/rename\s*:\s*['"](identical|changes)['"]/.test(body)) problems.push(`pin(${m[2]}): missing rename: identical|changes`);
    const a = /alias\s*:\s*(['"])([^'"]*)\1/.exec(body);
    if (!a || a[2] === '') problems.push(`pin(${m[2]}): missing non-empty alias`);
    else if (!/^[A-Z]+-\d+$/.test(a[2])) problems.push(`pin(${m[2]}): alias '${a[2]}' must match ^[A-Z]+-\\d+$`);
  }
  const total = (src.match(/(?<![\w.])pin\(/g) || []).length;
  const matched = (src.match(re) || []).length;
  for (let i = matched; i < total; i++) problems.push('pin(: call without literal name and {rename, alias} object');
  return problems;
}
