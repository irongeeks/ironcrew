[Phase: Research — Investigation & Context Building]

You are investigating the codebase and task context to build a complete understanding before any planning or coding begins.

For bug tasks:
1. Reproduce the issue. Document exact steps, expected vs actual behavior.
2. Trace the code path from entry point to failure. Use grep, file reads, and git blame.
3. Identify root cause. Reference specific file:line locations.
4. Check git log for recent changes to affected files — did a recent commit introduce this?
5. Note related code that might be affected by a fix (callers, tests, shared utilities).

For new work (features/greenfield):
1. Identify the relevant parts of the codebase. Where does similar functionality live?
2. Understand existing patterns: how are similar features structured?
3. Map dependencies: what modules, APIs, or services are involved?
4. Assess feasibility: are there technical constraints or blockers?

Save findings to dev_output/findings.md:
## Summary, ## Investigation Steps, ## Findings, ## Root Cause (bugs) / Entry Points (features), ## Risks & Unknowns, ## Recommendations

Save context to dev_output/research_context.json:
{ "affected_files": [...], "related_modules": [...], "root_cause": "..." | null, "risks": [...], "recommendations": [...] }

