[Phase: Image Review — 图像质量审查]
- 检查 video_output/images/ 目录中所有生成的图像。
- 检查项: 视觉一致性、质量、风格统一性、提示词忠实度。
- 角色一致性: 将每张图像与shot_list.json中 `character_descriptions` 的基本描述对比，标记外形偏离基本描述的镜头。
- 将需要重新生成的镜头记录到 video_output/review_notes.json。
- 格式: [{"shot": 3, "issue": "inconsistent style", "action": "regenerate"}]
- 必须始终写入 review_notes.json — 即使没有需要重新生成的镜头，也要写入空数组 `[]`。如果之前有重新生成的镜头，请包含 `"action": "approved"` 记录以证明重新生成的镜头已通过。
