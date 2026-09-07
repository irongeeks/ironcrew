# Geplante Backups bei belegter Schreibsperre

Ein kurzzeitig belegter Online-Snapshot darf einen geplanten Backuptermin nicht verbrauchen. Nur der garantierte Vorabfehler `DomainError("backup_busy")` wird deshalb als `deferred` gespeichert. Zu diesem Zeitpunkt hat die Snapshotfunktion noch keinen Archivworker gestartet.

Die Policy behält den ursprünglichen `nextDueAt`-Termin und lokalen Cron-Slot, erhält aber `retryNotBefore` 30 Sekunden später. Der nächste zulässige Tick versucht genau diesen Termin erneut. Diese Daten liegen in der Datenbank und bleiben bei einem Neustart erhalten. Neuere CEO-Änderungen an der Policy haben Vorrang. Ein erfolgreicher Versuch schiebt die Policy auf den regulären nächsten Cron-Termin.

Andere Fehler, insbesondere Timeout oder abgebrochene Archivierung, bleiben `effect_unknown` und lösen keinen automatischen zweiten Versuch im selben Termin aus. Tests in `tests/integration/maintenance.test.ts` prüfen beide Fälle mit echter age-Verschlüsselung, vorheriger Restoreprobe und steuerbarer Uhr.
