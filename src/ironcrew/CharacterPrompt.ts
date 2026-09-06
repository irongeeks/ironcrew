export function buildCharacterPrompt(identity: string, style: string, language: "de" | "en" = "en"): string {
  if (language === "de") return buildGermanCharacterPrompt(identity, style);
  return `Create a character asset for the IronCrew virtual office.

CHARACTER / REFERENCE
${identity.trim() || "An original adult character with a recognisable silhouette, distinctive face and professional outfit."}

VISUAL STYLE
${style.trim() || "Modern cinematic illustration, clear rounded forms, refined materials and restrained graphite, teal and amber accents. No pixel art or retro-game rendering."}

DELIVERABLE
One full-body character, alone, facing the viewer in a slight three-quarter view. The camera is slightly elevated, about 10–15 degrees. Neutral standing pose; arms relaxed with a small gap from the torso. Preserve the requested identity and distinctive features. The entire head, hair, hands, accessories and feet must fit inside the canvas.

Use a 1024 × 1280 PNG with a genuinely transparent background (alpha channel), not a drawn checkerboard. Centre the character horizontally. Keep a 6% clear margin at the sides and above the head; align the soles of both feet on a common baseline at 92% of the canvas height. No scenery, floor, cast shadow, text, frame or interface. Use clean edges and readable shapes that still work when the character is displayed at approximately 65 × 81 pixels.

OPTIONAL PORTRAIT
As a separate file, produce a square 1024 × 1024 head-and-shoulders portrait of the exact same character, face centred, with the same lighting and transparent background.

OPTIONAL ANIMATION
If an animation is requested, keep identity, proportions, camera, frame size and feet baseline identical. Export a transparent sprite sheet: one status per row, consecutive frames from left to right, all cells the same size, no gutters. Use these exact status names in a separate mapping: idle, thinking, working, in_meeting, waiting_for_input, waiting_for_approval, rate_limited, paused, error, offline. State the cell width, cell height, column count, row index (starting at zero), frame count, FPS and whether to loop. Maximum 64 frames per status, 256 in total, 30 FPS, 4096 pixels per image edge and 5 MiB per file. Error animation must finish, not loop. Static base images remain supported; live system-state indicators are added by the application.

OPTIONAL 3D EXPORT
If a 3D version is requested, export a single untextured GLB 2 file below 5 MiB with embedded geometry, normals, material colours and optional named skeletal animation clips using the same status names. No external files, textures, extensions or decoder dependencies. The model is an optional interactive preview; IronCrew's office remains 2D.`;
}

function buildGermanCharacterPrompt(identity: string, style: string): string {
  return `Erstelle eine Charakterdatei für das virtuelle Büro von IronCrew.

FIGUR / REFERENZ
${identity.trim() || "Eine eigenständige erwachsene Figur mit wiedererkennbarer Silhouette, markantem Gesicht und beruflicher Kleidung."}

BILDSTIL
${style.trim() || "Moderne filmische Illustration, klare abgerundete Formen, hochwertige Materialien und dezente Akzente in Graphit, Türkis und Bernstein. Keine Pixelgrafik oder Retrospiel-Darstellung."}

ERGEBNIS
Eine einzelne Ganzkörperfigur, leicht schräg zum Betrachter gewandt. Die Kamera liegt etwa 10–15 Grad erhöht. Neutrale stehende Pose; entspannte Arme mit etwas Abstand zum Oberkörper. Gewünschte Identität und markante Merkmale beibehalten. Kopf, Haare, Hände, Accessoires und Füße müssen vollständig im Bild liegen.

Eine PNG-Datei mit 1024 × 1280 Pixeln und transparentem Hintergrund (Alphakanal) verwenden, kein gezeichnetes Schachbrettmuster. Figur horizontal zentrieren. Seitlich und oberhalb des Kopfes 6% freien Rand lassen; beide Fußsohlen auf einer gemeinsamen Grundlinie bei 92% der Bildhöhe ausrichten. Keine Landschaft, Bodenfläche, Schlagschatten, Schrift, Rahmen oder Benutzeroberfläche. Klare Kanten und lesbare Formen verwenden, die auch bei etwa 65 × 81 Pixeln erkennbar bleiben.

OPTIONALES PORTRAIT
Als separate Datei ein quadratisches Kopf-Schulter-Portrait derselben Figur mit 1024 × 1024 Pixeln erstellen, Gesicht zentriert, gleiche Beleuchtung und transparenter Hintergrund.

OPTIONALE ANIMATION
Bei einer Animation Identität, Proportionen, Kamera, Bildgröße und Fußgrundlinie unverändert lassen. Ein transparentes Animationsraster exportieren: ein Status je Zeile, aufeinanderfolgende Frames von links nach rechts, gleich große Zellen ohne Zwischenräume. In einer separaten Zuordnung exakt diese Statusnamen verwenden: idle, thinking, working, in_meeting, waiting_for_input, waiting_for_approval, rate_limited, paused, error, offline. Zellbreite, Zellhöhe, Spaltenzahl, Zeilenindex (ab null), Frameanzahl, FPS und Wiederholung angeben. Höchstens 64 Frames pro Status, 256 insgesamt, 30 FPS, 4096 Pixel je Bildkante und 5 MiB je Datei. Die Fehleranimation muss enden und darf sich nicht wiederholen. Statische Grundbilder bleiben unterstützt; die Anwendung ergänzt die aktuellen Systemstatus-Anzeigen.

OPTIONALER 3D-EXPORT
Bei einer 3D-Version eine einzelne GLB-2-Datei ohne Texturen unter 5 MiB exportieren, mit eingebetteter Geometrie, Normalen, Materialfarben und optional benannten Skelettanimationsclips mit denselben Statusnamen. Keine externen Dateien, Texturen, Erweiterungen oder Decoder-Abhängigkeiten. Das Modell dient als optionale interaktive Vorschau; das Büro von IronCrew bleibt zweidimensional.`;
}
