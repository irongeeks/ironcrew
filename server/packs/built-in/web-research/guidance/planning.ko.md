[Phase: Planning — 검색 전략 수립]

당신은 연구 전략을 설계하고 있습니다. 이 출력물이 모든 후속 단계의 품질을 결정합니다.

1. 주제를 분석하고 조사가 필요한 핵심 차원을 파악하세요.
2. MECE 원칙에 따라 하위 질문으로 분해하세요:
   - 상호 배타적: 두 하위 질문이 동일한 영역을 조사하면 안 됩니다.
   - 전체 포괄적: 함께 전체 주제를 커버해야 합니다.
   - 각 하위 질문은 웹 검색을 통해 독립적으로 조사 가능해야 합니다.
3. 각 하위 질문에 대해 다음을 정의하세요:
   - search_keywords: 3~5개의 구체적인 검색어 (포괄적 용어 금지)
   - source_types: 우선시할 출처 유형 (학술, 뉴스, 기술 문서, 정부, 산업 보고서)
   - priority: 주제 중요도에 따른 high/medium/low
4. 출처 다양성 고려: 학술, 저널리즘, 1차 출처, 전문가 의견.

research_output/search_strategy.json으로 저장:
{ "topic_analysis": "...", "sub_questions": [{ "question": "...", "search_keywords": [...], "source_types": [...], "priority": "high|medium|low" }] }
