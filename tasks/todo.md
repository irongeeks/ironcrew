# IronCrew v0.4.2 — Issues aus Claudes Linux-Nachtest

- [x] Issues #31–34 und Releasebasis 671b044 prüfen.
- [x] #31: großen Modellkatalog atomar speichern; allgemeine Transaktionsgrenze erhalten.
- [x] #34: Transport, abgelehnte Speicherung und Speicherfehler sicher unterscheiden.
- [x] #32: Proton-IDs mit führendem Bindestrich korrekt übergeben.
- [x] #33: Manifest eindeutig versionieren und Laufzeitvoraussetzungen wieder aufnehmen.
- [x] Regressionen, Build, Version, README und Docs prüfen.
- [ ] Commit, Push, PR-Merge und v0.4.2 nach vollständigen Release-Gates verifizieren.

## Review und lokale Prüfung

- Katalogfehler vor Änderung reproduziert: 99 Modelle bestanden, 100/579/1.200 scheiterten.
- Nach Korrektur: 187 Unit-/Vertrags-/Integrationstests und elf Manifesttests bestanden.
- Unabhängiger Review prüfte Bulkpfad, Revisionen und Diagnosen. Veraltete Fehlercodes entfernt; konkurrierender erfolgreicher Refresh durch Regression geschützt.
- Vollständige Betriebssystem- und Release-Gates werden am veröffentlichten Main-Commit erneut ausgeführt.
- Kein echter Betreiber-Modellaufruf auf tank; Fixtures enthalten keine Kontozugangsdaten.
- Typecheck, ESLint, Formatprüfung, Produktionsbuild und OpenAPI-Abgleich bestanden.
