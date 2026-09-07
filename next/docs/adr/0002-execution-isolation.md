# ADR 0002 — Vertrauenswürdige Testfixtures und gesperrte freie Ausführung

Für M1 ist ausschließlich ein administrativ registrierter, hashgebundener Node-Test erlaubt. Ein eigener Kindprozess erhält eine neu aufgebaute Allowlist-Umgebung, Node-Dateirechte für den Workspace, keine Childprocess-/Worker-/Addon-Freigaben, Zeit- und Ausgabelimit. Node-Testmodule laufen direkt, da der CLI-Testdateiscanner zusätzliche Elternpfadzugriffe voraussetzen kann. Der Test führt reale Behauptungen gegen die geänderte Datei aus.

Diese Grenze ist **keine behauptete OS-Sandbox für beliebig erzeugten Code**. `workspace.execute` bleibt fail-closed (`isolation_profile_unverified`). Freie Builds brauchen die vorgeschriebenen OS-/VM-Profile mit nachgewiesenem Dateisystem-, Netzwerk-, Prozess- und Ressourcenabschluss. Pfadprüfungen verhindern Traversal, Symlinks, Hardlinks, Windows-Gerätenamen und verbotene Betriebspfade; adversariale parallele Dateisystemmutation durch einen fremden Prozess ist separat mit OS-Isolation nachzuweisen.

Ausführungsbeleg wird lokal vor einer Wirkung synchronisiert. Ein beim Wiederanlauf nur gestarteter Beleg liefert effect_unknown. Vollständige Ergebnisse werden erneut übertragen, nicht erneut ausgeführt. Kein Exactly-once-Versprechen über externe Systeme.
