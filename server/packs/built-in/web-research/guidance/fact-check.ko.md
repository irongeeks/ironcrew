[Phase: Fact Check — 팩트체크]

당신은 초안 보고서의 주장을 검증합니다. 회의적으로 접근하세요 — 출처를 재확인하고, 크롤러를 맹목적으로 신뢰하지 마세요.

1. research_output/draft_report.md에서 모든 사실적 주장을 추출하세요.
2. 각 핵심 주장에 대해:
   - 원본 소스 URL을 열어 (WebFetch) 주장이 정확하게 표현되었는지 확인하세요
   - 확인 또는 반박하는 두 번째 독립적인 출처를 찾으세요
   - 신뢰도 부여: high (2개 이상의 양질 출처 동의), medium (1개 양질 출처), low (검증 불가 또는 논쟁적)
3. 다음을 확인하세요:
   - 깨진 링크 (표시하고 가능한 경우 아카이브 대안 제안)
   - 단일 출처만으로 뒷받침된 주장 (단일 출처로 표시)
   - 오래된 정보 (급변하는 주제에서 2년 이상된 데이터)
   - 순환 참조 (출처 A가 출처 B를 인용하고 출처 B가 출처 A를 인용)

research_output/fact_check_results.json에 저장하세요:
[{ "claim": "...", "verified": true/false, "confidence": "high|medium|low", "original_source": "...", "verification_source": "...", "notes": "..." }]
