# External Issue Fetch Protocol

When ship-discuss receives an external issue key as input (e.g., `SYS-123`, `PROJ-456`, `ENG-789`), it fetches context from the user's session MCP tools and seeds a NEW mode discussion.

## Detection

An external issue key matches the pattern: one or more uppercase letters, a hyphen, one or more digits — `[A-Z]+-\d+`. This is distinct from Shipyard's own IDs (F001, E001, T001, IDEA-NNN) which are matched first in mode detection.

Examples: `JIRA-123`, `SYS-456`, `ENG-789`, `PROJ-42`, `BUG-1001`.

GitHub-style `#123` is NOT auto-detected (ambiguous — could be a markdown heading reference). If the user means a GitHub issue, they should use the full form: `GH-123` or paste the URL.

## Fetch Procedure

### Step 1: Discover available MCP tools

Check which issue-tracker MCP tools are available in the current session. Look for tool names matching common patterns:

| System | Tool name patterns to check |
|---|---|
| Jira | `jira_get_issue`, `jira_search`, `getIssue`, `get_issue` |
| GitHub | `get_issue`, `github_get_issue`, `list_issues` |
| Linear | `linear_get_issue`, `getIssue` |
| GitLab | `gitlab_get_issue`, `get_issue` |
| Generic | any tool with `issue` + `get` in the name |

The check is opportunistic — scan available tool names, not a hardcoded list. If multiple trackers are available, prefer the one whose project-key prefix matches (e.g., `SYS-` might match a Jira project called `SYS`).

### Step 2: Fetch or ask

**If a matching MCP tool is found:**

Call it with the issue key. Extract from the response:
- Title
- Description / body
- Status (open, in progress, done, etc.)
- Priority
- Labels / components
- Acceptance criteria (if the tracker has them)
- Comments (last 5, for context — skip automated/bot comments)
- Linked issues (parent epic, related tickets)

Present a summary to the user:

```
Fetched SYS-123 from Jira:
  Title:    Payment timeout handling
  Status:   Open
  Priority: High
  Labels:   payments, reliability

  Description: [first 3 lines]...

Proceeding with full feature discussion using this as context.
```

**If no matching MCP tool is found:**

AskUserQuestion:
```
SYS-123 looks like an external issue key, but I don't have access to
your issue tracker. Paste the issue details (title + description) so
I can use them as context, or type the topic in your own words.
```

### Step 3: Seed NEW mode

Use the fetched (or pasted) content as the seed context for NEW mode:
- The issue title becomes the initial topic
- The issue description pre-loads Phase 1 (Understand Intent) — skip redundant questions the issue already answers
- Issue labels/components inform domain hints for edge-case discovery
- Linked parent epic: if the issue references a parent, check if a matching Shipyard epic exists (grep `external_refs` across epic files). If found, pre-assign `epic:` field.
- **Auto-link**: add the issue key to `external_refs` in the feature frontmatter. No confirmation needed — the user explicitly passed the key as input.

### Step 4: Bi-directional linking (optional)

After the feature is written (Phase 6 Finalize), offer to push a link back to the external issue:

AskUserQuestion: "Feature F009 is spec'd. Add a link back to SYS-123 in your tracker? (yes / no)"

If yes, and the tracker MCP has a comment or link tool (e.g., `jira_add_comment`, `add_remote_issue_link`), post a brief comment:
```
Shipyard spec: F009 — [feature title]
Status: approved
Acceptance criteria: [N] scenarios
```

If no write tool is available, skip silently.

## Edge Cases

- **Multiple issue keys in input** (e.g., `SYS-123 SYS-456`): Fetch both, ask user which is the primary topic, link all to `external_refs`.
- **Issue key matches a Shipyard ID pattern** (e.g., `F001`): Shipyard IDs are matched FIRST in mode detection — this protocol never fires for them.
- **Issue is already linked to an existing feature**: Grep `external_refs` across feature files. If `SYS-123` is already linked to F005, inform user: "SYS-123 is already linked to F005. Refine that feature instead? (refine F005 / new feature / unlink and start fresh)"
- **MCP tool returns an error** (auth expired, issue not found): Fall back to the "paste details" flow. Don't retry or troubleshoot MCP auth — that's the user's session concern.
- **Issue has no description**: Proceed with title only. Phase 1 will ask the user to elaborate.
