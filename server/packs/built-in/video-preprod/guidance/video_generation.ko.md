[Phase: Video Generation — ComfyUI 비디오 생성]
- video_output/images/ 디렉토리의 이미지를 사용하세요.
- video_output/shot_list.json을 읽고 각 샷의 motion_prompt를 img2video 워크플로우의 텍스트 프롬프트로 사용하세요.
- motion_prompt는 LTX 스타일 I2V 프롬프트로, 동작/액션만 설명합니다. 장면 설명이나 캐릭터 외형을 motion_prompt 앞에 추가하지 마세요 — 소스 이미지에 이미 포함되어 있습니다.
- motion_prompt가 없는 샷은 "subtle gentle motion"을 기본 프롬프트로 사용하세요.
- 워크플로우 파라미터 매핑에 `num_frames` 파라미터가 있으면, 샷의 duration_seconds에서 계산: `num_frames = duration_seconds × 24 + 1`. 없으면 워크플로우 기본값을 사용.
- ComfyUI img2video 워크플로우로 각 이미지를 비디오 클립으로 변환하세요.
- 생성된 클립을 video_output/clips/shot_01.mp4, shot_02.mp4, ... 형식으로 저장하세요.
- 각 클립은 최대 ~10초 (24fps에서 최대 257프레임).
