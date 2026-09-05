/** Pure renderers shared by install tooling and Linux/macOS CI. No shell evaluation. */
import path from "node:path";
const xml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const unit = (value, expandEnvironment = false) =>
  '"' +
  String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => (expandEnvironment ? "$$" : "$")) +
  '"';
export function serviceOptions(input = {}) {
  const options = {
    platform: input.platform ?? process.platform,
    role: input.role ?? "control",
    prefix: input.prefix ?? "/opt/ironcrew",
    node: input.node ?? process.execPath,
    user: input.user ?? (input.role === "runner" ? "ironcrew-runner" : "ironcrew"),
    group: input.group ?? "ironcrew",
    envFile: input.envFile ?? `/etc/ironcrew/${input.role === "runner" ? "runner" : "ironcrew"}.env`,
  };
  if (!["linux", "darwin"].includes(options.platform) || !["control", "runner"].includes(options.role))
    throw new Error("Supported platforms: linux/darwin; roles: control/runner.");
  for (const key of ["prefix", "node", "envFile"]) {
    if (!path.isAbsolute(options[key]) || /[\r\n\0]/.test(options[key]))
      throw new Error(`${key} must be an absolute path without control characters.`);
  }
  for (const key of ["user", "group"]) {
    if (!/^[a-z_][a-z0-9_-]{0,30}$/.test(options[key]) || options[key] === "root")
      throw new Error(`Invalid dedicated service ${key}.`);
  }
  return options;
}
export function renderService(input = {}) {
  const o = serviceOptions(input);
  const runner = o.role === "runner";
  const name = runner ? "ironcrew-runner" : "ironcrew";
  const home = `/var/lib/${o.user}`;
  const args = [o.node, `${o.prefix}/scripts/service-start.mjs`, o.envFile, o.role];
  if (o.platform === "darwin")
    return {
      name: `eu.irongeeks.${name}.plist`,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>eu.irongeeks.${name}</string>
<key>UserName</key><string>${xml(o.user)}</string>
<key>GroupName</key><string>${xml(o.group)}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(o.prefix)}</string>
<key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>production</string><key>HOME</key><string>${xml(home)}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>30</integer>
<key>Umask</key><integer>23</integer>
<key>StandardOutPath</key><string>${xml(home)}/service.log</string>
<key>StandardErrorPath</key><string>${xml(home)}/service-error.log</string>
</dict></plist>
`,
    };
  return {
    name: `${name}.service`,
    content: `[Unit]
Description=IronCrew ${runner ? "native runner" : "control plane"}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=${o.user}
Group=${o.group}
WorkingDirectory=${unit(o.prefix)}
ExecStart=${args.map((arg) => unit(arg, true)).join(" ")}
Environment=NODE_ENV=production
Environment=HOME=${home}
Restart=on-failure
RestartSec=10
TimeoutStopSec=30
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=${unit(home)} ${runner ? "" : unit(`${o.prefix}/data`)} ${unit("/var/lib/ironcrew-workspaces")}
${runner ? "RuntimeDirectory=ironcrew\nRuntimeDirectoryMode=0750\n" : ""}
[Install]
WantedBy=multi-user.target
`,
  };
}
