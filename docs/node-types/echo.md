# Echo Node

Passes all inputs through to outputs unchanged.

## When to Use

- Testing and debugging workflow pipelines
- Verifying that upstream phases produce expected artifacts
- Inserting a no-op step between phases for logging purposes

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `label` | string | `""` | Optional label that appears in the task log when this node runs. |

## Inputs

| Port | Type | Required | Description |
|------|------|----------|-------------|
| `data` | json | No | Any data to pass through. Outputs an empty object if not connected. |

## Outputs

| Port | Type | Description |
|------|------|-------------|
| `data` | json | The same data that was received on the input port. |

## Example pack.yaml

```yaml
phases:
  - id: debug_checkpoint
    department: dev
    guidance: guidance/debug.en.md
    node_type: echo
    node_config:
      label: "Checkpoint after planning"
    inputs:
      - name: data
        from: planning.plan
    outputs:
      - name: data
        type: json
        path: output/debug/checkpoint.json
```

## Common Issues

- **Empty output**: If no input is connected, `data` outputs `{}`. This is intentional.
- **Non-JSON inputs**: String inputs are passed through as-is; they are not parsed.
