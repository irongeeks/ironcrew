/** CycloneDX 1.6 component inventory from pnpm's installed production license report.
 * This reports inventory, not a reconstructed dependency graph or legal clearance. */
export const standardLicenses = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-3-Clause",
  "BSD-2-Clause",
  "ISC",
  "Unlicense",
  "MIT-0",
  "0BSD",
  "MIT AND ISC",
  "(MIT OR EUPL-1.1+)",
  "Python-2.0",
  "CC-BY-4.0",
  "MPL-2.0",
  "LGPL-3.0-or-later",
]);
export function inventory(licenses) {
  if (!licenses || typeof licenses !== "object" || Array.isArray(licenses))
    throw new Error("Invalid pnpm license report.");
  const components = [];
  for (const [license, packages] of Object.entries(licenses)) {
    if (!Array.isArray(packages)) throw new Error("Invalid license package group.");
    for (const pkg of packages) {
      if (
        typeof pkg.name !== "string" ||
        !Array.isArray(pkg.versions) ||
        pkg.versions.some((v) => typeof v !== "string")
      )
        throw new Error("Incomplete package identity.");
      for (const version of pkg.versions) components.push({ name: pkg.name, version, license });
    }
  }
  if (components.length === 0) throw new Error("License report must contain installed production components.");
  return components.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}
export function licenseFindings(components, baseline) {
  return components.filter(
    (component) =>
      !standardLicenses.has(component.license) &&
      !baseline.some(
        (known) =>
          known.name === component.name && known.version === component.version && known.license === component.license,
      ),
  );
}
export function cyclonedx(components, app) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { component: { type: "application", name: app.name, version: app.version } },
    components: components.map(({ name, version, license }) => ({
      type: "library",
      name,
      version,
      "bom-ref": `${name}@${version}`,
      purl: `pkg:npm/${name.replace("@", "%40")}@${encodeURIComponent(version)}`,
      licenses: [{ license: { name: license } }],
    })),
  };
}
