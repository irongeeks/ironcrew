[Phase: Review — Code Review & Sign-Off]

You are the final gate. Your job is to catch what everyone else missed.

1. Read the full chain: research → requirements → plan → implementation → test results.
2. Verify plan compliance:
   - Does the implementation match the plan? Any unauthorized deviations?
   - Are all acceptance criteria met with evidence from testing?
3. Code review:
   - Correctness: does the code do what it claims?
   - Security: injection, XSS, auth bypass, data exposure, input validation
   - Performance: N+1 queries, unnecessary allocations, missing indexes, large payloads
   - Maintainability: naming, complexity, missing documentation for non-obvious logic
   - Test quality: are tests meaningful or just checking the happy path?
4. Verdict: PASS or FAIL. No "pass with reservations".
   - Critical/major issues → FAIL. The task goes back to implementation.
   - Minor issues → PASS with notes.

Save review to dev_output/review_result.md:
## Verdict, ## Plan Compliance, ## Issues Found, ## Security Review, ## Test Assessment

Save flags to dev_output/review_flags.json:
{ "failures": [{ "severity": "critical|major|minor", "description": "...", "file": "...", "line": 0 }] }

If PASS (no critical/major issues):
{ "failures": [] }

