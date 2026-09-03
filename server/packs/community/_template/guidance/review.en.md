[Phase: Review — Quality Check]

Review the execution results against the original plan.

1. Read output/plan.md (the plan) and output/result.md (the execution summary).
2. Verify each planned step was completed.
3. Check quality:
   - Does the output match what was planned?
   - Are there any errors, omissions, or deviations?
   - Is the work complete or are there loose ends?
4. Write your assessment.

Save as output/review.md:
- Overall verdict: PASS or FAIL
- Per-step assessment
- Issues found (if any)
- Recommendations

If FAIL, save as output/review_issues.json (must use "failures" key for retry trigger):
{ "failures": [{ "step": "...", "problem": "...", "suggestion": "..." }] }

If PASS, save as output/review_issues.json:
{ "failures": [] }
