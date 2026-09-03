[Phase: Planning — 搜索策略制定]

你正在设计研究策略。你的输出决定所有后续阶段的质量。

1. 分析主题，识别需要调查的关键维度。
2. 按照MECE原则分解为子问题:
   - 相互独立: 两个子问题不应调查相同的领域。
   - 完全穷尽: 合在一起必须覆盖整个主题。
   - 每个子问题必须能通过网络搜索独立调查。
3. 为每个子问题定义:
   - search_keywords: 3-5个具体搜索词 (避免通用词汇)
   - source_types: 优先考虑的来源类型 (学术、新闻、技术文档、政府、行业报告)
   - priority: 基于主题重要性的 high/medium/low
4. 考虑来源多样性: 学术、新闻、一手来源、专家意见。

保存到 research_output/search_strategy.json:
{ "topic_analysis": "...", "sub_questions": [{ "question": "...", "search_keywords": [...], "source_types": [...], "priority": "high|medium|low" }] }
