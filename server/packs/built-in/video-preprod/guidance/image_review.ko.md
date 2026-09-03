[Phase: Image Review — 이미지 품질 검수]
- video_output/images/ 디렉토리의 모든 생성 이미지를 검토하세요.
- 확인 항목: 시각적 일관성, 품질, 스타일 통일성, 프롬프트 충실도.
- 캐릭터 일관성: 각 이미지를 `character_descriptions`의 기본 설명과 비교하여 외형이 일탈한 샷을 표시하세요.
- 재생성이 필요한 샷을 video_output/review_notes.json에 기록하세요.
- 형식: [{"shot": 3, "issue": "inconsistent style", "action": "regenerate"}]
- 항상 review_notes.json을 작성하세요 — 재생성이 필요한 샷이 없어도 빈 배열 `[]`을 작성하세요. 이전에 재생성된 샷이 있다면 `"action": "approved"`로 통과 여부를 기록하세요.
