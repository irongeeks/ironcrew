# ADR 0001 — Separater Kern, geteilte explizite Grenzen

2026-09-07, angenommen für den lokalen Neubau.

Der GitHub-Stand entspricht unverändert dem geprüften Commit 76160c0. Entwicklung in `next/`, eigenständige Paketinstallation und Lockfile. Node 26.4.0 ist die hier vorhandene und getestete Patchversion; die spätere Release-Patchversion wird erneut durch die vollständige Matrix geprüft. Node 26 ist Current, SQLite hat einen versionsabhängigen Stabilitätsvertrag (offizielle Dokumentation: https://nodejs.org/en/about/previous-releases und https://nodejs.org/api/sqlite.html).

SQLite läuft ausschließlich in einem dedizierten Workerthread. Firma, Crew, Aufträge, Budget und unveränderliche Dokumentversionen haben eine Repositorygrenze. Allgemeine scoped Dokumentaggregate reduzieren Schema-Duplizierung für Arbeitsjournale, ohne Auftrags-, Bereichs-, Kosten- und Konkurrenzinvarianten zu umgehen. Mutationen mit Audit und Ereignis-Outbox sind transaktional. Auth/API, Modellschleife und Adapter verwenden kein altes Company-Orchestratorobjekt.

Native TypeScript-Entwicklung nutzt Node Type Stripping; der Produktionsbuild erzeugt JavaScript. .ts-Importe werden von TypeScript beim Build umgeschrieben. Keine Parameterproperties/Enums als versteckte Runtime-Transpilerabhängigkeit.

Alle externen Konten bleiben unkonfiguriert. Integrationstests nutzen dokumentierte lokale Testserver; Modelltests verwenden einen explizit als Fixture bezeichneten HTTP-/Clientvertrag. Es wurde kein kostenpflichtiger Modellaufruf beauftragt oder ausgeführt.
