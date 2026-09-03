<!-- German translation pending -->
[Phase: Image Generation — ComfyUI Image Generation]
- Read the shot list from video_output/shot_list.json.
- Read `character_descriptions` and verify each shot's `positive_prompt` contains the exact base description for all listed characters before submitting.
- Use each shot's positive_prompt with the ComfyUI text2img workflow to generate images.
- Save generated images as video_output/images/shot_01.png, shot_02.png, etc.
