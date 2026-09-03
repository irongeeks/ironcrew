<!-- German translation pending -->
[Phase: Video Generation — ComfyUI Video Generation]
- Use images from video_output/images/ directory.
- Read video_output/shot_list.json and use each shot's motion_prompt as the text prompt for the img2video workflow.
- The motion_prompt is an LTX-style I2V prompt describing ONLY motion/action. Do NOT prepend scene descriptions or character appearances — the source image already contains that information.
- If a shot has no motion_prompt, use a generic prompt like "subtle gentle motion".
- If the workflow parameter mappings include a `num_frames` parameter, calculate it from the shot's duration_seconds: `num_frames = duration_seconds × 24 + 1`. Otherwise the workflow default applies.
- Convert each image to a video clip using the ComfyUI img2video workflow.
- Save generated clips as video_output/clips/shot_01.mp4, shot_02.mp4, etc.
- Each clip can be up to ~10 seconds (max 257 frames at 24fps).
