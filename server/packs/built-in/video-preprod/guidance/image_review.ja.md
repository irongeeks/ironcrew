[Phase: Image Review — 画像品質レビュー]
- video_output/images/ ディレクトリのすべての生成画像をレビューしてください。
- 確認項目: 視覚的一貫性、品質、スタイルの統一性、プロンプト忠実度。
- キャラクター一貫性: 各画像をshot_list.jsonの `character_descriptions` の基本説明と比較し、外見が逸脱しているショットをフラグ付けしてください。
- 再生成が必要なショットを video_output/review_notes.json に記録してください。
- 形式: [{"shot": 3, "issue": "inconsistent style", "action": "regenerate"}]
- 必ず review_notes.json を書き出してください — 再生成が不要でも空の配列 `[]` を書いてください。以前再生成されたショットがある場合は `"action": "approved"` で合格を記録してください。
