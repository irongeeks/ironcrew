## Summary

<!-- What does this PR do? Keep it brief (1-3 sentences). -->

## Related Issue

<!-- Link the issue this PR addresses. Use "Closes #123" to auto-close on merge. -->

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / code improvement
- [ ] Documentation
- [ ] CI / build / tooling
- [ ] Other (describe below)

## Base Branch Policy

- External contributor PRs must target `dev`.
- `main` is only for maintainer-approved emergency hotfix PRs.
- If merged to `main` as hotfix, `main -> dev` back-merge is required.

## Checklist

- [ ] Base branch is `dev` (or emergency hotfix to `main` with rationale below)
- [ ] Linked issue or context is included
- [ ] `pnpm run format:check` passes
- [ ] `pnpm run lint` passes
- [ ] `pnpm run build` passes
- [ ] `pnpm run test:ci` passes (or reason provided if skipped)
- [ ] Docs/README were updated if behavior or setup changed

## Hotfix Rationale (required only when base is `main`)

<!-- Explain why this must go directly to main and who approved it. -->
