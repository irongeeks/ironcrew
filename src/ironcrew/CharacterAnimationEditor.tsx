import { useCrewLabel } from "./crew-labels";
import { useI18n } from "../i18n";
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
  const { t } = useI18n();
  const crewLabel = useCrewLabel();
  const field = (name: "frameWidth" | "frameHeight" | "columns", value: string) =>
    onChange({ ...config, [name]: Math.max(1, Number(value) || 1) });
  return (
    <fieldset className="character-editor-fieldset" disabled={disabled}>
      <legend>{t({ de: "Animationsraster und Statuszeilen", en: "Sprite sheet and status rows" })}</legend>
      <p className="character-editor-hint">
        {t({
          de: "Jede Zeile enthält die Frames eines Systemzustands von links nach rechts. Die Zuordnung wird beim Speichern gegen die Bildgröße geprüft. Ohne eigene Statuszeile dient „Bereit“ als Ersatz.",
          en: "Each row contains the frames for a system state from left to right. The mapping is checked against image dimensions when you save. Without a dedicated status row, “Ready” is used as the fallback.",
        })}{" "}
      </p>
      <div className="character-animation-dimensions">
        <label>
          {t({ de: "Framebreite in Pixel", en: "Frame width in pixels" })}{" "}
          <input
            type="number"
            min="1"
            max="4096"
            value={config.frameWidth}
            onChange={(event) => field("frameWidth", event.target.value)}
          />
        </label>
        <label>
          {t({ de: "Framehöhe in Pixel", en: "Frame height in pixels" })}{" "}
          <input
            type="number"
            min="1"
            max="4096"
            value={config.frameHeight}
            onChange={(event) => field("frameHeight", event.target.value)}
          />
        </label>
        <label>
          {t({ de: "Spalten", en: "Columns" })}{" "}
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
                {crewLabel(label)}
              </label>
              {clip && (
                <>
                  <label>
                    {t({ de: "Zeile (ab 0)", en: "Row (starting at 0)" })}{" "}
                    <input
                      aria-label={`${crewLabel(label)}: Zeile`}
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
                      aria-label={`${crewLabel(label)}: Frames`}
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
                      aria-label={`${crewLabel(label)}: FPS`}
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
                    {t({ de: "Wiederholen", en: "Loop" })}{" "}
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
