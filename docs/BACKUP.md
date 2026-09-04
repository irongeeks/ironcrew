# Backup und Restore

Ein Backup, das nie zurückgespielt wurde, ist kein Backup. Es ist eine
Vermutung, die man an dem Tag prüft, an dem sie stimmen muss.

Deshalb steht in diesem Dokument die Wiederherstellung vor der Sicherung, und
deshalb testet die Test-Suite echte Restores in ein Temp-Verzeichnis statt zu
prüfen, ob eine Datei entstanden ist.

## Was gesichert wird

| Inhalt    | Warum                                                             |
| --------- | ----------------------------------------------------------------- |
| `DB_PATH` | Alles: Aufgaben, Läufe, Freigaben, Audit-Kette, Postfach-Zugänge  |
| Anhänge   | Inhaltsadressierte Blobs; ohne sie zeigen Anhang-Zeilen ins Leere |
| `--extra` | Optional, z. B. `config/private/character-pack.local.yaml`        |

**Nicht** gesichert wird `LOGS_DIR`. Logs gehören nach journald, wachsen
unbegrenzt und sind nach einem Restore wertlos — ein Backup, das an Logs
erstickt, wird irgendwann abgeschaltet.

Ebenfalls nicht gesichert wird die Env-Datei mit den Tokens
(`/etc/ironcrew/ironcrew.env`). Die gehört in deinen Passwort-Manager, nicht in
ein Archiv, das nach `/var/backups` geschrieben und irgendwann woanders
hinkopiert wird.

## Warum nicht einfach `cp`

Die Datenbank läuft. Ein `cp` über eine offene SQLite-Datei kann eine
zerrissene Kopie erzeugen: halb geschriebene Seiten, ein WAL, der nicht dazu
passt. Das Ergebnis sieht aus wie eine Datei und ist keine Datenbank.

Stattdessen `VACUUM INTO` — SQLites eigener Online-Snapshot. Er erzeugt einen
konsistenten Stand einer laufenden Datenbank, ohne den Dienst anzuhalten. Ein
Test schreibt währenddessen weiter und prüft, dass genau die Zeilen vor dem
Snapshot im Archiv liegen und die danach nicht.

Danach läuft `PRAGMA integrity_check` auf dem Snapshot. Kommt nicht exakt `ok`
zurück, schlägt das Backup fehl, statt eine kaputte Kopie abzulegen.

## Sichern

```bash
node scripts/ironcrew-backup.mjs \
  --db /var/lib/ironcrew/data/ironcrew.sqlite \
  --out /var/backups/ironcrew \
  --keep 14
```

`--keep 14` löscht ältere Archive, sodass das Verzeichnis nicht vollläuft.

Als Cron-Eintrag, nachts um drei:

```cron
0 3 * * * cd /opt/ironcrew && node scripts/ironcrew-backup.mjs --db /var/lib/ironcrew/data/ironcrew.sqlite --out /var/backups/ironcrew --keep 14
```

Das Skript beendet sich bei jedem Fehler mit Exit-Code 1 und schreibt den Grund
nach stderr — cron schickt dir das als Mail. Ein Backup-Job, der still
fehlschlägt, ist ein Backup, das es nicht gibt und von dem niemand weiß.

**Lege die Archive nicht nur auf denselben Server.** Ein Backup neben der
Datenbank überlebt einen Plattenfehler nicht.

## Vorher hineinsehen

```bash
node scripts/ironcrew-backup.mjs --inspect /var/backups/ironcrew/ironcrew-backup-20260904T030000Z.tar.gz
```

Zeigt das Manifest: Zeitpunkt, Integritätsstatus, Größen und je Datei einen
SHA-256. Nichts wird dabei angefasst.

## Wiederherstellen — Checkliste

Diese Reihenfolge, auch wenn es eilt.

1. **Dienst anhalten.** Ein Restore unter einer laufenden Datenbank ist
   dasselbe Problem wie `cp`, nur andersherum.
   ```bash
   sudo systemctl stop ironcrew
   ```
2. **Archiv prüfen**, bevor du irgendetwas überschreibst:
   ```bash
   node scripts/ironcrew-backup.mjs --inspect <archiv>
   ```
   Stimmt das Datum? Steht `integrityOk: true`?
3. **Zurückspielen.** Ohne `--force` weigert sich das Skript, eine vorhandene
   Datenbank zu überschreiben. Mit `--force` wird die vorhandene Datei nicht
   gelöscht, sondern als `.pre-restore-<zeitstempel>` beiseitegelegt:
   ```bash
   sudo -u ironcrew node scripts/ironcrew-backup.mjs \
     --restore <archiv> --db /var/lib/ironcrew/data/ironcrew.sqlite --force
   ```
4. **Prüfen, bevor du startest.** Die Audit-Kette in der Datenbank ist die
   härteste Aussage darüber, ob die Kopie unverfälscht ist — jedes veränderte
   Byte in einer auditierten Zeile bricht sie. Das Skript öffnet die Datei nur
   lesend, prüft jede Firma einzeln und braucht keinen laufenden Dienst — genau
   deshalb steht es hier, vor dem Start:

   ```bash
   sudo -u ironcrew node scripts/ironcrew-verify-audit.mjs \
     --db /var/lib/ironcrew/data/ironcrew.sqlite
   # oder, aus dem Repo heraus:  pnpm run audit:verify:db --db <pfad>
   ```

   Exit-Code 0 heißt: alle Ketten in Ordnung. 2 heißt: eine Kette ist gebrochen
   oder in der `seq`-Folge fehlt eine Nummer — dann NICHT starten, die Datei
   beiseitelegen und das nächstältere Archiv prüfen.

   Zwei Dinge, die das Skript nicht sagen kann, und die man wissen sollte: eine
   Lücke in der `seq`-Folge ist kein Beweis für Manipulation (ein Import kann
   eine hinterlassen), und Einträge, die am ENDE einer Kette abgeschnitten
   wurden, hinterlassen weder Bruch noch Lücke. Gegen Letzteres hilft nur der
   Vergleich mit einem älteren Backup.

   Nicht zu verwechseln mit `pnpm run audit:verify`: das prüft die zweite Kette
   in `$LOGS_DIR/security-audit.ndjson`. Logs liegen absichtlich nicht im
   Backup, das Kommando bricht auf einer frisch wiederhergestellten Maschine
   also mit `log file not found` ab — es ist hier die falsche Prüfung.

5. **Dienst starten und nachsehen:**
   ```bash
   sudo systemctl start ironcrew
   journalctl -u ironcrew -f
   ```
   Achte auf `scheduler started` — erst dann arbeitet die Firma wieder von
   selbst.

Hast du das falsche Archiv erwischt: die beiseitegelegte Datei zurückbenennen.
Genau dafür liegt sie da.

## Einen Restore üben, ohne die Produktion anzufassen

```bash
node scripts/ironcrew-backup.mjs --restore <archiv> --db /tmp/probe.sqlite
sqlite3 /tmp/probe.sqlite "SELECT COUNT(*) FROM crew_tasks;"
```

Das Ziel ist ein anderer Pfad, der Dienst läuft weiter. Mach das einmal nach
der Einrichtung und danach zweimal im Jahr. Es dauert zwei Minuten und ist der
Unterschied zwischen einem Backup und einer Vermutung.

## Was ein Restore nicht wiederherstellt

- **Die Env-Datei** mit Tokens und Passwörtern (siehe oben).
- **CLI-Anmeldungen** der Runtimes unter `/var/lib/ironcrew/.claude` und
  vergleichbaren Pfaden — die musst du als Service-User neu anmelden, falls du
  auf eine neue Maschine umziehst.
- **Laufende Läufe.** Was zum Zeitpunkt des Snapshots lief, ist danach ein
  Lauf ohne Prozess. Die Lease läuft ab und die Warteschlange nimmt die
  Anfrage beim nächsten Durchlauf erneut auf (`docs/RUN_QUEUE.md`).
