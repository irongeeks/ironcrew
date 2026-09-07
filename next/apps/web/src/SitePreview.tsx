import { useState } from "react";
import type { Locale } from "./Operations.tsx";
import styles from "./App.module.css";
export function ConceptPreview({ html, name, locale }: { html: string; name: string; locale: Locale }) {
  // Opaque, script-free static comparison. Inert also prevents link-driven frame navigation, which CSP default-src does not cover.
  const csp =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
  return (
    <iframe
      title={`${locale === "de" ? "Konzeptvorschau" : "Concept preview"}: ${name}`}
      sandbox=""
      inert
      referrerPolicy="no-referrer"
      loading="lazy"
      srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}">${html}`}
      style={{ display: "block", width: "100%", height: 360, border: 0, background: "white" }}
    />
  );
}
export function SitePreview({
  src,
  width,
  version,
  locale,
  onSelect,
}: {
  src: string;
  width: number;
  version: string;
  locale: Locale;
  onSelect: (anchor: string) => void;
}) {
  const [marking, setMarking] = useState(false),
    [point, setPoint] = useState({ x: 20, y: 20 });
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const select = (x: number, y: number) => {
    const next = { x: Math.max(0, Math.min(width - 1, Math.round(x))), y: Math.max(0, Math.min(649, Math.round(y))) };
    setPoint(next);
    onSelect(`viewport-point:${next.x},${next.y}`);
  };
  return (
    <>
      <button type="button" className={styles.secondary} aria-pressed={marking} onClick={() => setMarking(!marking)}>
        {t("Stelle in Vorschau markieren", "Mark a point in preview")}
      </button>
      {marking && (
        <p>
          {t(
            "Stelle anklicken oder die Markierung mit Pfeiltasten verschieben. Anschließend unten kommentieren. Die Markierung gilt für diese Version und diesen Bildausschnitt.",
            "Click a point or move the marker using arrow keys, then comment below. The marker is bound to this version and viewport.",
          )}
        </p>
      )}
      <div className={styles.previewFrame}>
        <div style={{ position: "relative", width, height: 650 }}>
          <iframe
            title={t("Website-Vorschau", "Website preview")}
            src={src}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            style={{ width }}
          />
          {marking && (
            <div
              role="button"
              tabIndex={0}
              aria-label={t("Markierung in der Vorschau", "Preview point marker")}
              aria-describedby={`marker-${version}`}
              style={{
                position: "absolute",
                inset: 0,
                cursor: "crosshair",
                outline: "2px solid #d99834",
                background: "rgba(20,25,30,0.04)",
              }}
              onClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                select(event.clientX - bounds.left, event.clientY - bounds.top);
              }}
              onKeyDown={(event) => {
                const offsets: Record<string, [number, number]> = {
                  ArrowLeft: [-10, 0],
                  ArrowRight: [10, 0],
                  ArrowUp: [0, -10],
                  ArrowDown: [0, 10],
                  Enter: [0, 0],
                  " ": [0, 0],
                };
                const delta = offsets[event.key];
                if (delta) {
                  event.preventDefault();
                  select(point.x + delta[0], point.y + delta[1]);
                }
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: point.x,
                  top: point.y,
                  width: 20,
                  height: 20,
                  transform: "translate(-50%,-50%)",
                  border: "3px solid #fff",
                  borderRadius: "50%",
                  background: "#a93918",
                  boxShadow: "0 0 0 2px #161b20",
                  pointerEvents: "none",
                }}
              />
            </div>
          )}
        </div>
      </div>
      {marking && (
        <p id={`marker-${version}`} aria-live="polite">
          {t("Markierte Stelle", "Marked point")}: {point.x}, {point.y} · {width} × 650
        </p>
      )}
    </>
  );
}
