import { AGENT_STATUS_LABEL, type AgentStatus, type CharacterAnimationConfig } from "./types";

export function CharacterAnimationEditor({
  config,
  onChange,
  disabled,
}: {
  config: CharacterAnimationConfig;
  onChange: (config: CharacterAnimationConfig) => void;
  disabled: boolean;
}): React.JSX.Element {
  const field = (name: "frameWidth" | "frameHeight" | "columns", value: string) =>
    onChange({ ...config, [name]: Math.max(1, Number(value) || 1) });
  return (
    <fieldset className="character-editor-fieldset" disabled={disabled}>
      <legend>Animationsraster und Statuszeilen</legend>
      <p className="character-editor-hint">
        Jede Zeile enthält die Frames eines Systemzustands von links nach rechts. Die Zuordnung wird beim Speichern
        gegen die Bildgröße geprüft. Ohne eigene Statuszeile dient „Bereit“ als Ersatz.
      </p>
      <div className="character-animation-dimensions">
        <label>
          Framebreite in Pixel
          <input
            type="number"
            min="1"
            max="4096"
            value={config.frameWidth}
            onChange={(event) => field("frameWidth", event.target.value)}
          />
        </label>
        <label>
          Framehöhe in Pixel
          <input
            type="number"
            min="1"
            max="4096"
            value={config.frameHeight}
            onChange={(event) => field("frameHeight", event.target.value)}
          />
        </label>
        <label>
          Spalten
          <input
            type="number"
            min="1"
            max="64"
            value={config.columns}
            onChange={(event) => field("columns", event.target.value)}
          />
        </label>
      </div>
      <div className="character-animation-states">
        {(Object.entries(AGENT_STATUS_LABEL) as [AgentStatus, string][]).map(([status, label]) => {
          const clip = config.states[status];
          const update = (values: Partial<NonNullable<typeof clip>>) => {
            if (clip) onChange({ ...config, states: { ...config.states, [status]: { ...clip, ...values } } });
          };
          return (
            <div key={status} className="character-animation-state">
              <label className="character-animation-toggle">
                <input
                  type="checkbox"
                  checked={!!clip}
                  onChange={(event) => {
                    const states = { ...config.states };
                    if (event.target.checked) states[status] = { row: 0, frames: 1, fps: 6, loop: status !== "error" };
                    else delete states[status];
                    onChange({ ...config, states });
                  }}
                />
                {label}
              </label>
              {clip && (
                <>
                  <label>
                    Zeile (ab 0)
                    <input
                      aria-label={`${label}: Zeile`}
                      type="number"
                      min="0"
                      max="255"
                      value={clip.row}
                      onChange={(event) => update({ row: Math.max(0, Number(event.target.value) || 0) })}
                    />
                  </label>
                  <label>
                    Frames
                    <input
                      aria-label={`${label}: Frames`}
                      type="number"
                      min="1"
                      max={Math.min(64, config.columns)}
                      value={clip.frames}
                      onChange={(event) =>
                        update({ frames: Math.min(64, config.columns, Math.max(1, Number(event.target.value) || 1)) })
                      }
                    />
                  </label>
                  <label>
                    FPS
                    <input
                      aria-label={`${label}: FPS`}
                      type="number"
                      min="1"
                      max="30"
                      value={clip.fps}
                      onChange={(event) => update({ fps: Math.min(30, Math.max(1, Number(event.target.value) || 1)) })}
                    />
                  </label>
                  <label className="character-animation-toggle">
                    <input
                      type="checkbox"
                      checked={clip.loop && status !== "error"}
                      disabled={status === "error"}
                      onChange={(event) => update({ loop: event.target.checked })}
                    />
                    Wiederholen
                  </label>
                </>
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
