import { useCallback, useEffect, useMemo, useState } from "react";

interface CronPickerProps {
  value: string;
  onChange: (cron: string) => void;
  timezone: string;
}

type Preset = "daily" | "weekly" | "monthly" | null;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function detectPreset(cron: string): { preset: Preset; hour: number; minute: number; weekday: number; dom: number } {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { preset: null, hour: 9, minute: 0, weekday: 1, dom: 1 };

  const [minPart, hourPart, domPart, monPart, dowPart] = parts;
  const minute = parseInt(minPart, 10);
  const hour = parseInt(hourPart, 10);

  if (isNaN(minute) || isNaN(hour)) return { preset: null, hour: 9, minute: 0, weekday: 1, dom: 1 };

  // Daily: M H * * *
  if (domPart === "*" && monPart === "*" && dowPart === "*") {
    return { preset: "daily", hour, minute, weekday: 1, dom: 1 };
  }

  // Weekly: M H * * N
  if (domPart === "*" && monPart === "*" && /^\d$/.test(dowPart)) {
    return { preset: "weekly", hour, minute, weekday: parseInt(dowPart, 10), dom: 1 };
  }

  // Monthly: M H D * *
  if (/^\d{1,2}$/.test(domPart) && monPart === "*" && dowPart === "*") {
    return { preset: "monthly", hour, minute, weekday: 1, dom: parseInt(domPart, 10) };
  }

  return { preset: null, hour, minute, weekday: 1, dom: 1 };
}

function buildCron(preset: Preset, hour: number, minute: number, weekday: number, dom: number): string {
  switch (preset) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${weekday}`;
    case "monthly":
      return `${minute} ${hour} ${dom} * *`;
    default:
      return `${minute} ${hour} * * *`;
  }
}

function getTzParts(date: Date, tz: string): { h: number; m: number; d: number; dow: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    day: "numeric",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  // hour12:false can yield "24" for midnight in some environments; normalise to 0
  const h = parseInt(get("hour"), 10) % 24;
  const m = parseInt(get("minute"), 10);
  const d = parseInt(get("day"), 10);
  const dowStr = get("weekday");
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dow = DAYS.indexOf(dowStr);
  return { h, m, d, dow: dow === -1 ? 0 : dow };
}

function computeNextRuns(cron: string, count: number, tz: string): Date[] {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return [];

  const [minPart, hourPart, domPart, , dowPart] = parts;
  const cronMin = parseInt(minPart, 10);
  const cronHour = parseInt(hourPart, 10);

  if (isNaN(cronMin) || isNaN(cronHour)) return [];

  const hasDom = domPart !== "*" ? parseInt(domPart, 10) : null;
  const hasDow = dowPart !== "*" ? parseInt(dowPart, 10) : null;

  // Validate the timezone; fall back to UTC on error
  let resolvedTz = tz;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    resolvedTz = "UTC";
  }

  const results: Date[] = [];
  const now = new Date();
  const cursor = new Date(now);
  // Start from next minute
  cursor.setSeconds(0, 0);
  cursor.setTime(cursor.getTime() + 60_000);

  // Scan forward up to 400 days
  const limit = 400 * 24 * 60;
  let steps = 0;

  while (results.length < count && steps < limit) {
    const { h, m, d, dow } = getTzParts(cursor, resolvedTz);

    const matchMin = cronMin === m;
    const matchHour = cronHour === h;
    const matchDom = hasDom === null || hasDom === d;
    const matchDow = hasDow === null || hasDow === dow;

    if (matchMin && matchHour && matchDom && matchDow) {
      results.push(new Date(cursor));
    }

    cursor.setTime(cursor.getTime() + 60_000);
    steps++;
  }

  return results;
}

function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [minPart, hourPart, domPart, monPart, dowPart] = parts;
  const minute = parseInt(minPart, 10);
  const hour = parseInt(hourPart, 10);

  if (isNaN(minute) || isNaN(hour)) return cron;

  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  if (domPart === "*" && monPart === "*" && dowPart === "*") {
    return `Every day at ${timeStr}`;
  }
  if (domPart === "*" && monPart === "*" && /^\d$/.test(dowPart)) {
    return `Every ${WEEKDAYS[parseInt(dowPart, 10)] ?? dowPart} at ${timeStr}`;
  }
  if (/^\d{1,2}$/.test(domPart) && monPart === "*" && dowPart === "*") {
    return `Monthly on day ${domPart} at ${timeStr}`;
  }
  return cron;
}

export { cronToHuman };

export default function CronPicker({ value, onChange, timezone }: CronPickerProps) {
  const detected = useMemo(() => detectPreset(value), [value]);

  const [preset, setPreset] = useState<Preset>(detected.preset);
  const [hour, setHour] = useState(detected.hour);
  const [minute, setMinute] = useState(detected.minute);
  const [weekday, setWeekday] = useState(detected.weekday);
  const [dom, setDom] = useState(detected.dom);
  const [advanced, setAdvanced] = useState(detected.preset === null);
  const [rawCron, setRawCron] = useState(value);

  const emitChange = useCallback(
    (p: Preset, h: number, m: number, w: number, d: number) => {
      if (p) {
        const expr = buildCron(p, h, m, w, d);
        setRawCron(expr);
        onChange(expr);
      }
    },
    [onChange],
  );

  const handlePreset = (p: Preset) => {
    setPreset(p);
    setAdvanced(false);
    emitChange(p, hour, minute, weekday, dom);
  };

  const handleHour = (h: number) => {
    setHour(h);
    emitChange(preset, h, minute, weekday, dom);
  };
  const handleMinute = (m: number) => {
    setMinute(m);
    emitChange(preset, hour, m, weekday, dom);
  };
  const handleWeekday = (w: number) => {
    setWeekday(w);
    emitChange(preset, hour, minute, w, dom);
  };
  const handleDom = (d: number) => {
    setDom(d);
    emitChange(preset, hour, minute, weekday, d);
  };

  const handleAdvancedToggle = () => {
    if (!advanced) {
      setAdvanced(true);
      setPreset(null);
    } else {
      setAdvanced(false);
      const p = "daily" as Preset;
      setPreset(p);
      emitChange(p, hour, minute, weekday, dom);
    }
  };

  const handleRawChange = (expr: string) => {
    setRawCron(expr);
    const parts = expr.trim().split(/\s+/);
    if (parts.length === 5) {
      onChange(expr.trim());
    }
  };

  // Sync external value changes
  useEffect(() => {
    if (value !== rawCron) {
      const d = detectPreset(value);
      setRawCron(value);
      setHour(d.hour);
      setMinute(d.minute);
      setWeekday(d.weekday);
      setDom(d.dom);
      if (d.preset) {
        setPreset(d.preset);
        setAdvanced(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const nextRuns = useMemo(
    () => computeNextRuns(advanced ? rawCron : value, 5, timezone),
    [value, rawCron, advanced, timezone],
  );

  const inputStyle: React.CSSProperties = {
    background: "var(--th-input-bg)",
    border: "1px solid var(--th-input-border)",
    color: "var(--th-text-primary)",
    borderRadius: 6,
    padding: "4px 8px",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    outline: "none",
  };

  const presetBtnStyle = (active: boolean): React.CSSProperties => ({
    padding: "4px 12px",
    borderRadius: 6,
    border: active ? "1px solid var(--th-accent)" : "1px solid var(--th-card-border)",
    background: active ? "var(--th-accent)" : "var(--th-input-bg)",
    color: active ? "#fff" : "var(--th-text-secondary)",
    cursor: "pointer",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    fontWeight: 600,
    transition: "all 120ms",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Preset buttons */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          style={presetBtnStyle(preset === "daily" && !advanced)}
          onClick={() => handlePreset("daily")}
        >
          Daily
        </button>
        <button
          type="button"
          style={presetBtnStyle(preset === "weekly" && !advanced)}
          onClick={() => handlePreset("weekly")}
        >
          Weekly
        </button>
        <button
          type="button"
          style={presetBtnStyle(preset === "monthly" && !advanced)}
          onClick={() => handlePreset("monthly")}
        >
          Monthly
        </button>
        <button
          type="button"
          style={{
            ...presetBtnStyle(advanced),
            marginLeft: "auto",
          }}
          onClick={handleAdvancedToggle}
        >
          Advanced
        </button>
      </div>

      {/* Time picker (for presets) */}
      {!advanced && preset && (
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ color: "var(--th-text-secondary)", fontSize: 12 }}>
            Time:
            <input
              type="number"
              min={0}
              max={23}
              value={hour}
              onChange={(e) => handleHour(Math.max(0, Math.min(23, parseInt(e.target.value, 10) || 0)))}
              style={{ ...inputStyle, width: 52, marginLeft: 6 }}
            />
            <span style={{ color: "var(--th-text-tertiary)", margin: "0 4px" }}>:</span>
            <input
              type="number"
              min={0}
              max={59}
              value={minute}
              onChange={(e) => handleMinute(Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0)))}
              style={{ ...inputStyle, width: 52 }}
            />
          </label>

          {preset === "weekly" && (
            <label style={{ color: "var(--th-text-secondary)", fontSize: 12 }}>
              Day:
              <select
                value={weekday}
                onChange={(e) => handleWeekday(parseInt(e.target.value, 10))}
                style={{ ...inputStyle, marginLeft: 6 }}
              >
                {WEEKDAYS.map((d, i) => (
                  <option key={i} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          )}

          {preset === "monthly" && (
            <label style={{ color: "var(--th-text-secondary)", fontSize: 12 }}>
              Day of month:
              <input
                type="number"
                min={1}
                max={31}
                value={dom}
                onChange={(e) => handleDom(Math.max(1, Math.min(31, parseInt(e.target.value, 10) || 1)))}
                style={{ ...inputStyle, width: 52, marginLeft: 6 }}
              />
            </label>
          )}
        </div>
      )}

      {/* Advanced raw input */}
      {advanced && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ color: "var(--th-text-secondary)", fontSize: 11 }}>
            Cron expression (min hour dom mon dow):
          </label>
          <input
            type="text"
            value={rawCron}
            onChange={(e) => handleRawChange(e.target.value)}
            placeholder="0 9 * * *"
            style={{ ...inputStyle, width: "100%" }}
          />
        </div>
      )}

      {/* Next 5 runs */}
      {nextRuns.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ color: "var(--th-text-tertiary)", fontSize: 10, fontWeight: 600, letterSpacing: "0.05em" }}>
            NEXT 5 RUNS ({timezone})
          </span>
          {nextRuns.map((d, i) => (
            <span
              key={i}
              style={{
                color: "var(--th-text-secondary)",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
              }}
            >
              {d.toLocaleString(undefined, {
                timeZone: timezone,
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
