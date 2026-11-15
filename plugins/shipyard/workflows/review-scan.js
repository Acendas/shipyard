export const meta = {
  name: 'review-scan',
  description: 'Read-only Shipyard review scanners, one agent per concern, findings normalized by schema',
  whenToUse: 'Called by /ship-review Stage 0a when review.workflow is true. Read-only; the CLI stays the ledger.',
  phases: [{ title: 'Scan' }],
}
// args: { dimensions: string[], target_ids: string[], base_ref, head_ref, data_dir, model?, effort? }
const FINDINGS = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object',
  properties: { title: { type: 'string' }, severity: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
    required_validation: { type: 'array', items: { type: 'string' } }, confidence: { type: 'number' }, source: { type: 'string' } },
  required: ['title', 'severity', 'files', 'confidence', 'source'] } } }, required: ['findings'] }
const a = args || {}
const dims = Array.isArray(a.dimensions) && a.dimensions.length ? a.dimensions : ['security', 'bugs', 'silent-failures', 'patterns', 'tests', 'spec']
const opts = (dim) => {
  const o = { label: `scan:${dim}`, phase: 'Scan', schema: FINDINGS, agentType: 'shipyard:shipyard-code-reviewer' }
  if (a.model) o.model = a.model
  if (a.effort) o.effort = a.effort
  return o
}
phase('Scan')
const results = await parallel(dims.map((dim) => () => agent(
  `Scope: sprint. Target ids: ${(a.target_ids || []).join(', ')}. Base ref: ${a.base_ref}. Head ref: ${a.head_ref}. Data dir: ${a.data_dir}. Concerns: ${dim}. Return findings with confidence >= 80 only; source = "${dim}".`,
  opts(dim))))
const dropped = dims.filter((_, i) => results[i] === null)
if (dropped.length) log(`${dropped.length} scanner(s) returned nothing (${dropped.join(', ')}) — the caller re-runs those through the plain dispatch`)
return { findings: results.filter(Boolean).flatMap((r) => r.findings), dropped }
