import fs from "node:fs";
import path from "node:path";

type SignalPattern = {
  key: string;
  regex: RegExp;
};

const REMOTION_PATTERNS: SignalPattern[] = [
  { key: "remotion_render", regex: /\bremotion\s+render\b/i },
  { key: "remotion_browser_ensure", regex: /\bremotion\s+browser\s+ensure\b/i },
  { key: "remotion_package", regex: /@remotion\//i },
  { key: "remotion_register_root", regex: /\bregisterRoot\b/i },
];

const COMFYUI_PATTERNS: SignalPattern[] = [
  { key: "comfyui_prompt", regex: /\bcomfyui\b.*\bprompt\b/i },
  { key: "comfyui_api", regex: /\/api\/prompt|\/history\//i },
  { key: "comfyui_workflow", regex: /\bcomfyui\b.*\bworkflow\b/i },
];

const FORBIDDEN_USAGE_PATTERNS: SignalPattern[] = [
  { key: "moviepy_import", regex: /\b(?:from|import)\s+moviepy\b/i },
  { key: "moviepy_usage", regex: /\bmoviepy\b.{0,64}\b(using|use|render|build|create|generate|generated)\b/i },
  { key: "moviepy_usage_rev", regex: /\b(using|use|render|build|create|generate)\b.{0,64}\bmoviepy\b/i },
  { key: "python_moviepy", regex: /\bpython\b.{0,64}\bmoviepy\b/i },
  { key: "pillow_import", regex: /\b(?:from|import)\s+PIL\b/i },
  { key: "pillow_usage", regex: /\bpillow\b.{0,64}\b(using|use|render|build|create|generate|generated)\b/i },
  { key: "pillow_usage_rev", regex: /\b(using|use|render|build|create|generate)\b.{0,64}\bpillow\b/i },
  { key: "python_pillow", regex: /\bpython\b.{0,64}\bpillow\b/i },
  { key: "pip_moviepy", regex: /\bpip(?:3)?\s+install\b.{0,64}\bmoviepy\b/i },
  { key: "pip_pillow", regex: /\bpip(?:3)?\s+install\b.{0,64}\bpillow\b/i },
];

const NEGATION_HINT =
  /(do not|don't|never|not\s+use|forbidden|prohibit|prohibited|not\s+allowed|without|remotion\s+only|no\s+(?:python|moviepy|pillow|ffmpeg)|금지|쓰지\s*마|사용\s*금지|사용하지\s*마|미사용|禁止|不要|禁用|不可使用)/i;
const THINKING_STREAM_HINT = /"type":"thinking(?:_delta)?"|"thinking":/i;

function hasNegationHint(line: string): boolean {
  return NEGATION_HINT.test(line);
}

function isReasoningStreamLine(line: string): boolean {
  return THINKING_STREAM_HINT.test(line);
}

function detectSignals(text: string): {
  remotionSignals: string[];
  comfyuiSignals: string[];
  forbiddenSignals: string[];
} {
  const remotionSignals: string[] = [];
  for (const pattern of REMOTION_PATTERNS) {
    if (pattern.regex.test(text)) remotionSignals.push(pattern.key);
  }

  const comfyuiSignals: string[] = [];
  for (const pattern of COMFYUI_PATTERNS) {
    if (pattern.regex.test(text)) comfyuiSignals.push(pattern.key);
  }

  const forbiddenSignals = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = String(rawLine ?? "");
    if (!line) continue;
    // Claude/Codex reasoning stream can mention banned engines in policy context.
    // Treat only execution/report content as policy evidence.
    if (isReasoningStreamLine(line)) continue;
    if (hasNegationHint(line)) continue;
    for (const pattern of FORBIDDEN_USAGE_PATTERNS) {
      if (pattern.regex.test(line)) {
        forbiddenSignals.add(pattern.key);
      }
    }
  }

  return {
    remotionSignals,
    comfyuiSignals,
    forbiddenSignals: [...forbiddenSignals],
  };
}

export type RemotionGateScan = {
  taskId: string;
  foundLog: boolean;
  remotionSignals: string[];
  comfyuiSignals: string[];
  forbiddenSignals: string[];
};

export type RemotionGateResult = {
  passed: boolean;
  checkedTaskIds: string[];
  remotionEvidenceTaskIds: string[];
  comfyuiEvidenceTaskIds: string[];
  forbiddenEngineTaskIds: string[];
  scans: RemotionGateScan[];
};

export function evaluateRemotionOnlyGateFromLogFiles(args: { logsDir: string; taskIds: string[] }): RemotionGateResult {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of args.taskIds) {
    const id = String(raw ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  const scans: RemotionGateScan[] = ids.map((taskId) => {
    const logPath = path.join(args.logsDir, `${taskId}.log`);
    let source = "";
    try {
      if (fs.existsSync(logPath)) {
        source = fs.readFileSync(logPath, "utf8");
      }
    } catch {
      source = "";
    }

    const foundLog = source.length > 0;
    const signals = foundLog
      ? detectSignals(source)
      : { remotionSignals: [], comfyuiSignals: [], forbiddenSignals: [] };
    return {
      taskId,
      foundLog,
      remotionSignals: signals.remotionSignals,
      comfyuiSignals: signals.comfyuiSignals,
      forbiddenSignals: signals.forbiddenSignals,
    };
  });

  const remotionEvidenceTaskIds = scans.filter((scan) => scan.remotionSignals.length > 0).map((scan) => scan.taskId);
  const comfyuiEvidenceTaskIds = scans.filter((scan) => scan.comfyuiSignals.length > 0).map((scan) => scan.taskId);
  const forbiddenEngineTaskIds = scans.filter((scan) => scan.forbiddenSignals.length > 0).map((scan) => scan.taskId);

  // Gate passes if EITHER Remotion OR ComfyUI evidence is found (and no forbidden engines)
  const hasValidEngine = remotionEvidenceTaskIds.length > 0 || comfyuiEvidenceTaskIds.length > 0;

  return {
    passed: hasValidEngine && forbiddenEngineTaskIds.length === 0,
    checkedTaskIds: ids,
    remotionEvidenceTaskIds,
    comfyuiEvidenceTaskIds,
    forbiddenEngineTaskIds,
    scans,
  };
}
