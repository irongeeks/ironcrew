[Phase: Video Generation — ComfyUI 视频生成]
- 使用 video_output/images/ 目录中的图像。
- 读取 video_output/shot_list.json，使用每个镜头的motion_prompt作为img2video工作流的文本提示。
- motion_prompt是LTX风格的I2V提示，仅描述动作/运动。不要在motion_prompt前添加场景描述或角色外形 — 源图像中已包含这些信息。
- 如果镜头没有motion_prompt，使用默认提示"subtle gentle motion"。
- 如果工作流参数映射中包含 `num_frames` 参数，根据镜头的duration_seconds计算: `num_frames = duration_seconds × 24 + 1`。否则使用工作流默认值。
- 使用ComfyUI img2video工作流将每张图像转换为视频片段。
- 将生成的片段保存为 video_output/clips/shot_01.mp4, shot_02.mp4 等。
- 每个片段最长约10秒（24fps下最多257帧）。
