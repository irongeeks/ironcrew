import { useI18n } from "../i18n";
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

export function CharacterAssetManager({
  onList,
  onDelete,
  onUse,
  onRemoved,
  refreshKey,
}: CharacterAssetManagerProps): React.JSX.Element {
  const { t } = useI18n();
  const KIND_LABEL: Record<CharacterAsset["kind"], string> = {
    portrait: "Portrait",
    full_body: t({ de: "Bürofigur", en: "Office character" }),
    animation: "Animation",
    model_3d: t({ de: "3D-Modell", en: "3D model" }),
  };
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
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : t({ de: "Dateiliste konnte nicht geladen werden.", en: "Could not load the file list." }),
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onList, refreshKey, t]);
  const remove = async (asset: CharacterAsset) => {
    setBusyId(asset.id);
    setError(null);
    setNotice("");
    try {
      const result = await onDelete(asset.id, (asset.inUseBy?.length ?? 0) > 0);
      if (result.deleted || result.pending) onRemoved(asset);
      setNotice(
        result.pending
          ? t({
              de: "Verknüpfungen entfernt. Die physische Löschung ist noch ausstehend; Status erneut prüfen.",
              en: "Assignments removed. Physical deletion is still pending; check the status again.",
            })
          : result.deleted
            ? t({ de: "Datei physisch gelöscht.", en: "File physically deleted." })
            : t({ de: "Die Datei wurde nicht gelöscht.", en: "The file was not deleted." }),
      );
      setConfirmId(null);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t({ de: "Die Datei konnte nicht gelöscht werden.", en: "Could not delete the file." }),
      );
    } finally {
      setBusyId(null);
    }
  };
  return (
    <section
      className="character-asset-manager"
      aria-label={t({ de: "Private Figurdateien", en: "Private character files" })}
    >
      <header>
        <h4>{t({ de: "Private Figurdateien", en: "Private character files" })}</h4>
        <button
          type="button"
          className="ic-btn"
          disabled={loading || !!busyId}
          onClick={() => {
            setLoading(true);
            setError(null);
            void refresh()
              .catch((cause: unknown) =>
                setError(
                  cause instanceof Error
                    ? cause.message
                    : t({ de: "Dateiliste konnte nicht geladen werden.", en: "Could not load the file list." }),
                ),
              )
              .finally(() => setLoading(false));
          }}
        >
          {t({ de: "Dateiliste aktualisieren", en: "Refresh file list" })}{" "}
        </button>
      </header>
      {loading && <p role="status">{t({ de: "Dateien werden geladen …", en: "Loading files …" })}</p>}
      {error && (
        <p role="alert" className="character-editor-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!loading && !error && assets.length === 0 && (
        <p>
          {t({ de: "Noch keine eigenen Figurdateien hochgeladen.", en: "No custom character files uploaded yet." })}
        </p>
      )}
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
                  ? t({ de: "Löschung ausstehend", en: "Deletion pending" })
                  : asset.inUseBy?.length
                    ? t({
                        de: `Bei ${asset.inUseBy.length} Mitarbeitenden verwendet`,
                        en: `Used by ${asset.inUseBy.length} employees`,
                      })
                    : t({ de: "Nicht zugeordnet", en: "Not assigned" })}
              </span>
            </div>
            <div className="character-asset-actions">
              <button
                type="button"
                className="ic-btn"
                disabled={!!busyId || asset.status === "deleting"}
                onClick={() => onUse(asset)}
                aria-label={t({
                  de: `${KIND_LABEL[asset.kind]} ${asset.id} auswählen`,
                  en: `Select ${KIND_LABEL[asset.kind]} ${asset.id}`,
                })}
              >
                {t({ de: "Auswählen", en: "Select" })}{" "}
              </button>
              <button
                type="button"
                className="ic-btn"
                disabled={!!busyId}
                onClick={() => setConfirmId(asset.id)}
                aria-label={t({
                  de: `${KIND_LABEL[asset.kind]} ${asset.id} löschen`,
                  en: `Delete ${KIND_LABEL[asset.kind]} ${asset.id}`,
                })}
              >
                {asset.status === "deleting"
                  ? t({ de: "Löschung erneut versuchen", en: "Retry deletion" })
                  : t({ de: "Datei löschen", en: "Delete file" })}
              </button>
            </div>
            {confirmId === asset.id && (
              <div className="character-asset-confirm">
                <p>
                  {asset.inUseBy?.length
                    ? t({
                        de: `Diese Datei ist bei ${asset.inUseBy.length} Mitarbeitenden zugeordnet. Beim Löschen werden diese Verknüpfungen entfernt.`,
                        en: `This file is assigned to ${asset.inUseBy.length} employees. Deleting it removes these assignments.`,
                      })
                    : t({
                        de: "Diese Datei endgültig aus dem privaten Dateispeicher löschen?",
                        en: "Permanently delete this file from private storage?",
                      })}
                </p>
                <button
                  type="button"
                  className="ic-btn"
                  data-variant="danger"
                  disabled={!!busyId}
                  onClick={() => void remove(asset)}
                >
                  {asset.inUseBy?.length
                    ? t({ de: "Verknüpfungen lösen und Datei löschen", en: "Remove assignments and delete file" })
                    : t({ de: "Endgültig löschen", en: "Delete permanently" })}
                </button>
                <button type="button" className="ic-btn" disabled={!!busyId} onClick={() => setConfirmId(null)}>
                  {t({ de: "Abbrechen", en: "Cancel" })}{" "}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
