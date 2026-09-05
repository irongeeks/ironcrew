// Local subprocess fixture. No providers, accounts, credential files or network.
const [provider, ...args] = process.argv.slice(2);
const mode = process.env.IRONCREW_CLI_FIXTURE_MODE ?? "normal";
if (args.includes("--version")) {
  process.stdout.write(`${provider} 9.1.0\n`);
  process.exit(0);
}
if (args.includes("--help")) {
  if (mode === "missing-stream") {
    process.stdout.write("Usage: CLI --help\n");
    process.exit(0);
  }
  if (args[0] === "auth" || args[0] === "login") {
    process.stdout.write(mode === "missing-auth" ? "login logout\n" : "Commands:\n status  Show local login status\n");
    process.exit(0);
  }
  const flags =
    "--print -p --verbose --output-format <format> stream-json --include-partial-messages --max-turns <n> --model -m --sandbox <mode> --json --approval-mode --permission-mode <mode>\n";
  process.stdout.write(`Usage: ${provider}\n${flags}`);
  if (mode !== "missing-resume")
    process.stdout.write(" --resume <id> --conversation <id>\n resume  Resume a SESSION_ID\n");
  process.stdout.write("Commands:\n exec  Execute\n auth  Authentication\n login  Authentication\n");
  process.exit(0);
}
if (args[1] === "status") {
  if (mode === "auth-unknown") {
    process.stdout.write("Unrecognized login diagnostic\n");
    process.exit(2);
  }
  if (provider === "claude")
    process.stdout.write(
      JSON.stringify({
        loggedIn: mode !== "logged-out",
        authMethod: "oauth_token",
        email: "sensitive-profile@example.invalid",
        accessToken: "never-expose-fixture",
      }),
    );
  else process.stderr.write(mode === "logged-out" ? "Not logged in\n" : "Logged in using ChatGPT\n");
  process.exitCode = mode === "logged-out" ? 1 : 0;
} else {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    stdin += chunk;
  });
  process.stdin.on("end", () => {
    const session = "session-fixture-001";
    const write = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
    const text = JSON.stringify({ args, stdin, text: "Grüße vom Prüfprozess" });
    if (provider === "codex") {
      write({ type: "thread.started", thread_id: session });
      write({ type: "item.completed", item: { type: "agent_message", text } });
      write(
        mode === "structured-error"
          ? { type: "turn.failed", error: { message: "Fixture failure" } }
          : { type: "turn.completed", usage: { input_tokens: 17, output_tokens: 9 } },
      );
    } else if (provider === "antigravity") {
      write({ event: "init", init: { conversation_id: session } });
      write({ event: "result", result: { conversation_id: session, response: text, status: "SUCCESS" } });
    } else {
      write({ type: "system", subtype: "init", session_id: session });
      const bytes = Buffer.from(
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n",
      );
      const split = bytes.indexOf(Buffer.from("ü")) + 1;
      process.stdout.write(bytes.subarray(0, split));
      setImmediate(() => {
        process.stdout.write(bytes.subarray(split));
        write({ type: "result", session_id: session, usage: { input_tokens: 17, output_tokens: 9 } });
      });
    }
  });
}
