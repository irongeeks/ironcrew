# Präventionsregeln aus dem Linux-Nachtest zu 0.4.1

- Katalogtests müssen den gesamten HTTP→Validierung→SQLite-Pfad mit realistischen Größen prüfen: unter, an und über Transaktionsgrenzen sowie mindestens 579 Modelle. Erfolgreiche Parser-Tests belegen keinen gespeicherten Katalog.
- Externe IDs sind undurchsichtige Werte. CLI-Verträge mit führendem Bindestrich, Leerzeichen, Gleichheitszeichen und Unicode testen; Werte ohne Shell an ihre Option binden.
- Veröffentlichte Manifestformate sind Verträge. Inkompatible Änderungen benötigen eine höhere Schemaversion; maschinenlesbare Laufzeitvoraussetzungen und Verbraucher-Vertragstests gehören zum Release.
- Diagnosen müssen die Fehlerphase und sichere interne Codes erhalten. Rohdaten, Secrets und beliebige Fehlermeldungen bleiben aus Protokollen ausgeschlossen.
- Bei CLI-Argumentänderungen alle Resolver-Fakes prüfen, auch indirekte `args.includes(...)`-Heuristiken ohne Optionsnamen. Kanal-Authentifizierung muss über den gleichen Argumentvertrag getestet werden.

# Präventionsregeln aus dem Nachtest zu 0.4.2

- Bei parallelen Implementierungen im Quellrelease jeden vom Testbericht genannten Pfad prüfen; ein Fix unter `next/` korrigiert nicht automatisch den Hauptserver.
- Laufbereitschaft durch den tatsächlichen konfigurierten Versandpfad belegen; Katalogerreichbarkeit und Secretprüfung allein reichen nicht.
- Neben Erfolgsfällen auch überlappende Abrufe, doppelte Provider-IDs und bestehende permissive Dateirechte reproduzieren.
- Generierte Kundenartefakte selbst prüfen: Vorschau-Schutz ersetzt weder HTML-Bereinigung noch Produktionsheader.

# Präventionsregeln aus dem Nachtest zu 0.4.3

- Installationspfade mit versteckten Elternverzeichnissen in HTTP-Regressionen prüfen; öffentliche Startdateien relativ zu einem festen Web-Root ausliefern, ohne versteckte Dateien allgemein freizugeben.
- Live-Nachweise müssen Nullbudgets für kostenlose Modelle zulassen und das tatsächliche Antwortlimit in der Reservierung berücksichtigen. Reine Reasoning-Ausgabe ist keine finale Antwort.
- Historische externe Schreibweisen an Eingabegrenzen normalisieren und kanonische Speicherung sowie Ein-/Ausgabe-Schemas gemeinsam prüfen.
