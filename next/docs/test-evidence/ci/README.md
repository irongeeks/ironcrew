# CI-Nachweise

Jeder Unterordner enthält eine unveränderte `github-run.json` mit Run-URL, Quellcommit, Ergebnis und den damals verifizierten SHA-256-Werten. Die vollständigen Originalnachweise bleiben für die abschließenden Drei-OS-Matrizen `686022a` und `ebf3b98`, deren Linux-Isolation und den erfolgreichen nativen Windows-Lauf `native-e9734b0` erhalten.

Die Rohdateien der übrigen, überholten Zwischenläufe wurden am 9. September 2026 entfernt. Ihre Run-Metadaten und historischen Prüfaussagen bleiben nachvollziehbar; die darin aufgeführten `files` sind eine historische Inventur und keine Liste noch lokal vorhandener Dateien. Bei Bedarf sind die entfernten Daten im [Git-Stand vor der Bereinigung](https://github.com/irongeeks/ironcrew/tree/0521a90/next/docs/test-evidence/ci) verfügbar. Frühere Erfolge und Fehler bleiben ihrem eigenen Commit zugeordnet; sie sind keine Abnahme späterer Änderungen. Den aktuellen Abschlussstand nennt [verification.md](../../verification.md).

Bei erfolgreichen Drei-OS-Prüfungen werden die Manifestdateien unabhängig gegen Git geprüft. Die PowerShell-Datei erhält im frischen Checkout gemäß `.gitattributes` CRLF; diese nachgewiesene Normalisierung ist gesondert aufgeführt.

| Nachweis | Commit | Umgebung | Ergebnis |
| --- | --- | --- | --- |
| [549e037-macos-15](549e037-macos-15/github-run.json) | `549e037` | macos-15 | failure |
| [5eb531f-macos-15](5eb531f-macos-15/github-run.json) | `5eb531f` | macos-15 | success |
| [5eb531f-ubuntu-24.04](5eb531f-ubuntu-24.04/github-run.json) | `5eb531f` | ubuntu-24.04 | success |
| [686022a-macos-15](686022a-macos-15/github-run.json) | `686022a` | macos-15 | success |
| [686022a-ubuntu-24.04](686022a-ubuntu-24.04/github-run.json) | `686022a` | ubuntu-24.04 | success |
| [686022a-windows-2025](686022a-windows-2025/github-run.json) | `686022a` | windows-2025 | success |
| [6defe00-macos-15](6defe00-macos-15/github-run.json) | `6defe00` | macos-15 | success |
| [6defe00-ubuntu-24.04](6defe00-ubuntu-24.04/github-run.json) | `6defe00` | ubuntu-24.04 | success |
| [6defe00-windows-2025](6defe00-windows-2025/github-run.json) | `6defe00` | windows-2025 | failure |
| [7768fbe-macos-15](7768fbe-macos-15/github-run.json) | `7768fbe` | macos-15 | success |
| [7768fbe-ubuntu-24.04](7768fbe-ubuntu-24.04/github-run.json) | `7768fbe` | ubuntu-24.04 | success |
| [7768fbe-windows-2025](7768fbe-windows-2025/github-run.json) | `7768fbe` | windows-2025 | failure |
| [aabff77-windows-2025](aabff77-windows-2025/github-run.json) | `aabff77` | windows-2025 | failure |
| [b9d20e7-windows-2025](b9d20e7-windows-2025/github-run.json) | `b9d20e7` | windows-2025 | failure |
| [c5fd7ba-macos-15](c5fd7ba-macos-15/github-run.json) | `c5fd7ba` | macos-15 | success |
| [c5fd7ba-ubuntu-24.04](c5fd7ba-ubuntu-24.04/github-run.json) | `c5fd7ba` | ubuntu-24.04 | success |
| [d20a27f-macos-15](d20a27f-macos-15/github-run.json) | `d20a27f` | macos-15 | success |
| [d20a27f-ubuntu-24.04](d20a27f-ubuntu-24.04/github-run.json) | `d20a27f` | ubuntu-24.04 | success |
| [d20a27f-windows-2025](d20a27f-windows-2025/github-run.json) | `d20a27f` | windows-2025 | failure |
| [ebf3b98-macos-15](ebf3b98-macos-15/github-run.json) | `ebf3b98` | macos-15 | success |
| [ebf3b98-ubuntu-24.04](ebf3b98-ubuntu-24.04/github-run.json) | `ebf3b98` | ubuntu-24.04 | success |
| [ebf3b98-windows-2025](ebf3b98-windows-2025/github-run.json) | `ebf3b98` | windows-2025 | success |
| [linux-45fc8a4](linux-45fc8a4/github-run.json) | `45fc8a4` | Linux isolation | success |
| [linux-5eb531f](linux-5eb531f/github-run.json) | `5eb531f` | Linux isolation | success |
| [linux-686022a](linux-686022a/github-run.json) | `686022a` | Linux isolation | success |
| [linux-6defe00](linux-6defe00/github-run.json) | `6defe00` | Linux isolation | success |
| [linux-7768fbe](linux-7768fbe/github-run.json) | `7768fbe` | Linux isolation | success |
| [linux-aabff77](linux-aabff77/github-run.json) | `aabff77` | Linux isolation | success |
| [linux-be463c2](linux-be463c2/github-run.json) | `be463c2` | Linux isolation | success |
| [linux-d20a27f](linux-d20a27f/github-run.json) | `d20a27f` | Linux isolation | success |
| [linux-ebf3b98](linux-ebf3b98/github-run.json) | `ebf3b98` | Linux isolation | success |
| [native-154d8cc](native-154d8cc/github-run.json) | `154d8cc` | windows-2025 focused native diagnostics | failure |
| [native-3084e60](native-3084e60/github-run.json) | `3084e60` | windows-2025 focused native diagnostics | failure |
| [native-39cfa1c](native-39cfa1c/github-run.json) | `39cfa1c` | windows-2025 focused native diagnostics | failure |
| [native-549e037](native-549e037/github-run.json) | `549e037` | windows-2025 focused native diagnostics | failure |
| [native-a45574d](native-a45574d/github-run.json) | `a45574d` | windows-2025 focused native diagnostics | failure |
| [native-e9734b0](native-e9734b0/github-run.json) | `e9734b0` | windows-2025 focused native tests | success |
