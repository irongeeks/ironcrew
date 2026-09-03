[Phase: Image Generation — ComfyUI 이미지 생성]
- video_output/shot_list.json에서 샷 리스트를 읽어오세요.
- `character_descriptions`를 읽고, 각 샷의 `positive_prompt`에 해당 캐릭터의 기본 설명이 그대로 포함되어 있는지 확인하세요.
- 각 샷의 positive_prompt를 사용하여 ComfyUI text2img 워크플로우로 이미지를 생성하세요.
- 생성된 이미지를 video_output/images/shot_01.png, shot_02.png, ... 형식으로 저장하세요.
