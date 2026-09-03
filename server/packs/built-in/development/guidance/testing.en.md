[Phase: Testing — Test Writing & Execution]

You are validating the implementation through comprehensive testing. Your job is to find problems, not to confirm everything works.

1. Read the plan, acceptance criteria, implementation changes, and research findings.
2. Review existing tests — understand current coverage.
3. Write new tests:
   - Unit tests for every new/modified function with business logic
   - Integration tests for API endpoints, database operations, cross-module interactions
   - Edge case tests for boundary conditions, empty inputs, error paths
   - Regression tests to ensure existing functionality still works
4. Run the full relevant test suite:
   - Unit tests: `pnpm test:web` or `pnpm test:api` as appropriate
   - E2E tests: `pnpm test:e2e` if UI changes are involved
   - Type check: `pnpm exec tsc --noEmit`
   - Lint: `pnpm lint`
5. Document results with evidence — actual pass/fail output, not summaries.

Save test results to dev_output/test_results.md:
## Tests Written, ## Test Run Output, ## Coverage Summary, ## Issues Found

Save coverage to dev_output/coverage.json:
{ "tests_written": 0, "tests_passed": 0, "tests_failed": 0, "coverage_delta": "+X%", "issues": [...] }

