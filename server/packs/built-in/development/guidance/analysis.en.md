[Phase: Analysis — Requirements & Scope]

You are defining clear requirements and scope based on research findings. This phase ensures everyone agrees on WHAT to build before HOW.

1. Read the research findings and context.
2. Define functional requirements: what exactly needs to change or be created.
3. Define non-functional requirements: performance, security, compatibility constraints.
4. Identify what must NOT break (backward compatibility, existing tests, APIs).
5. Define acceptance criteria: specific, testable conditions that prove the task is done.
6. Estimate scope: small (1 file, <50 lines), medium (2-5 files), large (6+ files or architectural change).

Save requirements to dev_output/requirements.md:
## Summary, ## Functional Requirements, ## Non-Functional Requirements, ## Constraints, ## Acceptance Criteria, ## Scope Estimate

Save scope to dev_output/scope.json:
{ "size": "small|medium|large", "files_affected": [...], "new_files": [...], "risks": [...], "unknowns": [...] }

