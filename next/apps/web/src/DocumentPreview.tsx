import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { string as str, type Row } from "./api.ts";
import type { Locale } from "./Operations.tsx";
import styles from "./App.module.css";
export default function DocumentPreview({
  file,
  voucher,
  locale,
}: {
  file?: File | null;
  voucher?: Row;
  locale: Locale;
}) {
  const [image, setImage] = useState(""),
    [pdf, setPdf] = useState<PDFDocumentProxy | null>(null),
    [page, setPage] = useState(1),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [verified, setVerified] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null),
    container = useRef<HTMLDivElement>(null),
    [width, setWidth] = useState(600);
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(160, Math.min(1000, entry?.contentRect.width ?? 600))),
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let active = true,
      imageUrl = "",
      task: { destroy(): Promise<void> } | undefined;
    const abort = new AbortController();
    setImage("");
    setPdf(null);
    setPage(1);
    setText("");
    setError("");
    setVerified(false);
    if (!file && !voucher) return;
    setLoading(true);
    void (async () => {
      let buffer: ArrayBuffer;
      if (file) buffer = await file.arrayBuffer();
      else {
        const response = await fetch(`/api/v1/finance/vouchers/${encodeURIComponent(str(voucher!, "id"))}/original`, {
          credentials: "same-origin",
          signal: abort.signal,
        });
        if (!response.ok)
          throw new Error(t("Originalbeleg konnte nicht geladen werden.", "Original document could not be loaded."));
        if (Number(response.headers.get("content-length")) > 10000000)
          throw new Error(t("Vorschau auf 10 MB begrenzt.", "Preview is limited to 10 MB."));
        buffer = await response.arrayBuffer();
      }
      if (!active) return;
      if (buffer.byteLength > 10000000)
        throw new Error(t("Vorschau auf 10 MB begrenzt.", "Preview is limited to 10 MB."));
      const bytes = new Uint8Array(buffer),
        type = file?.type ?? str(voucher!, "originalMediaType");
      if (voucher && !file) {
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)))
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
        if (digest !== str(voucher, "originalSha256"))
          throw new Error(t("Prüfsumme stimmt nicht. Vorschau gesperrt.", "Checksum mismatch. Preview blocked."));
        if (active) setVerified(true);
      }
      const validPdf = type === "application/pdf" && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-",
        validPng =
          type === "image/png" && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value),
        validJpeg = type === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (validPdf) {
        const library = await import("pdfjs-dist");
        library.GlobalWorkerOptions.workerSrc = pdfWorker;
        const document = library.getDocument({
          data: bytes,
          disableFontFace: true,
          useSystemFonts: true,
          useWorkerFetch: false,
          useWasm: false,
          enableXfa: false,
          isOffscreenCanvasSupported: false,
          maxImageSize: 16000000,
          stopAtErrors: true,
        });
        task = document;
        const result = await document.promise;
        if (active) setPdf(result);
      } else if (validPng || validJpeg) {
        imageUrl = URL.createObjectURL(new Blob([buffer], { type }));
        if (active) setImage(imageUrl);
      } else
        throw new Error(
          t(
            "Vorschau nur für echte PDF-, PNG- oder JPEG-Originale verfügbar.",
            "Preview supports actual PDF, PNG and JPEG originals only.",
          ),
        );
    })()
      .catch((error) => {
        if (active && !abort.signal.aborted) setError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
      abort.abort();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      void task?.destroy();
    };
  }, [file, voucher?.id, voucher?.originalSha256, locale]);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let alive = true,
      render: { cancel(): void; promise: Promise<void> } | undefined;
    void (async () => {
      const documentPage = await pdf.getPage(page);
      if (!alive || !canvas.current) return;
      const base = documentPage.getViewport({ scale: 1 }),
        viewport = documentPage.getViewport({ scale: width / base.width });
      const element = canvas.current;
      element.width = Math.ceil(viewport.width);
      element.height = Math.ceil(viewport.height);
      render = documentPage.render({ canvas: element, viewport, annotationMode: 0 });
      await render.promise;
      const content = await documentPage.getTextContent();
      if (alive)
        setText(
          content.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" ")
            .slice(0, 30000),
        );
    })().catch((error) => {
      if (alive && error?.name !== "RenderingCancelledException")
        setError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      alive = false;
      render?.cancel();
    };
  }, [pdf, page, width]);
  return (
    <aside
      className={styles.documentPreview}
      ref={container}
      aria-label={t("Sichere Originalbelegvorschau", "Safe original document preview")}
    >
      <h3>{t("Originalbeleg", "Original document")}</h3>
      {loading && <p role="status">{t("Vorschau laden…", "Loading preview…")}</p>}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {verified && (
        <p className={styles.muted}>
          {t("Originalbytes anhand SHA-256 geprüft.", "Original bytes verified against SHA-256.")}
        </p>
      )}
      {file && (
        <p className={styles.muted}>
          {file.name} · {t("Lokale Datei; noch nicht gespeichert.", "Local file; not stored yet.")}
        </p>
      )}
      {image && (
        <img
          src={image}
          alt={t("Originalbeleg zur manuellen Zuordnung", "Original document for manual classification")}
        />
      )}
      {pdf && (
        <>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              disabled={page <= 1}
              onClick={() => setPage((value) => value - 1)}
            >
              {t("Vorige Seite", "Previous page")}
            </button>
            <span>
              {t("Seite", "Page")} {page} / {pdf.numPages}
            </span>
            <button
              type="button"
              className={styles.secondary}
              disabled={page >= pdf.numPages}
              onClick={() => setPage((value) => value + 1)}
            >
              {t("Nächste Seite", "Next page")}
            </button>
          </div>
          <canvas ref={canvas} aria-label={t(`Originalbeleg Seite ${page}`, `Original document page ${page}`)} />
          <details>
            <summary>{t("Erkannter Seitentext", "Extracted page text")}</summary>
            <p className={styles.documentText}>
              {text || t("Kein extrahierbarer Text vorhanden.", "No extractable text available.")}
            </p>
          </details>
        </>
      )}
      {!file && !voucher && (
        <p>
          {t(
            "Originaldatei auswählen oder gespeicherten Beleg öffnen.",
            "Select an original file or open a stored document.",
          )}
        </p>
      )}
      <p className={styles.muted}>
        {t(
          "PDF wird als Bildfläche ohne Skripte, Formulare oder anklickbare Dokumentlinks dargestellt.",
          "PDF is rendered on a canvas without scripts, forms or clickable document links.",
        )}
      </p>
    </aside>
  );
}
