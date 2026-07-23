# Phase 7: Epic Integration AC (EP7)

After EP6 (Wrap Up) approves all epic changes, generate integration acceptance criteria that test the seams between features. This phase runs only in EPIC mode.

## When to Run

- **EPIC mode only**, after EP6 approval
- Skip if the epic has ≤1 feature (no seams to test)
- Skip if 0 features in the epic have acceptance criteria (nothing to integrate)

## Procedure

### Step 1: Read All Features in Epic

Grep for `epic: E00N` across all feature files. For each approved/done feature, read:
- Acceptance criteria (both Core AC and E2E AC tiers)
- Dependencies array (which features depend on which)
- Interface section (API endpoints, data contracts)
- Data Model section (shared entities, schemas)
- Flows section (any persisted Mermaid diagram — sequence, state machine, ER, deployment, data-flow, user journey; the canonical set lives in `phase-3-write-spec.md`)

### Step 2: Identify Integration Seams

Seams exist where:
- **Output → Input**: Feature A produces data that Feature B consumes
- **Shared Entity**: Two features read/write the same data entity
- **Sequential Journey**: A user flow spans multiple features in sequence
- **Error Propagation**: Feature A's failure state affects Feature B's behavior
- **Shared Resource**: Features share a rate limit pool, connection pool, cache, or external service

For each detected seam, note which features are involved and what the integration concern is.

### Step 3: Generate Integration AC

For each seam, write a Given/When/Then scenario with multi-feature scope. The Given clause references state from one feature, the When clause involves another feature's action, and the Then clause verifies the integrated outcome.

Format:
```markdown
Given user signed up via F001 and verified email via F002,
When they access profile setup (F003),
Then their email is pre-populated from F001's signup data and verification status shows "confirmed" from F002.
```

Each integration AC uses:
- `tier: "e2e"`
- `e2e_category: "integration-seam"`
- `verification_type`: inferred (probe if testable via API calls, manual if requires UI observation)

### Step 4: Present and Approve

Render every generated integration AC verbatim as chat text, grouped by seam type, BEFORE the ask — the scenarios were generated in Step 3 and exist only in your context; question/option strings (a compact card) cannot hold Given/When/Then text, and "Accept all" on unseen criteria is a blind ask. Then AskUserQuestion:

"I identified [N] integration seams across [M] features in this epic. Here are the cross-feature acceptance criteria:"

Options:
- "Accept all"
- "Pick scenarios"
- "Skip — features are independently testable"

### Step 5: Write to Epic File

Write approved integration AC to the epic file body under:

```markdown
## Integration Acceptance Criteria

**[F001 → F003: shared user entity]** Given user signed up via F001, When they access profile setup (F003), Then their email is pre-populated from signup data.

**[F002 → F003: verification status]** Given user verified email via F002, When they access profile setup (F003), Then verification status shows "confirmed".
```

If the section would push the epic file over 200 lines, extract to `<SHIPYARD_DATA>/spec/references/ENNN-integration-ac.md` and add to the epic's references.

## Edge Cases

- **Epic with 1 feature**: Skip entirely. Inform user: "Single-feature epic — no integration seams to test."
- **All features are `proposed` (no AC yet)**: Skip. Note: "Integration AC deferred until features have acceptance criteria."
- **Features with no shared data/API surface**: Check for journey-level seams (user flows that cross feature boundaries). If genuinely no seams exist, inform user and skip.
- **Features in different sprints**: Integration AC still applies — it tracks what must be true when all features are delivered, regardless of delivery order.
