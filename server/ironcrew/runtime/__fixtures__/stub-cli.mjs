#!/usr/bin/env node
/**
 * Test fixture: a stand-in CLI process for CliAdapterRuntime integration
 * tests. It is a REAL process, spawned via node:child_process.spawn exactly
 * like a real claude/codex/gemini binary would be — this exercises the
 * actual spawn/stdin/stdout/stderr/exit pipeline. What it is NOT is a real
 * `claude`/`codex`/`gemini` CLI: no login exists in this environment, so
 * live provider verification stays documented as an open manual test
 * (docs/PROVIDER_AUTH.md, IMPLEMENTATION_STATUS.md).
 *
 * Scenario is selected by STUB_SCENARIO; output protocol shape by
 * STUB_PROTOCOL ("claude" | "codex" | "gemini"), so tests can exercise each
 * real adapter's own parseStreamChunk() rather than a synthetic shape.
 */

const scenario = process.env.STUB_SCENARIO ?? "success";
const protocol = process.env.STUB_PROTOCOL ?? "claude";

let stdinData = "";
process.stdin.on("data", (c) => {
  stdinData += c.toString("utf8");
});
process.stdin.on("end", () => run());
// Some scenarios don't wait on stdin at all (no prompt is written in the
// spawn-error test path); guard against never firing 'end'.
setTimeout(() => {
  if (!started) run();
}, 500);
let started = false;

function assistantLine(text) {
  if (protocol === "claude") return JSON.stringify({ type: "assistant", content: text });
  if (protocol === "codex") return JSON.stringify({ type: "output", content: text });
  return JSON.stringify({ type: "message", content: text });
}

function usageLine() {
  if (protocol === "claude") {
    return JSON.stringify({
      type: "result",
      usage: { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
      model: "claude-stub",
    });
  }
  // codex/gemini adapters do not parse a token_usage shape in this repo today.
  return null;
}

function subtaskLines() {
  if (protocol === "claude") {
    return [
      JSON.stringify({ type: "tool_use", tool: "Task", id: "sub-1", input: { description: "Recherche starten" } }),
      JSON.stringify({ type: "tool_result", tool: "Task", id: "sub-1" }),
    ];
  }
  if (protocol === "codex") {
    return [
      JSON.stringify({
        type: "item.started",
        item: { type: "collab_tool_call", tool: "spawn_agent", id: "sub-1", prompt: "Recherche starten" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "collab_tool_call", tool: "close_agent", receiver_thread_ids: ["sub-1"] },
      }),
    ];
  }
  return [
    JSON.stringify({ type: "message", content: '{"subtasks":[{"title":"Recherche starten"}]}' }),
    JSON.stringify({ type: "message", content: '{"subtask_done":"sub-1"}' }),
  ];
}

async function run() {
  started = true;
  const write = (line) => process.stdout.write(line + "\n");

  switch (scenario) {
    case "success": {
      write(assistantLine("Hallo "));
      await sleep(10);
      write(assistantLine("Welt."));
      const usage = usageLine();
      if (usage) write(usage);
      process.exit(0);
      break;
    }
    case "echo_stdin": {
      write(assistantLine(`echo:${stdinData}`));
      process.exit(0);
      break;
    }
    case "subagent": {
      const lines = subtaskLines();
      write(lines[0]);
      await sleep(5);
      write(lines[1]);
      process.exit(0);
      break;
    }
    case "secret": {
      // A fabricated, fragment-assembled secret-shaped string — not a real
      // credential, matching the pattern used in redaction.test.ts.
      const fakeKey = ["sk", "ant", "api03", "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"].join("-");
      write(assistantLine(`using key ${fakeKey} now`));
      process.exit(0);
      break;
    }
    case "split_secret": {
      // Emit the same fake secret split across two writes with a delay, to
      // prove the StreamRedactor chunk-boundary handling is actually wired
      // through this runtime, not just unit-tested in isolation.
      const fakeKey = ["sk", "ant", "api03", "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"].join("-");
      process.stdout.write(`{"type":"assistant","content":"key=${fakeKey.slice(0, 15)}`);
      await sleep(20);
      process.stdout.write(`${fakeKey.slice(15)} end"}\n`);
      process.exit(0);
      break;
    }
    case "fail": {
      write(assistantLine("starting..."));
      // process.exit() does not wait for pending async I/O — a write
      // immediately followed by exit() can be lost because pipes are
      // asynchronous. Waiting for the write callback guarantees the OS pipe
      // actually has the bytes before this process ends, so the test proves
      // CliAdapterRuntime's own behaviour rather than a fixture race.
      process.stderr.write("Error: something broke\n", () => process.exit(1));
      break;
    }
    case "rate_limit": {
      process.stderr.write("Error: rate limit exceeded, retry after 1s\n", () => process.exit(1));
      break;
    }
    case "ignore_sigterm": {
      process.on("SIGTERM", () => {});
      write(assistantLine("running forever"));
      setInterval(() => {}, 1000);
      break;
    }
    case "hang": {
      write(assistantLine("one line then silence"));
      setInterval(() => {}, 1000);
      break;
    }
    case "big": {
      const chunk = "x".repeat(1024);
      const line = assistantLine(chunk);
      const interval = setInterval(() => {
        write(line);
      }, 1);
      setTimeout(() => clearInterval(interval), 5000);
      break;
    }
    default:
      process.exit(1);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
