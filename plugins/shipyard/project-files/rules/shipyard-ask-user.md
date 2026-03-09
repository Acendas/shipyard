---
alwaysApply: true
---

# AskUserQuestion: Two-Step Pattern

**Every user decision follows this pattern — no exceptions.**

### Step 1: Explain (plain text output)

Output the full context the user needs to make an informed decision. This is regular text — not a tool call. Include:
- What happened / what you found
- Why a decision is needed
- Tradeoffs or implications of each option
- Your recommendation and why

### Step 2: Ask (AskUserQuestion tool call)

Invoke the `AskUserQuestion` tool with a **short summary question + numbered choices + your recommendation**. The tool prompt should be self-contained — readable without the explanation above.

Format:
```
[One-line summary of the decision]

1. [Choice] — [brief consequence]
2. [Choice] — [brief consequence]
3. [Choice] — [brief consequence]

Recommended: [N] — [why in one sentence]
```

### Why Two Steps

- **Plain text does NOT pause execution.** If you output a question as text, you will continue generating and act on your own assumed answer. Only the `AskUserQuestion` tool stops and waits.
- **AskUserQuestion alone lacks context.** The user sees a prompt box with no surrounding explanation. They can't make a good decision without understanding the situation.
- **Together:** the user reads the explanation in the conversation, then gets a clean decision prompt with choices.

### Wrong

```
I found 3 features ready. The sprint capacity is 20 points.
Which features do you want? I'll go ahead and pick F001 and F002...
```

Asked and answered itself. User never got to choose.

### Also Wrong

```
AskUserQuestion: "I found 3 features. F001 (8pts, auth), F002 (5pts, notifications),
F003 (13pts, payments). Sprint capacity is 20pts. Your past velocity averages 18pts.
F001+F002 fits at 13pts with room. F001+F003 is 21pts, slightly over.
Which features? (list IDs or 'suggested')"
```

All the context is crammed into the tool prompt. Hard to read in a small input box.

### Right

```
[Plain text output:]
Found 3 approved features in the backlog:
  F001: Auth (8 pts) — RICE: 32.1
  F002: Notifications (5 pts) — RICE: 28.4
  F003: Payments (13 pts) — RICE: 24.0

Sprint capacity: 20 pts (based on last 3 sprints averaging 18 pts).
F001 + F002 = 13 pts, fits comfortably with room for overflow.
F001 + F003 = 21 pts, slightly over capacity.

[AskUserQuestion tool call:]
"Which features for this sprint?

1. F001 + F002 (13 pts) — safe, room for overflow
2. F001 + F003 (21 pts) — slightly over, tight
3. All three (26 pts) — aggressive, likely won't finish
4. Custom — list your own selection

Recommended: 1 — fits capacity with buffer for unknowns"
```

### When AskUserQuestion is Mandatory

- Approval gates (approve sprint plan, features, release)
- Ambiguous specs or multiple valid approaches
- Architectural decisions
- Scope changes (task growing, feature splitting)
- Blocker escalation
- Any time the skill text says "AskUserQuestion:"

### Self-Check

Before taking any action that depends on user input: "Did I actually invoke AskUserQuestion and receive a response, or did I just print a question?" If you printed it — stop and invoke the tool now.

---

## Communication Quality

The two-step pattern above covers **mechanics** (when to use AskUserQuestion). This section covers **comprehension** — how well your explanation communicates. Full design system: `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/communication-design.md`.

### The 3-Layer Explanation Pattern

When surfacing something the user hasn't considered (a risk, assumption, edge case, technical discovery):

1. **One-liner** — What's happening + your recommendation. Must work standalone. Front-load the first 15 words.
2. **Context** — 2–3 bullets: why it matters, key tradeoff, analogy if helpful.
3. **Detail** — Technical depth. Only include for high-stakes or irreversible decisions, or when the user asks.

### Hard Targets

- **2–3 options max** per decision, always with a recommended default
- **3–4 new concepts max** per message — more overwhelms working memory
- **Under 100 words** for decision messages, under 200 for informational
- **Short sentences, technical vocabulary OK** — audience is architects/leads, domain terms are fine
- **First person** — "I found..." / "I recommend..." not "The analysis shows..."
- **Show diagrams** for multi-component features — C4, sequence, dependency graphs. Architects think visually

### Framing

- **Name the tradeoff** on each option: "Fast (less thorough)" not "Option 1"
- **Frame positively** — "handles 95% of cases" not "fails in 5%"
- **Flag reversibility** — "You can change this later" reduces decision anxiety
- **Show, don't tell** — include the relevant data inline, don't make the user go look it up
