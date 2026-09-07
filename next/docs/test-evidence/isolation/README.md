# Reale Isolationsnachweise – 7. September 2026

Getestet auf macOS/Apple Silicon mit einer eigenen Lima-2.1.3/VZ-VM, Ubuntu 24.04, Linux 6.8.0-117, Node 26.4.0 und SHA-geprüftem bubblewrap 0.12.0. Kein Colima-Umbau, keine Hostmounts oder weitergereichten SSH-Agenten. Die VM wurde nach den Tests gestoppt; gespeicherte Attestationen sind historische Belege und aktivieren keine zukünftige Ausführung.

- `linux-evidence.json`: 17 tatsächliche Startup-Probes, erzeugte Datei mit Rohbytes/SHA, Input-Symlink-/Hardlink- und Traversal-Abwehr, Fälschungsversuch gegen die Fähigkeit, unveränderliches Profil und vollständiges Beenden abgekoppelter Kinder samt leerer Cgroups.
- `worker-native-evidence.json`: wirklicher nativer Worker-Kindprozess; authentifiziertes TLS/WSS, Mandatsprüfung, generiertes Node-Programm, dauerhafte Ergebnisquittung und geprüftes Ausgabehashmanifest.
- `compiled-attestation.json`: die kompilierte Produktions-CLI unter `dist/` durchlief nach einem VM-Neustart erneut alle 17 Probes.
- `vm-control.json` und `vm-control-desktop.png`: kompilierte Zentrale und echte React-Gründungsoberfläche innerhalb der VM, vom Mac auf lokal weitergeleitetem HTTPS erreichbar. `curl` prüfte die explizite Test-CA. Die Browseraufnahme verwendete ausschließlich für das lokale Fixture `ignoreHTTPSErrors`; kein Host-Truststore wurde verändert und keine Live-Providerkosten ausgelöst.
- `launcher-control-vm.yaml`: vom echten Mac-Launcher generierte und durch Lima validierte Konfiguration. Kein Dateimount, keine Proxy-/Agentübernahme, nur zwei explizite GUI-Loopbackports; übrige TCP-/UDP-Forwards gesperrt.

Die separaten React-/WordPress-Archive, unveränderlichen Artefaktmetadaten und Buildnachweise liegen unter `../site-builds/`. Der echte WordPress/PHP/MariaDB-Test liegt unter `../wordpress-runtime/`.

Nicht nachgewiesen: native Windows-Ausführung oder ein echter Hyper-V-Start. `vm-hyperv.ps1` ist ein vorbereiteter, ausdrücklich als ungetestet markierter Windows-Preflight. Der allgemeine WSS-Transport von exportierten Dateibytes zwischen getrennten Hosts ist noch nicht implementiert; der vollständige Mac-Websitepfad verwendet deshalb Zentrale und ExecutionPort in derselben Linux-VM.
