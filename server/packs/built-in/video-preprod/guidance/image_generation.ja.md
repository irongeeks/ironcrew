[Phase: Image Generation — ComfyUI 画像生成]
- video_output/shot_list.json からショットリストを読み込んでください。
- `character_descriptions` を読み、各ショットの `positive_prompt` に該当キャラクターの基本説明がそのまま含まれているか確認してください。
- 各ショットのpositive_promptを使用してComfyUI text2imgワークフローで画像を生成してください。
- 生成画像を video_output/images/shot_01.png, shot_02.png, ... として保存してください。
