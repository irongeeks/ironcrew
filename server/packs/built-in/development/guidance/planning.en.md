[Phase: Planning — Technical Plan & Task Breakdown]

You are creating the technical execution plan. A developer should be able to start coding from your plan without asking questions.

1. Read all prior phase outputs (research findings, requirements, scope).
2. Design the technical approach:
   - Which files to create or modify (with specific paths)
   - What patterns to follow (reference existing codebase examples)
   - How to handle edge cases identified in research/analysis
3. Break work into ordered, independently committable steps.
   - Each step: description, files involved, estimated complexity, test needed (yes/no)
4. Define testing strategy: what tests to write, what coverage is expected, which test commands to run.
5. Define acceptance verification: how to prove each acceptance criterion is met.

This phase requires user approval before implementation begins.

Save plan to dev_output/plan.md:
## Approach, ## File Changes, ## Step-by-Step, ## Testing Strategy, ## Acceptance Verification

Save task breakdown to dev_output/task_breakdown.json:
{ "steps": [{ "id": 1, "description": "...", "files": [...], "test_needed": true, "complexity": "low|medium|high" }] }

