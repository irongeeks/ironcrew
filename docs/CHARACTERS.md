# Figuren und eigene Charakterbilder

IronCrew enthält 20 originale, vollständig sichtbare SVG-Figuren. Sie unterscheiden
sich in Körperform, Frisur, Kleidung und Ausstattung; Menschen, Roboter und
nichtmenschliche Figuren sind vertreten. Diese Auswahl benötigt keinen Bilddienst.

## Figur im Agentenprofil auswählen

1. Im Office eine Figur oder einen Agenten in der zugänglichen Liste öffnen.
2. Im Agentenprofil den Figureneditor öffnen und ein Original auswählen.
3. Optional ein Portrait und ein Ganzkörperbild hochladen. Beide haben eine eigene
   Vorschau; das Ganzkörperbild erscheint im Büro, das Portrait im Profil.
4. Vorschau prüfen und **Figur speichern** wählen. Erst das Speichern weist dem
   Agenten die Auswahl zu. Ein zuvor hochgeladenes Bild ist bereits privat gespeichert,
   auch wenn der Dialog ohne Speichern geschlossen wird.

Eine neue Originalauswahl entfernt private Bildzuweisungen aus dem Entwurf. Die
Dateien bleiben gespeichert. Bei einem nicht ladbaren privaten Bild greift die
Originalfigur als Fallback. Statusanzeigen stammen weiterhin aus dem Backend:
Ein Kostüm erzeugt weder einen laufenden Task noch einen Meeting- oder Freigabestatus.

| ID            | Original      | Erkennbare Merkmale                            |
| ------------- | ------------- | ---------------------------------------------- |
| `navigator`   | Navigator     | Geflochtenes Haar, türkise Tunika, Tablet      |
| `engineer`    | Ingenieur     | Irokesenschnitt, Bart, Werkzeuggürtel          |
| `sentinel`    | Wächter       | Breite Schutzrüstung, Bart, Schild             |
| `diplomat`    | Diplomatin    | Langes bernsteinfarbenes Kleid, offene Haare   |
| `analyst`     | Analyst       | Rollstuhl, Brille, Weste, Tablet               |
| `medic`       | Medizinerin   | Weißer Kittel, hochgestecktes Haar, Koffer     |
| `pilot`       | Pilotin       | Fluganzug, Schultergurte, kompakte Ausrüstung  |
| `ranger`      | Kundschafter  | Leichte Reiseausrüstung, asymmetrischer Umhang |
| `archivist`   | Archivar      | Graues Haar, Weste, Gehstock, Buch             |
| `artisan`     | Gestalterin   | Afrofrisur, Schürze, Pinsel und Farbakzente    |
| `strategist`  | Stratege      | Glatze, Bart, Maßanzug, Aktentasche            |
| `courier`     | Kurier        | Bewegliche Silhouette, Umhängetasche           |
| `diver`       | Taucher       | Druckanzug, runder Helm, maritime Details      |
| `mechanic`    | Mechaniker    | Afrofrisur, Bart, Overall, Schraubenschlüssel  |
| `botanist`    | Botanikerin   | Feldkleidung, grüne Akzente, Pflanzentasche    |
| `android`     | Androide      | Synthetischer Körper, sichtbare Gelenke        |
| `automaton`   | Automat       | Kompakter mechanischer Roboter                 |
| `visitor`     | Besucher      | Langer Kopf, fremdartige Anatomie              |
| `cephalid`    | Cephalid      | Nichtmenschliche Tentakelsilhouette            |
| `crystalline` | Kristallwesen | Facettierter geometrischer Körper              |

Die Namen beschreiben **nur das Erscheinungsbild**. „Medizinerin“, „Wächter“ oder
„Stratege“ weisen keine fachliche Rolle, Zulassung, Skills oder Berechtigungen zu.
Professional Role und Policy bleiben getrennt. Upload und Zuordnung sind
Owner-Aktionen mit Audit-Eintrag; lesender Zugriff setzt eine Anmeldung voraus.

## Eigene Figur mit einem Bildmodell erstellen

Unter **Prompt für eine eigene Figur erstellen** sind Identität/Referenz und Stil
frei editierbar. Eingaben wie „Pamela Anderson“, „Captain America“, „ein Alien“
oder eine eigene Figur bleiben im kopierten Prompt erhalten. IronCrew ersetzt
diese Eingaben nicht stillschweigend durch einen anderen Charakter.

**Generator-Prompt kopieren** kopiert ausschließlich Text. IronCrew ruft dabei
kein Bildmodell auf, übermittelt keine Referenzen an einen Bilddienst und lädt
keine Bilder aus dem Internet herunter. Den Prompt im selbst gewählten Bildmodell
verwenden, das Ergebnis herunterladen und anschließend als privates Bild hochladen.
Referenzbilder können direkt in diesem externen Modell ergänzt werden.

Der erzeugte Prompt enthält Vorgaben für ein gut lesbares Office-Bild:

- Eine einzelne Figur vollständig im Bild, einschließlich Kopf, Haaren, Händen,
  Accessoires und Füßen; leicht erhöhte Dreiviertelansicht und neutrale Haltung.
- Ganzkörperformat 1024 × 1280, transparenter PNG-Hintergrund mit echtem Alphakanal,
  ohne Schachbrettmuster, Kulisse, Text oder UI-Rahmen.
- Abstand zum Bildrand und ein einheitlicher Standpunkt der Füße für die Einordnung
  ins Office; erkennbare Silhouette auch bei kleiner Darstellung.
- Optional ein separates quadratisches Portrait; Identität und Kleidung bleiben
  zum Ganzkörperbild konsistent.

Transparente Bilder ergeben die sauberste Freistellung. JPEG ist als Upload erlaubt,
unterstützt aber keine Transparenz. Das Repository liefert eigene Originalfiguren;
private Uploads werden nicht Teil der öffentlichen Assets oder eines Git-Commits.

## Uploadgrenzen und Speicherung

| Eigenschaft  | Implementiertes Verhalten                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Eingabe      | Statisches PNG, WebP oder JPEG; Dateisignatur, MIME-Typ und tatsächlicher Decoder müssen übereinstimmen                  |
| Größe        | Höchstens 5 MiB Eingabedatei, 4096 Pixel pro Kante und insgesamt 16 Millionen Pixel                                      |
| Animationen  | Mehrseitige bzw. animierte Bilder werden abgewiesen                                                                      |
| Verarbeitung | Neu kodiertes statisches WebP; Orientierung wird angewendet, Metadaten und angehängte Fremddaten werden nicht übernommen |
| Ablage       | Standardmäßig `data/private-assets/characters/`, Metadaten in SQLite, Zuordnung getrennt pro Agent                       |
| Quota        | 200 MiB gespeicherte Medien und höchstens 1000 Dateien pro Firma                                                         |
| Zugriff      | Authentifizierte, firmengebundene API; `Cache-Control: private, no-store`; keine öffentliche Static-Asset-Route          |
| Dateisystem  | Neu angelegte private Wurzel mit Modus `0700`, Dateien `0600`; Symlink- und Integritätsprüfungen                         |
| Zuweisung    | Nur interne Asset-Referenzen; keine beliebigen externen Bild-URLs                                                        |
| Entfernen    | Dateiverwaltung mit physischem Löschen; verwendete Assets benötigen ausdrücklich bestätigtes Lösen der Zuordnungen       |

Die private Ablage ist Zugriffsschutz, keine zusätzliche Verschlüsselung auf dem
Datenträger. Für einen vollständigen Umzug müssen Datenbank und private Bilddateien
zusammen gesichert werden; eine reine SQLite-Sicherung enthält die Bilder nicht.

## Grenzen und Implementierung

Ein Spritesheet ist eine statische Bilddatei mit mehreren Frames. Im Figurenprofil
lassen sich Framegröße, Spalten und je Agentenstatus Zeile, Anzahl, FPS und Wiederholung
festlegen. Das Office spielt die Zeile des tatsächlichen Backendstatus ab. Bei
reduzierter Bewegung oder verborgenem Tab pausiert der Player; Fehleranimationen
laufen einmal. GIF/APNG und andere mehrseitige Dateien bleiben abgewiesen.

Optional lässt sich eine selbstenthaltene GLB-Datei bis 5 MiB im Profil hochladen
und mit Kamera-/Zoom-Steuerung ansehen. Eingebettete Geometrie und Skelettanimationen
werden unterstützt; Texturen, externe Ressourcen, Erweiterungen und Kompression sind
nicht erlaubt. GLTF-Dateien mit Nebenressourcen werden nicht importiert. Die 3D-Vorschau
wird separat geladen; das Office bleibt 2D und behält seine zugängliche DOM-Ansicht.

Die Dateiverwaltung zeigt tatsächliche Zuordnungen. Löschen eines verwendeten Assets
wird ohne ausdrückliches Detach abgewiesen. Eine fehlgeschlagene physische Löschung
bleibt als ausstehend sichtbar und kann wiederaufgenommen werden; ein gelöschter
Datenbankeintrag wird nicht als erfolgreiche Dateilöschung ausgegeben.

Ein integrierter Bildmodell-Aufruf ist weiterhin nicht Bestandteil des Generators.
Der kopierbare Prompt unterstützt auch ein Raster aus Statusframes.

- `src/shared/character-skins.ts`: stabile Auswahl-IDs und Beschreibungen.
- `src/ironcrew/CharacterSkinEditor.tsx` und `CharacterPrompt.ts`: Auswahl, Vorschau,
  Upload und kopierbarer Prompt.
- `server/ironcrew/domain/character-store.ts`: Validierung, private Dateien,
  Firmenzuordnung und Audit.
- `server/ironcrew/api/character-routes.ts`: authentifizierte Bild- und Profilrouten.

Aktuelle konsolidierte Tests und Browsernachweise stehen in
[IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md).
