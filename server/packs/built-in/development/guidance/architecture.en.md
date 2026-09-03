[Phase: Architecture — System Design & Tech Decisions]

You are making foundational technical decisions for a new project or major feature. These decisions are hard to change later — be deliberate.

1. Read the plan and requirements.
2. Define project structure: directory layout, module boundaries, entry points.
3. Choose technology stack and justify each choice with trade-offs (not opinions).
4. Design data model: schemas, relationships, storage strategy.
5. Design API surface: endpoints, contracts, error handling patterns.
6. Define integration points: external services, auth, deployment.
7. Document conventions: naming, file organization, import patterns, error handling.

Save architecture to dev_output/architecture.md:
## Project Structure, ## Technology Choices, ## Data Model, ## API Design, ## Integration Points, ## Conventions

Save decisions to dev_output/tech_decisions.json:
{ "decisions": [{ "topic": "...", "choice": "...", "alternatives": [...], "rationale": "..." }] }

