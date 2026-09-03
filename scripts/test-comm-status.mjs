#!/usr/bin/env node

process.env.COMM_TEST_RETRY_COUNT = "0";
process.env.COMM_TEST_SLA_MS = "3000";

const { main: runCommSuite } = await import("./qa/run-comm-suite.mjs");

await runCommSuite();
