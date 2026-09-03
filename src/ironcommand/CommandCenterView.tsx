/**
 * Iron Command OS — Command Center.
 *
 * A cinematic HUD built from accessible DOM, not a canvas. Everything here is
 * real backend state: agent status is derived server-side from the work an
 * agent actually holds, so a figure can never disagree with the control plane.
 *
 * There are no placeholder KPIs. Every figure comes from /api/ic/dashboard,
 * which reports its own source and read time.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./command-center.css";
import { api } from "./api.ts";
import {
  AGENT_STATUS_LABEL,
  BOARD_COLUMNS,
  TASK_STATUS_LABEL,
  type Agent,
  type Approval,
  type Dashboard,
  type Message,
  type RunEvent,
  type RuntimeInfo,
  type Task,
} from "./types.ts";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function eventKind(type: string): "error" | "decision" | "normal" {
  if (type === "run.failed" || type === "tool.failed" || type === "run.cancelled") return "error";
  if (type === "approval.required" || type === "rate_limit.detected" || type === "run.waiting") return "decision";
  return "normal";
}

export interface CommandCenterViewProps {
  /** Injected in tests; defaults to the live REST client. */
  client?: typeof api;
}

export function CommandCenterView({ client = api }: CommandCenterViewProps): React.JSX.Element {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [companyName, setCompanyName] = useState("Iron Command");
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  const logRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [a, t, c, ap, d] = await Promise.all([
        client.agents(),
        client.tasks(),
        client.chat(),
        client.approvals(),
        client.dashboard(),
      ]);
      setAgents(a.agents);
      setTasks(t.tasks);
      setMessages(c.messages);
      setApprovals(ap.approvals);
      setDashboard(d);
      setError(null);
    } catch (err) {
      // Never fail silently — an unreachable control plane is information.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  // Provider Health: kept separate from refresh() — each registered runtime
  // probes its own CLI (e.g. `claude --version`), so this is refreshed on
  // demand from the agent-detail dialog rather than on every poll.
  const refreshRuntimes = useCallback(async () => {
    try {
      const { runtimes: r } = await client.runtimes();
      setRuntimes(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    client
      .company()
      .then((r) => setCompanyName(r.company.name))
      .catch(() => {
        /* header falls back to the default name */
      });
  }, [refresh, client]);

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    // Element.scrollTo is absent in jsdom and in some older embedded webviews;
    // assigning scrollTop works everywhere and has the same effect here.
    if (typeof log.scrollTo === "function") log.scrollTo({ top: log.scrollHeight });
    else log.scrollTop = log.scrollHeight;
  }, [messages.length]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.sendMessage(body);
      setDraft("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [draft, busy, client, refresh]);

  const runNext = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await client.executeNext();
      if (result.executed && result.runId) {
        const { events: runEvents } = await client.runEvents(result.runId);
        setEvents((prev) => [...prev, ...runEvents].slice(-200));
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [client, refresh]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const byStatus = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      const list = map.get(t.status) ?? [];
      list.push(t);
      map.set(t.status, list);
    }
    return map;
  }, [tasks]);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const reviewable = tasks.filter((t) => t.status === "review");
  // Re-derived from the live agents list on every render, never a stale
  // snapshot: a runtime change made in the dialog is reflected the moment
  // refresh() lands, same as every other figure in this view.
  const currentAgent = selectedAgent ? (agentById.get(selectedAgent.id) ?? selectedAgent) : null;
  const currentRuntime = currentAgent ? runtimes.find((r) => r.type === currentAgent.runtimeProvider) : undefined;

  return (
    <div className="ic-root" data-testid="command-center">
      {/* ------------------------------------------------------- top bar */}
      <header className="ic-topbar">
        <div className="ic-brand">
          <span className="ic-brand-mark">IRON COMMAND</span>
          <span className="ic-brand-sub">{companyName}</span>
        </div>

        <div className="ic-metrics" role="group" aria-label="Systemkennzahlen">
          <Metric label="Läuft" value={dashboard?.tasks.running ?? 0} tone="accent" />
          <Metric label="Review" value={dashboard?.tasks.review ?? 0} />
          <Metric label="Freigaben" value={dashboard?.approvalsPending ?? 0} tone="decision" />
          <Metric
            label="Blockiert"
            value={dashboard?.tasks.blocked ?? 0}
            tone={dashboard?.tasks.blocked ? "critical" : undefined}
          />
          <Metric label="Agents aktiv" value={dashboard?.agents.working ?? 0} />
          <Metric
            label="Audit"
            value={dashboard?.auditChainValid === false ? "BRUCH" : "OK"}
            tone={dashboard?.auditChainValid === false ? "critical" : undefined}
          />
        </div>
      </header>

      <div className="ic-main">
        {/* ------------------------------------------------- agent rail */}
        <nav className="ic-rail" aria-label="Mannschaft">
          <h2 className="ic-section-title">Mannschaft</h2>
          <div className="ic-agent-list">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className="ic-agent"
                aria-pressed={selectedAgent?.id === agent.id}
                onClick={() => {
                  setSelectedAgent(agent);
                  void refreshRuntimes();
                }}
              >
                <span
                  className="ic-status-dot"
                  data-status={agent.status}
                  data-testid={`agent-status-${agent.key}`}
                  aria-hidden="true"
                />
                <span>
                  <span className="ic-agent-name">{agent.displayName}</span>
                  <br />
                  <span className="ic-agent-role">{agent.professionalRole}</span>
                  {/* Status is announced in text, not only by colour. */}
                  <span className="ic-sr-only">Status: {AGENT_STATUS_LABEL[agent.status]}</span>
                </span>
                {agent.isExecutiveAssistant ? <span className="ic-agent-ea">EA</span> : <span />}
              </button>
            ))}
          </div>
        </nav>

        {/* ----------------------------------------------------- board */}
        <main className="ic-stage">
          <h2 className="ic-section-title">
            Aufgaben
            <button type="button" className="ic-btn" onClick={runNext} disabled={busy} data-testid="run-next">
              Nächste Aufgabe ausführen
            </button>
          </h2>

          {error && (
            <div className="ic-approval" role="alert" data-testid="error-banner">
              <div className="ic-approval-type">Fehler</div>
              <div className="ic-approval-summary">{error}</div>
            </div>
          )}

          <div className="ic-board" data-testid="kanban">
            {BOARD_COLUMNS.map(({ status, accent }) => {
              const items = byStatus.get(status) ?? [];
              return (
                <section key={status} className="ic-column" data-accent={accent} data-testid={`column-${status}`}>
                  <h3 className="ic-column-head">
                    <span>{TASK_STATUS_LABEL[status]}</span>
                    <span className="ic-column-count">{items.length}</span>
                  </h3>
                  <div className="ic-column-body">
                    {items.length === 0 && <p className="ic-empty">—</p>}
                    {items.map((task) => (
                      <button
                        key={task.id}
                        type="button"
                        className="ic-card"
                        data-priority={task.priority}
                        data-risk={task.risk_level}
                        onClick={() => setSelectedTask(task)}
                      >
                        <span className="ic-card-title">{task.title}</span>
                        <span className="ic-card-meta">
                          <span>{agentById.get(task.assigned_agent_id ?? "")?.displayName ?? "—"}</span>
                          {task.sensitive === 1 && <span className="ic-redacted">sensibel</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </main>

        {/* ------------------------------------------- CEO chat + inbox */}
        <aside className="ic-side" aria-label="CEO-Kanal">
          {approvals.length > 0 && (
            <>
              <h2 className="ic-section-title">Entscheidungen</h2>
              {approvals.map((approval) => (
                <div key={approval.id} className="ic-approval" data-testid={`approval-${approval.id}`}>
                  <div className="ic-approval-type">{approval.approval_type}</div>
                  <div className="ic-approval-summary">{approval.summary}</div>
                  <div className="ic-approval-actions">
                    <button
                      type="button"
                      className="ic-btn"
                      data-variant="decision"
                      disabled={busy}
                      onClick={() => act(() => client.decide(approval.id, "approved"))}
                    >
                      Freigeben
                    </button>
                    <button
                      type="button"
                      className="ic-btn"
                      data-variant="danger"
                      disabled={busy}
                      onClick={() => act(() => client.decide(approval.id, "rejected"))}
                    >
                      Ablehnen
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          {reviewable.length > 0 && (
            <>
              <h2 className="ic-section-title">Zur Abnahme</h2>
              {reviewable.map((task) => (
                <div key={task.id} className="ic-approval" data-testid={`review-${task.id}`}>
                  <div className="ic-approval-type">Review</div>
                  <div className="ic-approval-summary">{task.title}</div>
                  <div className="ic-approval-actions">
                    <button
                      type="button"
                      className="ic-btn"
                      data-variant="decision"
                      disabled={busy}
                      onClick={() => act(() => client.accept(task.id))}
                    >
                      Abnehmen
                    </button>
                    <button
                      type="button"
                      className="ic-btn"
                      disabled={busy}
                      onClick={() => act(() => client.revise(task.id, "Bitte überarbeiten."))}
                    >
                      Revision
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          <h2 className="ic-section-title">CEO-Kanal</h2>
          <div className="ic-chat-log" ref={logRef} data-testid="chat-log">
            {messages.length === 0 && (
              <p className="ic-note">
                Ihr zentraler Ansprechpartner ist die Executive Assistant. Schreiben Sie, was zu tun ist — Triage,
                Planung und Delegation übernimmt sie.
              </p>
            )}
            {messages.map((msg) => {
              const triage = msg.triage_json
                ? (JSON.parse(msg.triage_json) as { category: string; confidence: number })
                : null;
              return (
                <div key={msg.id} className="ic-msg" data-role={msg.role}>
                  <div className="ic-msg-author">
                    {msg.role === "ceo" ? "CEO" : (agentById.get(msg.author_agent_id ?? "")?.displayName ?? "System")}
                    {" · "}
                    {formatTime(msg.created_at)}
                  </div>
                  <div className="ic-msg-body">{msg.body}</div>
                  {triage && msg.role === "ceo" && (
                    <div className="ic-triage">
                      Triage: {triage.category} · Konfidenz {(triage.confidence * 100).toFixed(0)}%
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="ic-composer">
            <label className="ic-sr-only" htmlFor="ic-composer-input">
              Nachricht an die Executive Assistant
            </label>
            <textarea
              id="ic-composer-input"
              data-testid="chat-input"
              value={draft}
              placeholder="Auftrag an die Executive Assistant …"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
              }}
            />
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="chat-send"
              onClick={send}
              disabled={busy || draft.trim().length === 0}
            >
              Senden
            </button>
          </div>
        </aside>
      </div>

      {/* --------------------------------------------------- event drawer */}
      <section className="ic-drawer" aria-label="Ereignisverlauf">
        <div className="ic-drawer-head">
          <h2 className="ic-section-title" style={{ padding: 0 }}>
            Run-Ereignisse
          </h2>
        </div>
        <div className="ic-event-log" data-testid="event-log">
          {events.length === 0 && <p className="ic-empty">Noch keine Ereignisse.</p>}
          {events.slice(-60).map((ev) => (
            <div key={ev.eventId} className="ic-event" data-kind={eventKind(ev.type)}>
              <span className="ic-event-time">{formatTime(ev.timestamp)}</span>
              <span className="ic-event-type">{ev.type}</span>
              <span className="ic-event-body">
                {ev.redaction.redacted && <span className="ic-redacted">redigiert</span>}{" "}
                {JSON.stringify(ev.payload).slice(0, 160)}
              </span>
            </div>
          ))}
        </div>
      </section>

      {selectedTask && (
        <DetailDialog title={selectedTask.title} onClose={() => setSelectedTask(null)}>
          <dl>
            <dt>Status</dt>
            <dd>{TASK_STATUS_LABEL[selectedTask.status]}</dd>
            <dt>Priorität</dt>
            <dd>{selectedTask.priority}</dd>
            <dt>Risiko</dt>
            <dd>{selectedTask.risk_level}</dd>
            <dt>Verantwortlich</dt>
            <dd>{agentById.get(selectedTask.assigned_agent_id ?? "")?.displayName ?? "nicht zugewiesen"}</dd>
            <dt>Correlation</dt>
            <dd>
              <code>{selectedTask.correlation_id}</code>
            </dd>
          </dl>
          {selectedTask.result_summary && <p className="ic-note">{selectedTask.result_summary}</p>}
        </DetailDialog>
      )}

      {currentAgent && (
        <DetailDialog title={currentAgent.displayName} onClose={() => setSelectedAgent(null)}>
          <dl>
            <dt>Rolle</dt>
            <dd>{currentAgent.professionalRole}</dd>
            <dt>Status</dt>
            <dd>{AGENT_STATUS_LABEL[currentAgent.status]}</dd>
            <dt>Runtime</dt>
            <dd>
              <label className="ic-sr-only" htmlFor="ic-agent-runtime-select">
                Runtime für {currentAgent.displayName}
              </label>
              <select
                id="ic-agent-runtime-select"
                className="ic-select"
                data-testid="agent-runtime-select"
                value={currentAgent.runtimeProvider}
                disabled={busy}
                onChange={(e) => act(() => client.setAgentRuntime(currentAgent.id, e.target.value))}
              >
                {/* An agent can be pointed at a provider this install no longer
                    has registered (e.g. after a config change) — surface that
                    honestly as its own option rather than silently showing a
                    different one selected. */}
                {!runtimes.some((r) => r.type === currentAgent.runtimeProvider) && (
                  <option value={currentAgent.runtimeProvider}>
                    {currentAgent.runtimeProvider} (nicht registriert)
                  </option>
                )}
                {runtimes.map((r) => (
                  <option key={r.type} value={r.type}>
                    {r.type} {r.health.healthy ? "● bereit" : "○ nicht verfügbar"}
                  </option>
                ))}
              </select>
              {" · "}
              {currentAgent.runtimeProfile}
              {currentRuntime && (
                <>
                  <br />
                  <span className="ic-note" data-testid="agent-runtime-detail">
                    {currentRuntime.auth.authenticated ? "Angemeldet" : "Nicht angemeldet"} ·{" "}
                    {currentRuntime.health.detail}
                  </span>
                </>
              )}
            </dd>
            <dt>Max. Risiko</dt>
            <dd>{currentAgent.policy.max_risk_level}</dd>
            <dt>Werkzeuge</dt>
            <dd>
              {currentAgent.policy.allowed_tools.map((t) => (
                <span key={t} className="ic-tag" data-tone="policy">
                  {t}
                </span>
              ))}
            </dd>
            <dt>Freigabepflichtig</dt>
            <dd>
              {currentAgent.policy.requires_approval_for.length === 0
                ? "—"
                : currentAgent.policy.requires_approval_for.map((t) => (
                    <span key={t} className="ic-tag" data-tone="gate">
                      {t}
                    </span>
                  ))}
            </dd>
            <dt>Auftreten</dt>
            <dd>{currentAgent.persona.traits.join(", ") || "—"}</dd>
          </dl>
          <p className="ic-note">
            Das Auftreten ist rein stilistisch. Es kann Berechtigungen, Werkzeuge oder Freigabepflichten nicht verändern
            — Policy hat immer Vorrang.
          </p>
        </DetailDialog>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "accent" | "decision" | "critical";
}): React.JSX.Element {
  return (
    <div className="ic-metric" data-tone={tone}>
      <span className="ic-metric-label">{label}</span>
      <span className="ic-metric-value">{value}</span>
    </div>
  );
}

function DetailDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="ic-detail-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="ic-detail">
        <h2>{title}</h2>
        {children}
        <button type="button" className="ic-btn" onClick={onClose}>
          Schliessen
        </button>
      </div>
    </div>
  );
}

export default CommandCenterView;
