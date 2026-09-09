import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// These exact disposable localhost fixtures are already public. A path alone
// must never exempt replacement credentials, including historical versions.
const publicFixtures = new Map([
  [
    "next/tests/integration/worker-fixtures/key.pem",
    "e98a530025f891eb65c1d6c01aafba34384bec8b4a503ac35a409ec71e9ec79e",
  ],
  [
    "next/tests/integration/worker-fixtures/cert.pem",
    "1b4af99fd39f534103d45c1e895fc7c5224e51c3826a4583b5374152c89f2d92",
  ],
]);
const credentialPath =
  /(^|\/)(id_rsa|id_ed25519)$|\.(pem|key|p12|pfx|cer|crt)$|(^|\/)credentials\.json$|(^|\/)secrets[^/]*\.json$/;
const secretPattern =
  "(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----)";

const redactionPaths = ["server/ironcrew/security/redaction.test.ts", "server/ironcommand/security/redaction.test.ts"];
// Exact synthetic token specimens documented by .gitleaks.toml and the
// redaction tests, including their pre-rename paths. Hash the complete token,
// not just the prefix matched by Git's fixed-length provider patterns.
const syntheticTokens = new Map([
  [
    "03aafb028d538b06c4341bf8cf2a692a3c6d1f36e34e0e0b376f407c6117a246",
    [".gitleaks.toml", "server/test/oauth/encryption.test.ts"],
  ],
  [
    "c363c84107e7366590728f1a3570e8311d6fe1df1912d9f07ad3afb2eaff8979",
    [
      "server/ironcrew/packs/business-dashboard.test.ts",
      "server/ironcrew/policy/company-configuration-store.test.ts",
      "server/ironcrew/policy/company-policy-store.test.ts",
    ],
  ],
  [
    "fc25e1a8a3075e9f2e1a457f7b25351671610c2115c3b4d5633458a55e478823",
    [...redactionPaths, "server/ironcrew/runtime/run-store.test.ts", "server/ironcommand/runtime/run-store.test.ts"],
  ],
  ["fca77af53e4a95471187f0ef4e080f00782a05c38e1b811b13a82eb9f68bfcef", redactionPaths],
  ["108213c5f652394eca46eaadc7a540730b5b7ee86b9b8c954c53ad63bc10a16b", redactionPaths],
  ["1a5d44a2dca19669d72edf4c4f1c27c4c1ca4b4408fbb17f6ce4ad452d78ddb3", redactionPaths],
]);

function hasUnexpectedSecret(path, bytes) {
  let content = bytes.toString("utf8").replace(/[A-Za-z0-9_-]+/g, (token) => {
    const digest = createHash("sha256").update(token).digest("hex");
    return syntheticTokens.get(digest)?.includes(path) ? "" : token;
  });
  if (redactionPaths.includes(path)) {
    // Match the complete deliberately invalid, escaped test block. Exempting
    // its header alone would accidentally exempt real private keys too.
    const fakePem =
      ["-----BEGIN", "OPENSSH PRIVATE", "KEY-----"].join(" ") +
      "\\nAAAAB3NzaC1yc2E\\nMOREKEYMATERIAL\\n-----END OPENSSH PRIVATE KEY-----";
    content = content.replaceAll(fakePem, "");
  }
  return new RegExp(secretPattern).test(content);
}

function knownPublicFixture(path, bytes) {
  return publicFixtures.get(path) === createHash("sha256").update(bytes).digest("hex");
}

export function scanPublicSecrets(root) {
  const git = (args) =>
    execFileSync("git", args, { cwd: root, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const split = (bytes) => bytes.toString("utf8").split("\0").filter(Boolean);
  const matches = (revision) => {
    try {
      return split(
        git([
          "grep",
          "-lzI",
          "-E",
          secretPattern,
          ...(revision ? [revision] : []),
          "--",
          ".",
          ":(exclude).env.example",
        ]),
      );
    } catch (error) {
      if (error.status === 1) return [];
      // Git may include matched content in error output; do not forward it.
      throw new Error("Git secret scan failed; verification is incomplete.");
    }
  };
  const findings = [];
  const tracked = split(git(["ls-files", "-z"]));
  const current = new Set([...tracked.filter((path) => credentialPath.test(path)), ...matches()]);
  for (const path of current) {
    let bytes;
    try {
      bytes = readFileSync(resolve(root, path));
    } catch {
      findings.push({ scope: "working tree", path, reason: "Tracked file cannot be verified" });
      continue;
    }
    if (!knownPublicFixture(path, bytes) && (credentialPath.test(path) || hasUnexpectedSecret(path, bytes))) {
      findings.push({
        scope: "working tree",
        path,
        reason: credentialPath.test(path) ? "Credential/key file is tracked" : "Potential secret pattern",
      });
    }
  }
  const revisions = git(["rev-list", "--all"]).toString("utf8").trim().split("\n").filter(Boolean);
  const checkedBlobs = new Set();
  for (const revision of revisions) {
    for (const entry of matches(revision)) {
      const path = entry.slice(revision.length + 1);
      const blob = git(["rev-parse", `${revision}:${path}`])
        .toString("utf8")
        .trim();
      const key = `${path}\0${blob}`;
      if (checkedBlobs.has(key)) continue;
      checkedBlobs.add(key);
      const bytes = git(["cat-file", "blob", blob]);
      if (!knownPublicFixture(path, bytes) && hasUnexpectedSecret(path, bytes)) {
        findings.push({ scope: "history", revision, path, reason: "Potential secret pattern" });
      }
    }
  }
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const findings = scanPublicSecrets(process.cwd());
    for (const finding of findings) console.error(JSON.stringify(finding));
    process.exitCode = findings.length ? 1 : 0;
  } catch {
    console.error("Secret scan failed; verification is incomplete.");
    process.exitCode = 1;
  }
}
