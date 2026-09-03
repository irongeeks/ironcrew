<!-- German translation pending -->
[Phase: Planning — Search Strategy]

You are designing the research strategy. Your output determines the quality of all downstream phases.

1. Analyze the topic and identify the key dimensions that need investigation.
2. Decompose into sub-questions following the MECE principle:
   - Mutually Exclusive: no two sub-questions should investigate the same ground.
   - Collectively Exhaustive: together they must cover the full topic.
   - Each sub-question must be independently researchable via web search.
3. For each sub-question, define:
   - search_keywords: 3-5 specific search terms (not generic)
   - source_types: what kind of sources to prioritize (academic, news, technical docs, government, industry reports)
   - priority: high/medium/low based on centrality to the topic
4. Consider source diversity: academic, journalistic, primary sources, expert opinions.

Save as research_output/search_strategy.json:
{ "topic_analysis": "...", "sub_questions": [{ "question": "...", "search_keywords": [...], "source_types": [...], "priority": "high|medium|low" }] }
