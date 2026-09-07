# Linux-Ausführung mit geprüftem Profil

`workspace.execute` führt frei generierten Code erst aus, wenn derselbe Prozess ein Linux-Profil erfolgreich geprüft hat. Ein JSON-Feld, eine gespeicherte Attestation oder ein Remote-Worker-Status aktiviert keine Fähigkeit. `loadExecutionPort(profilePath)` prüft 17 echte Angriffe, wenn PHP enthalten ist (16 ohne PHP), und registriert ausschließlich die bestandene Instanz in einem privaten WeakSet. Native macOS-/Windows-Ausführung bleibt gesperrt.

## Grenze und Nachweis

- bubblewrap **0.12.0**, kein setuid, separater User-/Mount-/PID-/Netz-/IPC-/UTS-/Cgroup-Namespace, neue Sitzung, keine Linux-Capabilities und `no_new_privs`.
- Architekturgebundener seccomp-Filter: unter anderem keine neuen Namespaces, Mounts, ptrace/process_vm, Module, BPF, Kernel-Keyring und Terminal-Injection. `clone3` fällt kontrolliert auf den begrenzten klassischen Clone-Aufruf zurück.
- Delegierter Cgroup-v2-Teilbaum: RAM, Swap=0, Prozesse/Threads, CPU-Quote, Timeout und vollständiger `cgroup.kill` einschließlich abgekoppelter Kinder. Echte `memory.events`, `pids.events` und `cpu.stat` belegen das Erzwingen.
- Schreibbares `/workspace` und `/tmp` liegen ausschließlich in begrenzten tmpfs. Kein beschreibbarer Hostmount, kein Host-Docker-/DBus-/SSH-Socket, kein Netz, keine geerbten Secrets.
- Eingaben werden vor Ausführung in eine private Quarantänekopie übernommen. Alle Verzeichnisse sind über FDs verankert; Symlinks, Hardlinks, Sonderdateien, Traversal und Geheimnispfade werden verworfen. Dateianzahl und Bytes sind begrenzt.
- Ausgaben verlassen den Namespace ausschließlich als begrenzte Bytes über eine Pipe. Der Host validiert Pfade, kanonisches Base64, Anzahl und Bytes erneut, schreibt neue private Dateien und berechnet SHA-256. Ein ungültiges Teilergebnis wird vollständig verworfen.
- Toolchainbaum, bwrap und seccomp werden gehasht; vor jeder Ausführung werden sie und die Boot-ID erneut geprüft. Profil und Attestation sind unveränderlich. Die Attestation läuft nach einer Stunde ab; ein neuer Start oder explizites erneutes Laden führt sämtliche Probes erneut aus.

Probes prüfen tatsächliche Ausführung, Node-Version, optional PHP, einen sonst erlaubten aber durch seccomp gesperrten Selbstzugriff über `process_vm_readv`, alle sieben Namespace-IDs, Capabilities/seccomp, Umgebung, Hostdateien, Host-PID, Netzverbindung, Prozess-/RAM-/CPU-/Log-/tmpfs-Limits, Symlink-Ausgabe und verschachtelte Usernamespaces. `tests/isolation/linux.ts` ergänzt echte Dateiübernahme, gefälschte Fähigkeiten, unveränderliche Einstellungen, Input-Hardlinks/Symlinks und abgekoppelte Kindprozesse. `tests/isolation/worker-native.ts` startet den wirklichen nativen Worker als Kindprozess, verbindet ihn über TLS/WSS und prüft ein generiertes Programm samt Ausgabehash.

Dies ist keine Behauptung, beliebige Kernel-Sicherheitslücken auszuschließen. Auf macOS/Windows bildet eine dedizierte Linux-VM zusätzlich eine Betriebssystemgrenze. Linux-Worker brauchen ein dediziertes Konto und eine vertrauenswürdige, administrativ verwaltete Installation. Das generierte Programm darf die Konfiguration oder die Betriebssystemdateien nicht selbst verwalten. Der Filter ist eine ergänzende Sperrliste; Namespaces, reduzierte Mounts, Cgroups und die äußere VM sind eigenständige Grenzen.

## Kompiliertes Installationspaket

In einer signierten Distribution liegen die Shell-/PowerShell-Skripte und diese Anleitung unter `dist/packages/tools/isolation/`; die CLI heißt dort `cli.js`. Bei den folgenden Quellkommandos deshalb `packages/tools/isolation/` durch `dist/packages/tools/isolation/` und `cli.ts` durch `cli.js` ersetzen. Die Entwicklungstests sind nicht Bestandteil des Installationspakets. Für die reguläre Profilabnahme den delegierten Launcher mit `cli.js attest /ABS/profile.json /ABS/evidence.json` starten; dabei laufen dieselben zwingenden Startup-Probes. Eine Distribution gehört zu ihrer signierten OS-/CPU-Plattform; ein macOS-Paket ist kein Linux-Paket.

## Direktes Linux-Profil

Die folgenden Installationsschritte gehören in eine **eigene Linux-VM oder einen dedizierten CI-Runner**. `bootstrap-lab.sh` verändert keine globale Node-/bwrap-Installation; Paketinstallation erfolgt ausdrücklich durch den Betreiber. Node 26.4.0 und bwrap 0.12.0 werden vor Entpacken gegen fest hinterlegte SHA-256 geprüft.

```bash
sudo apt-get update
sudo apt-get install build-essential meson ninja-build pkg-config libcap-dev curl xz-utils busybox-static php-cli
lab="$PWD/.var/linux-worker"
bash packages/tools/isolation/bootstrap-lab.sh "$lab"
nodebin="$lab/tooling/node/bin/node"
"$nodebin" packages/tools/isolation/cli.ts prepare "$lab/profile" "$lab/tooling/node" "$lab/tooling/bwrap-build/bwrap" /sys/fs/cgroup/ironcrew-worker /usr/bin/php
```

Unter Ubuntu 24.04 benötigt genau die administrative bwrap-Binärdatei eine AppArmor-Ausnahme für Usernamespaces. Keine globale Abschaltung:

```bash
printf 'profile ironcrew-bwrap "%s/tooling/bwrap-build/bwrap" flags=(unconfined) {\n userns,\n}\n' "$lab" > "$lab/bwrap.apparmor"
sudo install -m 0644 "$lab/bwrap.apparmor" /etc/apparmor.d/ironcrew-bwrap
sudo apparmor_parser -r /etc/apparmor.d/ironcrew-bwrap
sudo bash packages/tools/isolation/run-delegated.sh "$(id -un)" /sys/fs/cgroup/ironcrew-worker "$nodebin" "$PWD/tests/isolation/linux.ts" "$lab/profile/profile.json" "$lab/evidence.json"
```

Der explizite VM-Launcher richtet den eigenen Cgroup-Teilbaum ein, verschiebt den Supervisor hinein und gibt Root-Rechte vor Node ab. Im regulären systemd-Betrieb entsprechend `Delegate=cpu memory pids`, ein leeres delegierendes Eltern-Cgroup und einen `supervisor`-Unterbaum verwenden. Ein außerhalb dieses Teilbaums gestarteter Worker scheitert mit `worker_outside_delegated_cgroup`. Der Launcher ist kein universelles sudoers-Kommando für fremde Benutzer.

In `configuration.json` beziehungsweise `worker.json`:

```json
{ "isolationProfilePath": "/absolute/path/profile/profile.json" }
```

Die übrigen Konfigurationsfelder bleiben erforderlich. Control benötigt seine normale explizite Live-/Provider-Konfiguration. Ein Worker benötigt WSS-URL, Worker-ID, Token, Generation, CA und erlaubte Fähigkeiten. Kein Token wird in Profil oder Attestation gespeichert.

## Benutzbarer Mac-Betrieb: komplette Zentrale in eigener VZ-VM

Apple Silicon, bereits installiertes Lima und ein TLS-Zertifikat für `localhost` sind Voraussetzung. Der Launcher installiert keine Hostsoftware und verwendet ein **eigenes LIMA_HOME**, eigene VM `w`, 2 CPUs, 4 GiB RAM, 16 GiB Disk, `mounts: []`, kein Agent-/X11-Forwarding und `propagateProxyEnv: false`. Vorhandenes Lima/Colima bleibt unberührt. Die VM-Dateien bleiben nach `stop` für den nächsten Start erhalten.

Der Launcher akzeptiert außerdem ein gebautes Releasearchiv mit `package.json`, Lockfiles und `dist/`; die mitgelieferten Shell-/PowerShell-Dateien liegen dann in `dist/packages/tools/isolation/`. Er wählt die kompilierten `.js`-Entrypoints automatisch.

Ein vertrauenswürdiges Source-Archiv enthält den Inhalt von `next` mit Lockfile; keine Host-Secrets oder `node_modules` hineinpacken:

```bash
tar -czf /tmp/ironcrew-next-source.tgz apps packages scripts package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json
state="$HOME/.ironcrew-vm"
bash packages/tools/isolation/vm-lima.sh create "$state" control
bash packages/tools/isolation/vm-lima.sh prepare "$state" /tmp/ironcrew-next-source.tgz
bash packages/tools/isolation/vm-lima.sh start-control "$state" /absolute/control-configuration.json /absolute/localhost-cert.pem /absolute/localhost-key.pem
```

`start-control` läuft im Vordergrund. Es baut die Oberfläche in der VM, kopiert Konfiguration und TLS-Dateien einmalig in private Gastdateien, setzt den Gast-Profilpfad und startet die echte Zentrale. Das lokale einmalige Setup-Token erscheint nur im Startterminal. Im Mac-Browser `https://localhost:8790` öffnen; die Websitevorschau liegt auf dem eigenen Ursprung `http://127.0.0.1:8792`. Die Zertifikatskette muss vom Browser bereits akzeptiert sein; das Skript verändert keinen Host-Truststore. Nur diese beiden Ports werden auf Host-Loopback weitergeleitet, alle sonstigen automatischen Portforwards sind gesperrt. Die Sandboxprogramme selbst haben weiterhin keinerlei Netz.

Proton Pass/Providerzugang werden innerhalb der vertrauenswürdigen Gast-Zentrale eingerichtet; Host-Agenten und Host-Geheimnisverzeichnisse werden nicht gemountet. Konfiguration darf zuerst `{"version":1,"liveExecutionEnabled":false}` sein: Setup und Oberfläche funktionieren, kostenpflichtige Livearbeit bleibt bis zur expliziten Konfiguration aus.

```bash
bash packages/tools/isolation/vm-lima.sh stop "$state"
```

Für einen separaten ausgehenden WSS-Worker `create "$state" worker` und nach `prepare`:

```bash
bash packages/tools/isolation/vm-lima.sh start "$state" /absolute/enrollment.json /absolute/control-ca.pem
```

**Getrennte Zentrale und Worker:** Der attestierte Remote-ExecutionPort überträgt Eingabedateien, Artefakte und Logs über separate hashgeprüfte HTTPS-Streams. WSS bleibt auf 1 MiB Kontrollnachrichten begrenzt. `remoteWorkerId` bindet Runtime und Websitebuild an den eingeschriebenen Linux-Worker; ein fremdes `outputDirectory` wird niemals als Hostpfad übernommen. Der vollständige Mac-Zentralen-/Linux-Worker-Pfad wurde ohne Hostmounts tatsächlich geprüft. Einrichtung, Grenzen, Wiederaufnahme und Abbruch stehen in [remote-execution.md](../../../docs/remote-execution.md).

## Windows Hyper-V

`vm-hyperv.ps1` liefert einen expliziten Preflight und eine eigene Generation-2-VM. Windows Hyper-V muss bereits installiert sein. Der Betreiber liefert ein geprüftes Linux-VHDX samt erwartetem SHA-256 und einen vorhandenen, bewusst gewählten virtuellen Switch. Kein bestehender VM-/Switch-Umbau, kein Aktivieren von Windows-Features, kein globaler Dienstwechsel:

```powershell
.\packages\tools\isolation\vm-hyperv.ps1 -Vhdx C:\Images\ubuntu.vhdx -Sha256 <64-hex> -StateDirectory C:\IronCrewVm -SwitchName '<existing switch>'
# Nach erfolgreichem Preflight die explizite Erstellung:
.\packages\tools\isolation\vm-hyperv.ps1 -Vhdx C:\Images\ubuntu.vhdx -Sha256 <64-hex> -StateDirectory C:\IronCrewVm -SwitchName '<existing switch>' -Create -Start
```

2 CPUs, fest 4 GiB, keine Checkpoints/Autostarts, Microsoft-UEFI-CA für Linux, deaktivierte Integrationsdienste. Keine Laufwerke, Zwischenablage oder Agent-Sockets werden freigegeben. Linux anschließend per eigenem SSH-Schlüssel und `ForwardAgent=no` provisionieren; Dateien mit `scp -o ForwardAgent=no` bewusst übertragen. Die oben beschriebenen Linux-Probes sind Pflicht, bevor `workspace.execute` verfügbar ist. Hyper-V ist ein vorbereiteter Startpfad; in dieser Entwicklungssitzung wurde ausschließlich macOS/VZ/Linux real getestet, kein Windows-Pass behauptet.

## Nachweise und Quellen

`../.github/workflows/isolation.yml` führt auf Ubuntu 24.04 den echten Linux-Gate, den nativen WSS-Worker und beide Offline-Website-Builds aus. Fehlende Kernel-/AppArmor-/Cgroup-Unterstützung schlägt den Job fehl; es gibt keinen Skip oder Konfigurationsschalter zur Freigabe. Historische Testartefakte dieser Entwicklung liegen unter `.var/isolation-lab/evidence/` und werden nicht als künftige Attestation wiederverwendet.

- [bubblewrap 0.12.0 Release](https://github.com/containers/bubblewrap/releases/tag/v0.12.0): behebt unter anderem einen absoluten Symlink-Ausbruch beim Sandboxaufbau; ältere Versionen werden hier nicht akzeptiert.
- [bubblewrap Sicherheitsmodell](https://github.com/containers/bubblewrap/blob/main/SECURITY.md) und [Optionsreferenz](https://github.com/containers/bubblewrap/blob/main/bwrap.xml): der aufrufende Dienst muss die vollständige Sandboxpolicy konstruieren.
- [Linux Cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html) und [seccomp Filter](https://docs.kernel.org/userspace-api/seccomp_filter.html).
- [Ubuntu 24.04 Usernamespace-Regeln](https://documentation.ubuntu.com/release-notes/24.04/) erklären die pfadgebundene AppArmor-Ausnahme.
- [Lima Mounts](https://lima-vm.io/docs/config/mount/), [Portforwarding](https://lima-vm.io/docs/config/port/) und [Regelreihenfolge](https://github.com/lima-vm/lima/blob/master/templates/default.yaml).

- [Microsoft Hyper-V Integrationsdienste](https://github.com/MicrosoftDocs/windowsserverdocs/blob/main/WindowsServerDocs/virtualization/hyper-v/manage/Manage-Hyper-V-integration-services.md).
