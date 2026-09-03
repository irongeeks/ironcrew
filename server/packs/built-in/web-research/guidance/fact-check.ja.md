[Phase: Fact Check — ファクトチェック]

あなたはドラフトレポートの主張を検証します。懐疑的に — ソースを再確認し、クローラーを盲目的に信頼しないでください。

1. research_output/draft_report.md からすべての事実的主張を抽出してください。
2. 各重要な主張について:
   - 元のソースURL を開き (WebFetch)、主張が正確に表現されているか確認してください
   - 確認または反証する2番目の独立したソースを探してください
   - 信頼度を割り当てる: high (2つ以上の良質ソースが同意), medium (1つの良質ソース), low (検証不能または争点あり)
3. 以下を確認してください:
   - 壊れたリンク (記録し、可能であればアーカイブの代替を提案)
   - 単一ソースのみで裏付けられた主張 (単一ソースとしてフラグ)
   - 古い情報 (急速に変化するトピックで2年以上前のデータ)
   - 循環参照 (ソースAがソースBを引用し、ソースBがソースAを引用)

research_output/fact_check_results.json に保存:
[{ "claim": "...", "verified": true/false, "confidence": "high|medium|low", "original_source": "...", "verification_source": "...", "notes": "..." }]
