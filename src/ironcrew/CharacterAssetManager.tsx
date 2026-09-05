import { useCallback, useEffect, useState } from "react";
import type { CharacterAsset } from "./types";

export interface CharacterAssetDeletion {
  deleted: boolean;
  pending: boolean;
  detachedAgentIds: string[];
}
export interface CharacterAssetManagerProps {
  onList: () => Promise<CharacterAsset[]>;
  onDelete: (id: string, detach: boolean) => Promise<CharacterAssetDeletion>;
  onUse: (asset: CharacterAsset) => void;
  onRemoved: (asset: CharacterAsset) => void;
  refreshKey: number;
}

const KIND_LABEL: Record<CharacterAsset["kind"], string> = {
  portrait: "Portrait",
  full_body: "Bürofigur",
  animation: "Animation",
  model_3d: "3D-Modell",
};

export function CharacterAssetManager({
  onList,
  onDelete,
  onUse,
  onRemoved,
  refreshKey,
}: CharacterAssetManagerProps): React.JSX.Element {
  const [assets, setAssets] = useState<CharacterAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const refresh = useCallback(async () => {
    setAssets(await onList());
  }, [onList]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void onList()
      .then((result) => {
        if (active) setAssets(result);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Dateiliste konnte nicht geladen werden.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onList, refreshKey]);
  const remove = async (asset: CharacterAsset) => {
    setBusyId(asset.id);
    setError(null);
    setNotice("");
    try {
      const result = await onDelete(asset.id, (asset.inUseBy?.length ?? 0) > 0);
      if (result.deleted || result.pending) onRemoved(asset);
      setNotice(
        result.pending
          ? "Verknüpfungen entfernt. Die physische Löschung ist noch ausstehend; Status erneut prüfen."
          : result.deleted
            ? "Datei physisch gelöscht."
            : "Die Datei wurde nicht gelöscht.",
      );
      setConfirmId(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Die Datei konnte nicht gelöscht werden.");
    } finally {
      setBusyId(null);
    }
  };
  return (
    <section className="character-asset-manager" aria-label="Private Figurdateien">
      <header>
        <h4>Private Figurdateien</h4>
        <button
          type="button"
          className="ic-btn"
          disabled={loading || !!busyId}
          onClick={() => {
            setLoading(true);
            setError(null);
            void refresh()
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : "Dateiliste konnte nicht geladen werden."),
              )
              .finally(() => setLoading(false));
          }}
        >
          Dateiliste aktualisieren
        </button>
      </header>
      {loading && <p role="status">Dateien werden geladen …</p>}
      {error && (
        <p role="alert" className="character-editor-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!loading && !error && assets.length === 0 && <p>Noch keine eigenen Figurdateien hochgeladen.</p>}
      <ul>
        {assets.map((asset) => (
          <li key={asset.id}>
            {asset.kind === "model_3d" ? (
              <div className="character-asset-model-icon" aria-hidden="true">
                3D
              </div>
            ) : (
              <img src={asset.url} alt="" loading="lazy" />
            )}
            <div className="character-asset-description">
              <strong>{KIND_LABEL[asset.kind]}</strong>
              <span>
                {asset.kind === "model_3d" ? "GLB" : `${asset.width} × ${asset.height} px`} ·{" "}
                {(asset.sizeBytes / 1024).toFixed(0)} KiB
              </span>
              <span>
                {asset.status === "deleting"
                  ? "Löschung ausstehend"
                  : asset.inUseBy?.length
                    ? `Bei ${asset.inUseBy.length} Mitarbeitenden verwendet`
                    : "Nicht zugeordnet"}
              </span>
            </div>
            <div className="character-asset-actions">
              <button
                type="button"
                className="ic-btn"
                disabled={!!busyId || asset.status === "deleting"}
                onClick={() => onUse(asset)}
                aria-label={`${KIND_LABEL[asset.kind]} ${asset.id} auswählen`}
              >
                Auswählen
              </button>
              <button
                type="button"
                className="ic-btn"
                disabled={!!busyId}
                onClick={() => setConfirmId(asset.id)}
                aria-label={`${KIND_LABEL[asset.kind]} ${asset.id} löschen`}
              >
                {asset.status === "deleting" ? "Löschung erneut versuchen" : "Datei löschen"}
              </button>
            </div>
            {confirmId === asset.id && (
              <div className="character-asset-confirm">
                <p>
                  {asset.inUseBy?.length
                    ? `Diese Datei ist bei ${asset.inUseBy.length} Mitarbeitenden zugeordnet. Beim Löschen werden diese Verknüpfungen entfernt.`
                    : "Diese Datei endgültig aus dem privaten Dateispeicher löschen?"}
                </p>
                <button
                  type="button"
                  className="ic-btn"
                  data-variant="danger"
                  disabled={!!busyId}
                  onClick={() => void remove(asset)}
                >
                  {asset.inUseBy?.length ? "Verknüpfungen lösen und Datei löschen" : "Endgültig löschen"}
                </button>
                <button type="button" className="ic-btn" disabled={!!busyId} onClick={() => setConfirmId(null)}>
                  Abbrechen
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
