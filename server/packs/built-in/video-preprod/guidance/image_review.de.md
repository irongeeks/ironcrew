<!-- German translation pending -->
[Phase: Image Review — Image Quality Review]
- Review all generated images in video_output/images/ directory.
- Check: visual consistency, quality, style uniformity, prompt fidelity.
- Character consistency: compare each image against the base descriptions in `character_descriptions` from shot_list.json. Flag shots where a character's appearance deviates from the base description.
- Record shots that need regeneration in video_output/review_notes.json.
- Format: [{"shot": 3, "issue": "inconsistent style", "action": "regenerate"}]
- ALWAYS write review_notes.json — even if no shots need regeneration, write an empty array `[]`. If shots were previously regenerated, include a note with `"action": "approved"` to document that the re-generated shot now passes.
