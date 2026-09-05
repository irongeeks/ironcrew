#!/usr/bin/env node
import process from "node:process";
import console from "node:console";
import { createReleasePackage } from "../lib/release-packaging.mjs";
const [commit, outDir] = process.argv.slice(2);
if (!commit || !outDir) throw new Error("Usage: node scripts/release/package.mjs COMMIT OUTPUT_DIRECTORY");
console.log(
  JSON.stringify(
    createReleasePackage({
      commit,
      outDir,
      imageDigest: process.env.RELEASE_IMAGE_DIGEST ?? null,
      repository: process.env.GITHUB_REPOSITORY ?? "irongeeks/ironcrew",
    }),
    null,
    2,
  ),
);
