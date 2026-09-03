[Phase: Screenplay — Screenplay & Storyboard]
- Based on the approved concept, create a detailed shot list.
- Read the Prompt-Ready Descriptions from video_output/concept.md.
- First create a `character_descriptions` object: map each character name → their prompt-ready description string copied VERBATIM from concept.md.
- For each shot include: scene description, ComfyUI positive prompt, negative prompt, motion_prompt, characters, duration_seconds.
- Format the `positive_prompt` STRICTLY using this 4-part structure for maximum quality:
  1. **Subject:** Describe the main subject(s) in detail (e.g., 'In the foreground, a highly detailed...'). Always start with the character's real name.
  2. **Setting:** Describe the environment, background, and props.
  3. **Artistic Style:** Detail the visual and medium style (e.g., 'hyper-realistic historical reconstruction, hand-painted textures, incredibly detailed').
  4. **Lighting & Camera:** Detail the lighting and photography style (e.g., 'soft gallery spotlighting, tilt-shift photography, shallow depth of field, 8k resolution, cinematic').
- Each shot's `positive_prompt` MUST include the base description from `character_descriptions` for every character in that shot. You may omit clothing/attire lines that contradict the scene's era or context (e.g., omit military uniform details in a diplomatic scene, omit suit details in a military scene). All other appearance details (face, build, skin tone, posture, scale) MUST remain VERBATIM. Do NOT paraphrase or rephrase retained details.
- CRITICAL: Every positive_prompt MUST begin with the character's real name (e.g., 'Adolf Hitler, claymation figure, ...'). The name is essential for ComfyUI to generate recognizable results.
- Era/scene-specific clothing or state variations should REPLACE the omitted attire line and/or be APPENDED after the base description (e.g., base minus military line + `, dark gray diplomatic coat, trembling hands`).
- motion_prompt (LTX I2V guidelines):
  - Focus ONLY on motion and action — do NOT describe static elements already present in the image.
  - Include: character movement (present tense: "walks", "turns", "gestures"), camera behavior ("camera slowly pushes in", "camera tracks left"), ambient motion ("smoke drifts upward", "dust particles float"), sound/audio if relevant ("distant artillery rumbles").
  - Example: "The figure slowly raises a trembling hand to the map. Camera holds steady with subtle push-in. Papers rustle softly on the table."
  - Note: These guidelines are optimized for LTX-Video models.
- Each video clip can be up to ~10 seconds (max 257 frames at 24fps). Plan duration_seconds (3-10s) and shot count accordingly.
- Save the shot list to video_output/shot_list.json.
- Format: {"character_descriptions": {"Name": "base appearance..."}, "shots": [{"shot": 1, "description": "...", "positive_prompt": "...", "negative_prompt": "...", "motion_prompt": "...", "characters": ["Name"], "duration_seconds": 8}]}
