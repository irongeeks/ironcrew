[Phase: Image Generation — ComfyUI 图像生成]
- 从 video_output/shot_list.json 读取镜头列表。
- 读取 `character_descriptions`，验证每个镜头的 `positive_prompt` 是否逐字包含所有出场角色的基本描述。
- 使用每个镜头的positive_prompt通过ComfyUI text2img工作流生成图像。
- 将生成的图像保存为 video_output/images/shot_01.png, shot_02.png 等。
