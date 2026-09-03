# ComfyUI Generate Node

Generate images, videos, or speech audio via a connected ComfyUI server.

## When to Use

- Generating images from text prompts in a video/design production pipeline
- Animating still images into video clips (img2video)
- Synthesizing speech audio from text (text2speech with Chatterbox TTS)
- Any pack phase that needs automated media generation without an agent

## Prerequisites

A ComfyUI server must be configured in **Settings > Connectors** with the appropriate workflows loaded. The node delegates to the `ConnectorRegistry` — it does not talk to ComfyUI directly.

## Configuration

| Key | Type | Default | Options | Description |
|-----|------|---------|---------|-------------|
| `capability` | select | `text2img` | `text2img`, `img2video`, `text2speech` | Which ComfyUI capability to invoke. |
| `width` | number | — | 64–4096 | Output width in pixels (text2img only). |
| `height` | number | — | 64–4096 | Output height in pixels (text2img only). |
| `seed` | number | `-1` | — | Random seed for reproducibility. `-1` = random. |

## Inputs

| Port | Type | Required | Description |
|------|------|----------|-------------|
| `prompt` | string | Yes | Positive text prompt. For `text2speech`, this is the text to synthesize. |
| `negative_prompt` | string | No | What to avoid (text2img/img2video only). |
| `input_image` | image | No | Source image path for img2video. |
| `language` | string | No | Language for text2speech (e.g. `"German (de)"`). |
| `exaggeration` | number | No | Expressiveness level for text2speech (default 0.7). |
| `audio_prompt` | string | No | Reference audio filename for voice cloning (text2speech). |

## Outputs

| Port | Type | Description |
|------|------|-------------|
| `artifacts` | json | Array of `{ path, type, metadata }` for each generated file. |
| `primary_path` | string | File path of the first generated artifact. |

## Example pack.yaml

```yaml
phases:
  - id: generate_shot
    department: design
    guidance: guidance/generate.en.md
    node_type: comfyui_generate
    node_config:
      capability: text2img
      width: 1024
      height: 768
      seed: -1
    inputs:
      - name: prompt
        from: screenplay.positive_prompt
    outputs:
      - name: artifacts
        type: json
        path: output/shots/artifacts.json
      - name: primary_path
        type: string
        path: output/shots/primary_path.txt
```

## Common Issues

- **"No binding configured"**: The ComfyUI server URL is not set in Settings. Go to Settings > Connectors and configure `comfyui_server_url`.
- **`text2speech` sends wrong field**: The node automatically maps `prompt` to `text` for the text2speech capability. If you see errors, check that the ComfyUI workflow has a Chatterbox TTS node configured.
- **Timeout**: Large generations may exceed the default 300s timeout. Adjust `timeout_ms` in the connector binding settings.
