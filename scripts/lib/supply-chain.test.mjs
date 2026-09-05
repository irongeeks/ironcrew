import { describe, it, expect } from "vitest";
import { inventory, licenseFindings, cyclonedx } from "./supply-chain.mjs";
describe("production dependency evidence", () => {
  it("fails unknown or changed licenses instead of allowing all versions of a vendor", () => {
    const known = { name: "existing", version: "1.0", license: "Custom" };
    expect(licenseFindings([known], [known])).toEqual([]);
    expect(licenseFindings([{ ...known, version: "2.0" }], [known])).toHaveLength(1);
    expect(licenseFindings([{ name: "new", version: "1", license: "Unknown" }], [known])).toHaveLength(1);
  });
  it("emits versioned component evidence without local filesystem paths", () => {
    const components = inventory({
      MIT: [{ name: "@example/library", versions: ["1.2.3"], paths: ["/private/home/secrets"] }],
    });
    const report = cyclonedx(components, { name: "ironcrew", version: "1" });
    expect(report).toMatchObject({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: [{ purl: "pkg:npm/%40example/library@1.2.3" }],
    });
    expect(JSON.stringify(report)).not.toContain("/private/");
    expect(() => inventory({})).toThrow();
  });
});
