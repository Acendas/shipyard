export const meta = {
  name: 'story-review',
  description: 'Per-story spec review then gap analysis, read-only, pipelined per story',
  whenToUse: 'Called by /ship-execute per-story review when review.workflow is true and several stories complete in one wave.',
  phases: [{ title: 'Spec review' }, { title: 'Gap analysis' }],
}
// args: { stories: string[], base_ref, head_ref, data_dir, model?, effort? }
const SPEC = { type: 'object', properties: { status: { type: 'string' }, met: { type: 'number' }, partial: { type: 'number' }, missing: { type: 'number' }, over_built: { type: 'number' }, findings: { type: 'array', items: { type: 'string' } } }, required: ['status', 'met', 'partial', 'missing', 'over_built'] }
const GAPS = { type: 'object', properties: { gaps: { type: 'array', items: { type: 'string' } }, self_review_failed: { type: 'array', items: { type: 'string' } } }, required: ['gaps'] }
const a = args || {}
const base = (story) => `Scope: feature. Target IDs: [${story}]. Base ref: ${a.base_ref}. Head ref: ${a.head_ref}. Data dir: ${a.data_dir}.`
const opts = (o) => { if (a.model) o.model = a.model; if (a.effort) o.effort = a.effort; return o }
const out = await pipeline(a.stories || [],
  (story) => agent(base(story), opts({ label: `spec:${story}`, phase: 'Spec review', schema: SPEC, agentType: 'shipyard:shipyard-spec-reviewer' })),
  (spec, story) => agent(`${base(story)} Spec-review findings: ${JSON.stringify(spec)}.`,
    opts({ label: `gaps:${story}`, phase: 'Gap analysis', schema: GAPS, agentType: 'shipyard:shipyard-gap-analyst' })).then((gaps) => ({ story, spec, gaps })))
return out.filter(Boolean)
