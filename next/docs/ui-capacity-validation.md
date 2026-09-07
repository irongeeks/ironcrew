# Lokale UI-Kapazität und Zugänglichkeit

Die maschinenlesbaren Messwerte und zugehörigen Ressourcen-Hashes stehen in [results.json](test-evidence/ui-capacity/results.json). Das Skript `node scripts/ui-capacity-evidence.ts` startet eine eigene temporäre SQLite-Firma auf einem dynamischen lokalen Port und legt 1000 echte Aufträge über die authentifizierte HTTP-API an. Es verwendet keine API-Interception und keine externen Provider.

Geprüft werden initiales Nicht-3D-JavaScript ≤350 KiB gzip, initiale HQ-Ressourcen ≤15 MiB und P95 der Eingabereaktion <200 ms bei 1000 Aufträgen. Gzip wird anhand der tatsächlich geladenen Response-Bodies berechnet; der lokale Express-Server liefert identity-Encoding. Dies belegt das Ressourcenbudget, nicht HTTP-Kompression im Deployment. Eingabereaktion misst echte Tastatureingaben vom Input-Event bis zum zweiten AnimationFrame nach React-Update; Rohwerte sind enthalten.

Die Screenshots zeigen Auftrags-Leerzustand und HQ bei 1440×900, 1024×768 und 390×844 sowie einen blockierten Auftrag in denselben Breiten. Der blockierte Zustand wird nach HTTP-Auftragserstellung bewusst durch eine echte Repository-Transition auf `blocked` gesetzt. Dies ist eine lokale Zustandsfixture, keine produktive Budgetblockade.

Axe-core 4.10.3 prüft WCAG 2/2.1/2.2 A/AA in den sechs Leer-/Blockiert-Ansichten. Tastaturöffnung und Escape-Fokusrückgabe der Befehlspalette werden ebenfalls geprüft. Daraus folgt keine Behauptung einer Prüfung mit physischem Screenreader. Die GLB-/Reduced-Motion-/WebGL-Verlust-Abnahme ist separat in [crew-visual-validation.md](crew-visual-validation.md) dokumentiert.

Reproduktion nach aktuellem Web-Build:

```sh
npx pnpm@10.30.1 exec vite build --config apps/web/vite.config.ts
npm install --prefix .var/ui-validation --no-save --ignore-scripts axe-core@4.10.3
node scripts/ui-capacity-evidence.ts
```

Gerät, Browser, Zeitpunkt, Einzelwerte und Pass/Fail-Entscheidungen werden bei jedem Lauf neu aufgezeichnet. Die Ergebnisse gelten für genau diesen lokalen Build und dieses Gerät.


## Abschließender Lauf

Am 2026-09-07T12:24:09.878Z wurde der unveränderte Build nach dem Vollgate auf Apple M5 / darwin 25.6.0 arm64 geprüft. Es liefen keine parallelen Paket-/Update-Lasttests. Ergebnisse: initiales Nicht-3D-JavaScript **151682 Bytes gzip-equivalent**, HQ-Anfangsressourcen **1778584 Bytes gzip-equivalent**, **P95 23 ms** aus 118 tatsächlichen Tastatureingaben bei 1000 über HTTP angelegten Aufträgen. Alle drei vorgegebenen Schwellen wurden eingehalten. Die sechs Empty-/Blocked-Ansichten meldeten **keine Axe-Verstöße**; im JSON ausgewiesene unvollständig automatisch prüfbare Regeln bleiben eine manuelle Nachweisgrenze.

Ressourcen-Hashes, Rohsamples, Gerät und Zeitpunkt stehen im verlinkten Ergebnisdokument. Die getrennte vorausgehende Hallenmessung ist in [crew-visual-validation.md](crew-visual-validation.md) dokumentiert.
