---
alwaysApply: true
---

# Review Standards

When reviewing completed tasks or running /ship-review:

## Verification Checklist
1. **Scenario coverage** — every acceptance scenario (Given/When/Then) has a corresponding test.
2. **TDD compliance** — test files exist for every implementation file. Tests were written first (check git log order).
3. **Mutation testing** — at minimum one mutation was tested and caught.
4. **Coverage thresholds:**
   - Auth/payments/security: 95%
   - Business logic/domain: 90%
   - Server actions/API: 85%
   - UI components: 80%
5. **No over-building** — implementation does what the spec says, nothing more.
6. **Security** — no hardcoded secrets, no SQL injection, no XSS, proper input validation at boundaries.
7. **Accessibility** — screen reader labels (ARIA), keyboard navigation, sufficient contrast (for UI tasks).

## Visual Verification (UI Tasks)
- Screenshots at 3 viewports: mobile (375px), tablet (768px), desktop (1024px).
- Check layout, content, interactive states.
- Screenshots saved to `$(shipyard-data)/verify/`.

## Gap Detection
- If an acceptance scenario has no implementation → create patch task.
- If implementation exists but no test → flag as TDD violation.
- If edge case is missing → propose as new scenario to user.

## Demo Preparation
- Ensure dev server is running.
- Seed test data if needed.
- Prepare test credentials.
- Navigate to the right page/screen for the user.
