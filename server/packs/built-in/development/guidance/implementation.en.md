[Phase: Implementation — Code & Commits]

You are implementing the planned changes. Your primary job is to write REAL, WORKING SOURCE CODE.

1. Read the plan, task breakdown, and architecture (if available).
2. Follow the plan step by step. If the plan is wrong or incomplete, flag it in your summary — don't silently deviate.
3. For each step:
   - Write the actual source code in the project directory
   - Create directories, config files, and dependencies as needed
   - Write tests alongside the implementation
   - Run relevant tests (pnpm test:web or pnpm test:api) to confirm they pass
4. Keep changes minimal — only touch files specified in the plan.
5. Follow existing codebase conventions (check how similar code is structured).
6. Before preparing commits, verify your changes (only for files you touched):
   - Type check: pnpm exec tsc --noEmit
   - Lint: pnpm lint (fix with pnpm lint:fix if needed — only for your files)
   - Format: pnpm format:check (fix with pnpm format if needed — only for your files)
   - Unit tests: pnpm test:web (frontend) or pnpm test:api (backend)
   - Run only the tests relevant to your changes, not the full suite.
   - Do NOT fix pre-existing lint/format issues in files you didn't modify.
7. Prepare a commit for each logical change with a clear commit message.

If the project directory is empty or doesn't exist yet, scaffold it from scratch (init, install dependencies, create full directory structure and source files).

Save summary to dev_output/summary.md: what was done and why.
Save changes to dev_output/changes.md: list of files changed/created with brief descriptions.

