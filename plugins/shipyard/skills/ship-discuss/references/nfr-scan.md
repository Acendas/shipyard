# Non-Functional Requirements Scan

For each category, ask: "Does this feature have specific needs here, or are project defaults sufficient?" Only add NFRs that are SPECIFIC to this feature.

## Performance
- What response time is acceptable? (< 200ms interactive, < 2s reports?)
- What data volume must this handle? (10 records vs 10M — changes everything)
- Are there operations that could be slow? (bulk ops, complex queries, file processing)
- Will this be called frequently? (once a day vs 1000x/second)

## Security
- Does this handle sensitive data? (PII, financial, credentials, health)
- What auth/authz beyond project defaults?
- Are there injection vectors? (user input → queries, filenames, commands, HTML)
- Does this need audit logging? (who did what, when)
- Rate limiting needed?

## Data Integrity
- What happens if operation is interrupted midway? (atomic? compensating transaction?)
- Data that must never be lost vs. regeneratable?
- Backup/recovery requirements? (RPO/RTO for this data)

## Observability
- What metrics should this feature emit? (latency, error rate, usage)
- What triggers an alert? (error rate > N%, latency > Nms)
- What logs are needed for debugging production issues?

## Accessibility (if UI)
- Keyboard navigable?
- Screen reader compatible? (ARIA labels, semantic HTML)
- Color contrast sufficient?
- Works without JavaScript?

## Internationalization (if UI)
- Hardcoded strings needing extraction?
- Date/number/currency formatting locale-aware?
- RTL layout support?
- Content that varies by locale? (legal text, tax rules)

## Error UX
- What does the user see when this fails?
- Is the error message actionable?
- Is there a degraded mode? (stale data vs nothing)

## Output

Add relevant NFRs to the feature file's acceptance criteria as non-functional scenarios:
```
WHEN the payment endpoint receives 100 concurrent requests
THEN all complete within 500ms p95

IF the payment provider is unavailable
THEN the system shall show "Payment temporarily unavailable, try again in a few minutes"
```
