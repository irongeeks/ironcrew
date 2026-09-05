import { useState } from "react";
import { CHARACTER_SKINS } from "../shared/character-skins";
import { CharacterAvatar, resolveCharacterId } from "./CharacterAvatar";
import { buildCharacterPrompt } from "./CharacterPrompt";
import type { Agent } from "./types";
import "./CharacterSkinEditor.css";

export interface CharacterAppearance {
  character_id: string | null;
  portrait: string | null;
  full_body: string | null;
}

export interface CharacterSkinEditorProps {
  agent: Agent;
  onSave: (appearance: CharacterAppearance) => Promise<void>;
  onUpload: (file: File, kind: "portrait" | "full_body") => Promise<string>;
  onClose?: () => void;
}

const UPLOAD_TYPES = new Set(["image/png", "image/webp", "image/jpeg"]);

export function CharacterSkinEditor({ agent, onSave, onUpload, onClose }: CharacterSkinEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState<CharacterAppearance>(() => ({
    character_id: agent.persona.character_id ?? null,
    portrait: agent.persona.portrait,
    full_body: agent.persona.full_body,
  }));
  const [identity, setIdentity] = useState("");
  const [style, setStyle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [copyFailed, setCopyFailed] = useState(false);
  const prompt = buildCharacterPrompt(identity, style);
  const selectedId = resolveCharacterId(draft.character_id, agent.key);

  const upload = async (file: File | undefined, kind: "portrait" | "full_body") => {
    if (!file) return;
    setError(null);
    setNotice("");
    if (!UPLOAD_TYPES.has(file.type)) {
      setError("Bitte eine PNG-, WebP- oder JPEG-Datei auswählen.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("Das Bild darf höchstens 5 MiB groß sein.");
      return;
    }
    setBusy(true);
    try {
      const url = await onUpload(file, kind);
      setDraft((current) => ({ ...current, [kind]: url }));
      setNotice("Bild hochgeladen. Vorschau prüfen und anschließend die Figur speichern.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Das Bild konnte nicht hochgeladen werden.");
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
      setNotice("Figur gespeichert. Das Büro verwendet jetzt dieses Erscheinungsbild.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Die Figur konnte nicht gespeichert werden.");
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
      setNotice("Generator-Prompt kopiert. Im Bildmodell deiner Wahl einfügen.");
    } catch {
      setCopyFailed(true);
    }
  };

  return (
    <section className="character-editor" aria-label={`Figur für ${agent.displayName}`} aria-busy={busy}>
      <header className="character-editor-heading">
        <div>
          <span className="character-editor-eyebrow">ERSCHEINUNGSBILD</span>
          <h3>Eine Figur für {agent.displayName}</h3>
          <p>20 eigene Charaktere oder ein persönliches Bild. Rolle, Tools und Freigaben bleiben getrennt.</p>
        </div>
        {onClose && (
          <button type="button" className="ic-btn" onClick={onClose} disabled={busy}>
            Zurück zum Profil
          </button>
        )}
      </header>
      <div className="character-editor-preview-row">
        <div className="character-editor-preview">
          <CharacterAvatar
            characterId={selectedId}
            fullBodyUrl={draft.full_body}
            className="character-editor-preview-figure"
            label="Vorschau der Bürofigur"
          />
          <span>Bürofigur</span>
        </div>
        <div className="character-editor-portrait">
          <CharacterAvatar
            characterId={selectedId}
            fullBodyUrl={draft.full_body}
            portraitUrl={draft.portrait}
            mode="portrait"
            label="Vorschau des Portraits"
          />
          <span>Portrait</span>
        </div>
        <div className="character-editor-preview-copy">
          <strong>
            {draft.full_body ? "Eigenes Bild" : CHARACTER_SKINS.find((skin) => skin.id === selectedId)?.name}
          </strong>
          <p>
            {draft.full_body
              ? "Das vollständige Bild wird im Büro verwendet; Status und Aufgaben kommen weiterhin vom Control Plane."
              : CHARACTER_SKINS.find((skin) => skin.id === selectedId)?.description}
          </p>
          <p className="character-editor-hint">Die Auswahl ist eine Vorschau, bis du speicherst.</p>
        </div>
      </div>
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
        <legend>Charakter auswählen</legend>
        <div className="character-editor-gallery" role="group" aria-label="Vordefinierte Charaktere">
          {CHARACTER_SKINS.map((skin) => (
            <button
              key={skin.id}
              type="button"
              aria-pressed={selectedId === skin.id && !draft.full_body}
              aria-label={`${skin.name}: ${skin.description}`}
              title={skin.description}
              className="character-editor-choice"
              onClick={() => {
                setDraft({ character_id: skin.id, portrait: null, full_body: null });
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
        <legend>Eigene Bilder verwenden</legend>
        <p className="character-editor-hint">
          PNG oder WebP mit transparentem Hintergrund empfohlen; JPEG ebenfalls möglich. Maximal 5 MiB und 4096 × 4096
          Pixel. Die Bilder werden privat gespeichert.
        </p>
        <div className="character-editor-upload-grid">
          {(["full_body", "portrait"] as const).map((kind) => (
            <label key={kind}>
              <span>{kind === "full_body" ? "Ganzkörperbild für das Büro" : "Portrait für das Profil"}</span>
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
            Eigene Bilder aus der Auswahl entfernen
          </button>
        )}
      </fieldset>
      <details className="character-editor-prompt">
        <summary>Prompt für eine eigene Figur erstellen</summary>
        <p>
          Beschreibe die gewünschte Person, Filmfigur oder ein eigenes Wesen. Du kannst dem Bildmodell zusätzlich
          Referenzbilder geben. IronCrew erstellt hier den Prompt; das Bild erzeugst du im Modell deiner Wahl und lädst
          es anschließend hoch.
        </p>
        <label>
          <span>Gewünschte Figur oder Referenz</span>
          <textarea
            value={identity}
            onChange={(event) => setIdentity(event.target.value)}
            rows={3}
            placeholder="Zum Beispiel Pamela Anderson, Captain America, ein Alien oder eine eigene Figur – dazu Kleidung, Alter, Frisur und gewünschte Details."
          />
        </label>
        <label>
          <span>Zusätzliche Stilwünsche (optional)</span>
          <textarea
            value={style}
            onChange={(event) => setStyle(event.target.value)}
            rows={2}
            placeholder="Modern illustriert, natürliche Proportionen, klare Silhouette, dezente Lichtkanten …"
          />
        </label>
        <label>
          <span>Generator-Prompt</span>
          <textarea
            className="character-editor-prompt-output"
            aria-label="Generator-Prompt"
            value={prompt}
            readOnly
            rows={10}
            onFocus={(event) => event.target.select()}
          />
        </label>
        <button type="button" className="ic-btn" onClick={() => void copyPrompt()}>
          Generator-Prompt kopieren
        </button>
        {copyFailed && (
          <p role="status" className="character-editor-hint">
            Die Zwischenablage ist hier nicht verfügbar. Den Prompt im Textfeld markieren und kopieren.
          </p>
        )}
      </details>
      <footer className="character-editor-actions">
        <button type="button" className="ic-btn" data-variant="primary" onClick={() => void save()} disabled={busy}>
          {busy ? "Wird verarbeitet …" : "Figur speichern"}
        </button>
        <button
          type="button"
          className="ic-btn"
          disabled={busy}
          onClick={() => {
            setDraft({
              character_id: agent.persona.character_id ?? null,
              portrait: agent.persona.portrait,
              full_body: agent.persona.full_body,
            });
            setError(null);
            setNotice("Auswahl zurückgesetzt.");
          }}
        >
          Änderungen verwerfen
        </button>
      </footer>
    </section>
  );
}
