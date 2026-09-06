import { useCrewLabel } from "./crew-labels";
import { useI18n } from "../i18n";
import { lazy, Suspense, useId, useState } from "react";
import { CHARACTER_SKINS } from "../shared/character-skins";
import { CharacterAvatar, resolveCharacterId } from "./CharacterAvatar";
import { buildCharacterPrompt } from "./CharacterPrompt";
import {
  AGENT_STATUS_LABEL,
  type Agent,
  type AgentStatus,
  type CharacterAsset,
  type CharacterAppearance,
  type CharacterAnimationConfig,
} from "./types";
import { CharacterAssetManager, type CharacterAssetDeletion } from "./CharacterAssetManager";
import { CharacterAnimationEditor } from "./CharacterAnimationEditor";
import "./CharacterSkinEditor.css";

export type { CharacterAppearance } from "./types";
const CharacterModelPreview = lazy(() => import("./CharacterModelPreview"));

export interface CharacterSkinEditorProps {
  agent: Agent;
  onSave: (appearance: CharacterAppearance) => Promise<void>;
  onUpload: (file: File, kind: CharacterAsset["kind"]) => Promise<string>;
  onListAssets?: () => Promise<CharacterAsset[]>;
  onDeleteAsset?: (id: string, detach: boolean) => Promise<CharacterAssetDeletion>;
  onClose?: () => void;
}

const UPLOAD_TYPES = new Set(["image/png", "image/webp", "image/jpeg"]);

const initialAppearance = (agent: Agent): CharacterAppearance => ({
  character_id: agent.persona.character_id ?? null,
  portrait: agent.persona.portrait,
  full_body: agent.persona.full_body,
  animation_config: agent.persona.animation_config ?? null,
  model_3d: agent.persona.model_3d ?? null,
});
const animationFor = (url: string, asset?: CharacterAsset): CharacterAnimationConfig => ({
  url,
  frameWidth: asset?.width || 128,
  frameHeight: asset?.height || 128,
  columns: 1,
  states: { idle: { row: 0, frames: 1, fps: 6, loop: false } },
});

export function CharacterSkinEditor({
  agent,
  onSave,
  onUpload,
  onClose,
  onListAssets,
  onDeleteAsset,
}: CharacterSkinEditorProps): React.JSX.Element {
  const { t, language } = useI18n();
  const crewLabel = useCrewLabel();
  const skins = CHARACTER_SKINS.map((skin) => ({
    ...skin,
    name: language === "de" ? skin.name : skin.name_en,
    description: language === "de" ? skin.description : skin.description_en,
  }));
  const previewStatusId = useId();
  const [draft, setDraft] = useState<CharacterAppearance>(() => initialAppearance(agent));
  const [previewStatus, setPreviewStatus] = useState<AgentStatus>(agent.status);
  const [showModel, setShowModel] = useState(false);
  const [assetsRevision, setAssetsRevision] = useState(0);
  const [identity, setIdentity] = useState("");
  const [style, setStyle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [copyFailed, setCopyFailed] = useState(false);
  const prompt = buildCharacterPrompt(identity, style, language);
  const selectedId = resolveCharacterId(draft.character_id, agent.key);

  const useAsset = (asset: CharacterAsset) => {
    setDraft((current) =>
      asset.kind === "animation"
        ? { ...current, animation_config: animationFor(asset.url, asset) }
        : { ...current, [asset.kind]: asset.url },
    );
    if (asset.kind === "model_3d") setShowModel(true);
    setNotice(
      t({
        de: "Datei ausgewählt. Vorschau prüfen und die Figur speichern.",
        en: "File selected. Check the preview and save the character.",
      }),
    );
  };
  const upload = async (file: File | undefined, kind: CharacterAsset["kind"]) => {
    if (!file) return;
    setError(null);
    setNotice("");
    if (kind === "model_3d" ? !file.name.toLowerCase().endsWith(".glb") : !UPLOAD_TYPES.has(file.type)) {
      setError(
        kind === "model_3d"
          ? t({
              de: "Bitte eine eigenständige GLB-Datei ohne Texturen auswählen.",
              en: "Select a self-contained GLB file without textures.",
            })
          : t({ de: "Bitte eine PNG-, WebP- oder JPEG-Datei auswählen.", en: "Select a PNG, WebP or JPEG file." }),
      );
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError(t({ de: "Das Bild darf höchstens 5 MiB groß sein.", en: "The image must not exceed 5 MiB." }));
      return;
    }
    setBusy(true);
    try {
      const normalized = kind === "model_3d" ? new File([file], file.name, { type: "model/gltf-binary" }) : file;
      const url = await onUpload(normalized, kind);
      const asset =
        kind === "animation" && onListAssets ? (await onListAssets()).find((item) => item.url === url) : undefined;
      setDraft((current) =>
        kind === "animation" ? { ...current, animation_config: animationFor(url, asset) } : { ...current, [kind]: url },
      );
      if (kind === "model_3d") setShowModel(true);
      setAssetsRevision((value) => value + 1);
      setNotice(
        t({
          de: "Datei hochgeladen. Vorschau prüfen und anschließend die Figur speichern.",
          en: "File uploaded. Check the preview, then save the character.",
        }),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t({ de: "Das Bild konnte nicht hochgeladen werden.", en: "Could not upload the image." }),
      );
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await onSave(draft);
      setNotice(
        t({
          de: "Figur gespeichert. Das Büro verwendet jetzt dieses Erscheinungsbild.",
          en: "Character saved. The office now uses this appearance.",
        }),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t({ de: "Die Figur konnte nicht gespeichert werden.", en: "Could not save the character." }),
      );
    } finally {
      setBusy(false);
    }
  };

  const copyPrompt = async () => {
    setCopyFailed(false);
    setNotice("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(prompt);
      setNotice(
        t({
          de: "Generator-Prompt kopiert. Im Bildmodell deiner Wahl einfügen.",
          en: "Generator prompt copied. Paste it into the image model of your choice.",
        }),
      );
    } catch {
      setCopyFailed(true);
    }
  };

  return (
    <section
      className="character-editor"
      aria-label={t({ de: `Figur für ${agent.displayName}`, en: `Character for ${agent.displayName}` })}
      aria-busy={busy}
    >
      <header className="character-editor-heading">
        <div>
          <span className="character-editor-eyebrow">{t({ de: "ERSCHEINUNGSBILD", en: "APPEARANCE" })}</span>
          <h3>
            {t({ de: "Eine Figur für", en: "A character for" })} {agent.displayName}
          </h3>
          <p>
            {t({
              de: "20 eigene Charaktere oder ein persönliches Bild. Rolle, Tools und Freigaben bleiben getrennt.",
              en: "20 original characters or a custom image. Role, tools and approvals remain separate.",
            })}
          </p>
        </div>
        {onClose && (
          <button type="button" className="ic-btn" onClick={onClose} disabled={busy}>
            {t({ de: "Zurück zum Profil", en: "Back to profile" })}{" "}
          </button>
        )}
      </header>
      <div className="character-editor-preview-row">
        <div className="character-editor-preview">
          <CharacterAvatar
            characterId={selectedId}
            fullBodyUrl={draft.full_body}
            animation={draft.animation_config}
            status={previewStatus}
            className="character-editor-preview-figure"
            label={t({ de: "Vorschau der Bürofigur", en: "Office character preview" })}
          />
          <span>{t({ de: "Bürofigur", en: "Office character" })}</span>
        </div>
        <div className="character-editor-portrait">
          <CharacterAvatar
            characterId={selectedId}
            fullBodyUrl={draft.full_body}
            portraitUrl={draft.portrait}
            mode="portrait"
            label={t({ de: "Vorschau des Portraits", en: "Portrait preview" })}
          />
          <span>Portrait</span>
        </div>
        <div className="character-editor-preview-copy">
          <strong>
            {draft.full_body
              ? t({ de: "Eigenes Bild", en: "Custom image" })
              : skins.find((skin) => skin.id === selectedId)?.name}
          </strong>
          <p>
            {draft.full_body
              ? t({
                  de: "Das vollständige Bild wird im Büro verwendet; Status und Aufgaben kommen weiterhin vom Control Plane.",
                  en: "The full image is used in the office; status and tasks still come from the control plane.",
                })
              : skins.find((skin) => skin.id === selectedId)?.description}
          </p>
          <p className="character-editor-hint">
            {t({
              de: "Die Auswahl ist eine Vorschau, bis du speicherst.",
              en: "Your selection is a preview until you save it.",
            })}
          </p>
        </div>
      </div>
      {(draft.animation_config || draft.model_3d) && (
        <div className="character-preview-status">
          <label htmlFor={previewStatusId}>{t({ de: "Vorschauzustand", en: "Preview state" })}</label>
          <select
            id={previewStatusId}
            value={previewStatus}
            onChange={(event) => setPreviewStatus(event.target.value as AgentStatus)}
          >
            {(Object.entries(AGENT_STATUS_LABEL) as [AgentStatus, string][]).map(([value, label]) => (
              <option key={value} value={value}>
                {crewLabel(label)}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && (
        <p className="character-editor-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="character-editor-notice" role="status">
          {notice}
        </p>
      )}
      <fieldset disabled={busy} className="character-editor-fieldset">
        <legend>{t({ de: "Charakter auswählen", en: "Select character" })}</legend>
        <div
          className="character-editor-gallery"
          role="group"
          aria-label={t({ de: "Vordefinierte Charaktere", en: "Preset characters" })}
        >
          {skins.map((skin) => (
            <button
              key={skin.id}
              type="button"
              aria-pressed={selectedId === skin.id && !draft.full_body}
              aria-label={`${skin.name}: ${skin.description}`}
              title={skin.description}
              className="character-editor-choice"
              onClick={() => {
                setDraft({
                  character_id: skin.id,
                  portrait: null,
                  full_body: null,
                  animation_config: null,
                  model_3d: null,
                });
                setShowModel(false);
                setNotice("");
                setError(null);
              }}
            >
              <CharacterAvatar characterId={skin.id} className="character-editor-choice-figure" />
              <strong>{skin.name}</strong>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={busy} className="character-editor-fieldset">
        <legend>
          {t({ de: "Eigene Animation oder optionales 3D-Modell", en: "Custom animation or optional 3D model" })}
        </legend>
        <p className="character-editor-hint">
          {t({
            de: "Animation: ein Bildraster als PNG, WebP oder JPEG. 3D: eigenständige GLB-2-Datei ohne Texturen, externe Dateien oder Erweiterungen. Maximal 5 MiB. 2D bleibt die Büroansicht.",
            en: "Animation: a PNG, WebP or JPEG sprite sheet. 3D: a self-contained GLB 2 file without textures, external files or extensions. Maximum 5 MiB. The office view remains 2D.",
          })}{" "}
        </p>
        <div className="character-editor-upload-grid">
          <label>
            {t({ de: "Animationsraster hochladen", en: "Upload sprite sheet" })}{" "}
            <input
              type="file"
              accept="image/png,image/webp,image/jpeg"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                void upload(file, "animation");
              }}
            />
          </label>
          <label>
            {t({ de: "GLB-Modell hochladen", en: "Upload GLB model" })}{" "}
            <input
              type="file"
              accept=".glb,model/gltf-binary"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                void upload(file, "model_3d");
              }}
            />
          </label>
        </div>
      </fieldset>
      {draft.animation_config && (
        <>
          <CharacterAnimationEditor
            config={draft.animation_config}
            disabled={busy}
            onChange={(animation_config) => setDraft((current) => ({ ...current, animation_config }))}
          />
          <button
            className="ic-btn"
            type="button"
            disabled={busy}
            onClick={() => setDraft((current) => ({ ...current, animation_config: null }))}
          >
            {t({ de: "Animationszuordnung entfernen", en: "Remove animation assignment" })}{" "}
          </button>
        </>
      )}
      {draft.model_3d && (
        <div className="character-editor-model">
          <button className="ic-btn" type="button" onClick={() => setShowModel((value) => !value)}>
            {showModel
              ? t({ de: "3D-Vorschau schließen", en: "Close 3D preview" })
              : t({ de: "3D-Modell ansehen", en: "View 3D model" })}
          </button>
          <button
            className="ic-btn"
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft((current) => ({ ...current, model_3d: null }));
              setShowModel(false);
            }}
          >
            {t({ de: "3D-Zuordnung entfernen", en: "Remove 3D assignment" })}{" "}
          </button>
          {showModel && (
            <Suspense
              fallback={<p role="status">{t({ de: "3D-Ansicht wird vorbereitet …", en: "Preparing 3D view …" })}</p>}
            >
              <CharacterModelPreview
                url={draft.model_3d}
                status={previewStatus}
                fallback={
                  <CharacterAvatar
                    characterId={selectedId}
                    fullBodyUrl={draft.full_body}
                    className="character-editor-preview-figure"
                    label={t({ de: "2D-Ersatzfigur", en: "2D fallback character" })}
                  />
                }
              />
            </Suspense>
          )}
        </div>
      )}
      {onListAssets && onDeleteAsset && (
        <CharacterAssetManager
          onList={onListAssets}
          onDelete={onDeleteAsset}
          onUse={useAsset}
          refreshKey={assetsRevision}
          onRemoved={(asset) =>
            setDraft((current) => ({
              ...current,
              portrait: current.portrait === asset.url ? null : current.portrait,
              full_body: current.full_body === asset.url ? null : current.full_body,
              model_3d: current.model_3d === asset.url ? null : current.model_3d,
              animation_config: current.animation_config?.url === asset.url ? null : current.animation_config,
            }))
          }
        />
      )}
      <fieldset disabled={busy} className="character-editor-fieldset">
        <legend>{t({ de: "Eigene Bilder verwenden", en: "Use custom images" })}</legend>
        <p className="character-editor-hint">
          {t({
            de: "PNG oder WebP mit transparentem Hintergrund empfohlen; JPEG ebenfalls möglich. Maximal 5 MiB und 4096 × 4096 Pixel. Die Bilder werden privat gespeichert.",
            en: "PNG or WebP with a transparent background is recommended; JPEG is also supported. Maximum 5 MiB and 4096 × 4096 pixels. Images are stored privately.",
          })}{" "}
        </p>
        <div className="character-editor-upload-grid">
          {(["full_body", "portrait"] as const).map((kind) => (
            <label key={kind}>
              <span>
                {kind === "full_body"
                  ? t({ de: "Ganzkörperbild für das Büro", en: "Full-body image for the office" })
                  : t({ de: "Portrait für das Profil", en: "Portrait for the profile" })}
              </span>
              <input
                type="file"
                accept="image/png,image/webp,image/jpeg"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  void upload(file, kind);
                }}
              />
            </label>
          ))}
        </div>
        {(draft.full_body || draft.portrait) && (
          <button
            type="button"
            className="ic-btn"
            onClick={() => {
              setDraft((current) => ({ ...current, full_body: null, portrait: null }));
              setNotice("");
            }}
          >
            {t({ de: "Eigene Bilder aus der Auswahl entfernen", en: "Remove custom images from selection" })}{" "}
          </button>
        )}
      </fieldset>
      <details className="character-editor-prompt">
        <summary>
          {t({ de: "Prompt für eine eigene Figur erstellen", en: "Create a prompt for a custom character" })}
        </summary>
        <p>
          {t({
            de: "Beschreibe die gewünschte Person, Filmfigur oder ein eigenes Wesen. Du kannst dem Bildmodell zusätzlich Referenzbilder geben. IronCrew erstellt hier den Prompt; das Bild erzeugst du im Modell deiner Wahl und lädst es anschließend hoch.",
            en: "Describe the person, film character or original creature you want. You can also give the image model reference images. IronCrew creates the prompt here; generate the image with your chosen model, then upload it.",
          })}{" "}
        </p>
        <label>
          <span>{t({ de: "Gewünschte Figur oder Referenz", en: "Desired character or reference" })}</span>
          <textarea
            value={identity}
            onChange={(event) => setIdentity(event.target.value)}
            rows={3}
            placeholder={t({
              de: "Zum Beispiel Pamela Anderson, Captain America, ein Alien oder eine eigene Figur – dazu Kleidung, Alter, Frisur und gewünschte Details.",
              en: "For example Pamela Anderson, Captain America, an alien or an original character — with clothing, age, hairstyle and desired details.",
            })}
          />
        </label>
        <label>
          <span>{t({ de: "Zusätzliche Stilwünsche (optional)", en: "Additional style preferences (optional)" })}</span>
          <textarea
            value={style}
            onChange={(event) => setStyle(event.target.value)}
            rows={2}
            placeholder={t({
              de: "Modern illustriert, natürliche Proportionen, klare Silhouette, dezente Lichtkanten …",
              en: "Modern illustration, natural proportions, clear silhouette, subtle rim lighting …",
            })}
          />
        </label>
        <label>
          <span>{t({ de: "Generator-Prompt", en: "Generator prompt" })}</span>
          <textarea
            className="character-editor-prompt-output"
            aria-label={t({ de: "Generator-Prompt", en: "Generator prompt" })}
            value={prompt}
            readOnly
            rows={10}
            onFocus={(event) => event.target.select()}
          />
        </label>
        <button type="button" className="ic-btn" onClick={() => void copyPrompt()}>
          {t({ de: "Generator-Prompt kopieren", en: "Copy generator prompt" })}{" "}
        </button>
        {copyFailed && (
          <p role="status" className="character-editor-hint">
            {t({
              de: "Die Zwischenablage ist hier nicht verfügbar. Den Prompt im Textfeld markieren und kopieren.",
              en: "The clipboard is unavailable here. Select and copy the prompt in the text field.",
            })}{" "}
          </p>
        )}
      </details>
      <footer className="character-editor-actions">
        <button type="button" className="ic-btn" data-variant="primary" onClick={() => void save()} disabled={busy}>
          {busy
            ? t({ de: "Wird verarbeitet …", en: "Processing …" })
            : t({ de: "Figur speichern", en: "Save character" })}
        </button>
        <button
          type="button"
          className="ic-btn"
          disabled={busy}
          onClick={() => {
            setDraft(initialAppearance(agent));
            setError(null);
            setNotice(t({ de: "Auswahl zurückgesetzt.", en: "Selection reset." }));
          }}
        >
          {t({ de: "Änderungen verwerfen", en: "Discard changes" })}{" "}
        </button>
      </footer>
    </section>
  );
}
