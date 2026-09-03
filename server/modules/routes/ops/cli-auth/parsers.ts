export interface ParsedAuthOutput {
  verificationUrl: string | null;
  deviceCode: string | null;
  needsInput: boolean;
}

// Trim trailing punctuation that CLIs may append after URLs
function cleanUrl(url: string): string {
  return url.replace(/[.,)>'"]+$/, "");
}

// Detect if the CLI is waiting for user to paste an auth code back
function detectNeedsInput(stdout: string): boolean {
  return /paste|enter.*code|authorization code|enter the code/i.test(stdout);
}

export function parseClaudeOutput(stdout: string): ParsedAuthOutput {
  const urlMatch = stdout.match(/(https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s]+)/);
  // claude setup-token shows "Paste code here if prompted >" after browser auth.
  // The URL is shown in the Ink UI, and the user gets a code in the browser
  // that must be pasted back via the PTY stdin.
  const hasPrompt = /paste.*code/i.test(stdout);
  return {
    verificationUrl: urlMatch ? cleanUrl(urlMatch[1]) : null,
    deviceCode: null,
    needsInput: Boolean(urlMatch) || hasPrompt || detectNeedsInput(stdout),
  };
}

export function parseCodexOutput(stdout: string): ParsedAuthOutput {
  const codeMatch = stdout.match(/code[:\s]+([A-Z0-9-]+)/i);
  const urlMatch = stdout.match(/(https:\/\/auth\.openai\.com[^\s]+)/);
  return {
    verificationUrl: urlMatch ? cleanUrl(urlMatch[1]) : null,
    deviceCode: codeMatch?.[1] ?? null,
    needsInput: detectNeedsInput(stdout),
  };
}

export function parseGeminiOutput(stdout: string): ParsedAuthOutput {
  const urlMatch = stdout.match(/(https:\/\/accounts\.google\.com[^\s]+)/);
  return {
    verificationUrl: urlMatch ? cleanUrl(urlMatch[1]) : null,
    deviceCode: null,
    needsInput: detectNeedsInput(stdout),
  };
}

const parserMap: Record<string, (stdout: string) => ParsedAuthOutput> = {
  claude: parseClaudeOutput,
  codex: parseCodexOutput,
  gemini: parseGeminiOutput,
};

export function parseProviderOutput(provider: string, stdout: string): ParsedAuthOutput {
  const parser = parserMap[provider];
  if (!parser) return { verificationUrl: null, deviceCode: null, needsInput: false };
  return parser(stdout);
}
