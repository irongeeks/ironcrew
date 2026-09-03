[Phase: Video Generation — ComfyUI ビデオ生成]
- video_output/images/ ディレクトリの画像を使用してください。
- video_output/shot_list.json を読み、各ショットのmotion_promptをimg2videoワークフローのテキストプロンプトとして使用してください。
- motion_promptはLTXスタイルのI2Vプロンプトで、動作/アクションのみを記述します。シーン説明やキャラクター外見をmotion_promptの前に追加しないでください — ソース画像に含まれています。
- motion_promptがないショットは「subtle gentle motion」をデフォルトプロンプトとして使用。
- ワークフローパラメータマッピングに `num_frames` がある場合、ショットのduration_secondsから計算: `num_frames = duration_seconds × 24 + 1`。なければワークフローのデフォルト値を使用。
- ComfyUI img2videoワークフローで各画像をビデオクリップに変換してください。
- 生成クリップを video_output/clips/shot_01.mp4, shot_02.mp4, ... として保存。
- 各クリップは最大約10秒（24fpsで最大257フレーム）。
