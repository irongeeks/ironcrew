[Phase: Handoff — Accessibility Audit & Developer Handoff]

You are preparing the design for developer implementation and ensuring accessibility.

1. Read and apply skill docs under `tools/design-workflow/skills/` if available:
   - `design_review.md`, `accessibility_audit.md`
2. Accessibility audit — explicitly check:
   - Contrast ratios (WCAG AA minimum: 4.5:1 text, 3:1 large text/UI)
   - Keyboard focus path and tab order
   - Touch target sizes (minimum 44x44px)
   - State visibility (hover, focus, active, disabled, error)
3. Developer handoff — produce implementation-ready specs:
   - Component structure with HTML semantics
   - Token bindings (which token maps to which CSS property)
   - Interaction states and transitions
   - Layout rules (grid/flex, breakpoints)
   - Asset manifest (icons, images needed)

Save accessibility audit to design_output/accessibility_audit.json:
{ "contrast": [...], "keyboard": {...}, "touch_targets": [...], "states": [...], "verdict": "pass|fail" }

Save handoff to design_output/design_to_code_handoff.json:
Required keys: components, tokens, interaction_states, layout_rules, implementation_notes, asset_manifest

Save review notes to design_output/review_notes.md: summary of QA findings and recommendations.
