# Präventionsregeln aus dem Linux-Nachtest zu 0.4.1

- Katalogtests müssen den gesamten HTTP→Validierung→SQLite-Pfad mit realistischen Größen prüfen: unter, an und über Transaktionsgrenzen sowie mindestens 579 Modelle. Erfolgreiche Parser-Tests belegen keinen gespeicherten Katalog.
- Externe IDs sind undurchsichtige Werte. CLI-Verträge mit führendem Bindestrich, Leerzeichen, Gleichheitszeichen und Unicode testen; Werte ohne Shell an ihre Option binden.
- Veröffentlichte Manifestformate sind Verträge. Inkompatible Änderungen benötigen eine höhere Schemaversion; maschinenlesbare Laufzeitvoraussetzungen und Verbraucher-Vertragstests gehören zum Release.
- Diagnosen müssen die Fehlerphase und sichere interne Codes erhalten. Rohdaten, Secrets und beliebige Fehlermeldungen bleiben aus Protokollen ausgeschlossen.
- Bei CLI-Argumentänderungen alle Resolver-Fakes prüfen, auch indirekte `args.includes(...)`-Heuristiken ohne Optionsnamen. Kanal-Authentifizierung muss über den gleichen Argumentvertrag getestet werden.
