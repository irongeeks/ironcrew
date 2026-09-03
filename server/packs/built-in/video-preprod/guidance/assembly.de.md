<!-- German translation pending -->
[Phase: Assembly — Final Assembly]
- ONLY use actual video clips (.mp4) from video_output/clips/.
- IMPORTANT: Do NOT create clips from still images (no Ken Burns, zoom, pan, or any other effect). Phase 5 already created the clips — your job is ONLY to concatenate them.
- If video clips are missing from video_output/clips/, STOP and report the issue. Do NOT fall back to generating clips from images.
- Combine clips in the order defined by shot_list.json. Clip durations may vary (3-10 seconds each).
- Use ffmpeg to concatenate clips and add transitions.
- IMPORTANT: Output resolution MUST be 720x1280 (portrait/vertical 9:16 format). Do NOT rescale to landscape or change the aspect ratio.
- Reference the voiceover script if available (audio can be added separately).
- Save the final video to video_output/final.mp4.
- After completion, verify file size and duration and include in your report.
