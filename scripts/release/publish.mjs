#!/usr/bin/env node
import process from "node:process";
import console from "node:console";
import { githubClient, publishRelease } from "../lib/release-github.mjs";
console.log(
  await publishRelease({
    api: githubClient({ token: process.env.GH_TOKEN }),
    repository: process.env.GITHUB_REPOSITORY,
    outDir: process.argv[2],
  }),
);
