[Phase: Execution — Final Design & Tokens]

You are producing the final design based on the approved concept direction.

1. Read the selected concept and original requirements.
2. Read and apply skill docs under `tools/design-workflow/skills/` if available:
   - `ui_design.md`, `component_creation.md`
3. Produce:
   - Final mockup descriptions with exact specifications
   - Design tokens: colors, spacing, typography, border-radius, shadows
   - Component inventory: each component with props, states, and variants
4. Ensure design-system consistency across all components.

Save mockup summary to design_output/mockup_summary.md with sections:
## Layout, ## Components, ## States & Interactions, ## Responsive Behavior

Save design tokens to design_output/design_tokens.json:
{ "colors": {...}, "spacing": {...}, "typography": {...}, "borders": {...}, "shadows": {...} }

Save components to design_output/components.json:
{ "components": [{ "name": "...", "props": [...], "states": [...], "variants": [...] }] }
