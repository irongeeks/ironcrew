import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AGENT_STATUS_LABEL, TASK_STATUS_LABEL, type Agent, type Department, type Meeting, type Task } from "./types";
import { CharacterAvatar } from "./CharacterAvatar";
import "./CrewOffice.css";

export interface CrewOfficeProps {
  agents: Agent[];
  tasks: Task[];
  departments: Department[];
  meetings?: Meeting[];
  onSelectAgent: (agent: Agent) => void;
  onSelectTask: (task: Task) => void;
  onSelectMeeting?: (meetingId: string) => void;
}

const TASK_ORDER: Partial<Record<Task["status"], number>> = {
  running: 0,
  approval_required: 1,
  blocked: 2,
  waiting: 3,
  review: 4,
  assigned: 5,
  ready: 6,
  planned: 7,
  inbox: 8,
};

/** Select actual unfinished work; a historical failure must not mask a new run. */
export function currentOfficeTask(agentId: string, tasks: Task[]): Task | undefined {
  return tasks
    .filter((task) => task.assigned_agent_id === agentId && TASK_ORDER[task.status] !== undefined)
    .sort(
      (a, b) =>
        (TASK_ORDER[a.status] ?? 99) - (TASK_ORDER[b.status] ?? 99) ||
        b.updated_at - a.updated_at ||
        a.id.localeCompare(b.id),
    )[0];
}

/** Desktop fits the whole room between the controls and timeline. Mobile keeps
 * the document's natural scroll path, with width-only fitting. */
export function officeFitScale(width: number, floorHeight: number, availableHeight: number | null): number {
  return Math.min(
    1,
    Math.max(1, width) / 1120,
    availableHeight === null ? 1 : Math.max(1, availableHeight) / floorHeight,
  );
}

function Desk({ x, y, active, label }: { x: number; y: number; active: boolean; label: string }): React.JSX.Element {
  return (
    <g transform={`translate(${x} ${y})`} className="crew-office-desk" data-active={active}>
      <rect x="-63" y="-28" width="126" height="49" rx="9" fill="#080f15" opacity=".55" transform="translate(0 7)" />
      <path d="M-59 3v25m118-25v25" stroke="#344650" strokeWidth="5" />
      <rect x="-66" y="-31" width="132" height="49" rx="9" fill="#2a3741" stroke="#4e626f" />
      <path d="M-56 14H55" stroke={active ? "#69b7bc" : "#3d4c58"} />
      <path d="M-8-25v10h17" stroke="#8b9fa9" strokeWidth="3" fill="none" />
      <rect x="-36" y="-51" width="65" height="35" rx="4" fill="#0d1c25" stroke="#6d8998" />
      <path
        className="crew-office-screen-lines"
        d="M-28-41h32m-32 6h46m-46 6h23"
        stroke={active ? "#7ac8c9" : "#41535f"}
        strokeWidth="2"
      />
      <rect x="-27" y="-7" width="44" height="12" rx="3" fill="#17242e" stroke="#5b6c77" />
      <path d="M-20-3H8M-20 1H8" stroke="#536675" />
      <ellipse cx="41" cy="-1" rx="6" ry="8" fill="#83939c" />
      <path d="M-53-18v12h9v-12" fill="#acb8be" />
      <ellipse cx="-48.5" cy="-18" rx="4.5" ry="2" fill="#384954" />
      <text x="0" y="-65" textAnchor="middle" className="crew-office-department-label">
        {label}
      </text>
    </g>
  );
}

function Plant({ x, y }: { x: number; y: number }): React.JSX.Element {
  return (
    <g transform={`translate(${x} ${y})`}>
      <ellipse cy="10" rx="16" ry="6" fill="#080f15" opacity=".5" />
      <path d="M-12-1h24l-3 16H-9z" fill="#4a5558" />
      <path
        d="M0 0q-24-7-20-21Q-4-18 0 0m0 0q25-9 20-25Q3-18 0 0m0 0q-12-31 1-35Q13-23 0 0"
        fill="#486d61"
        stroke="#66897a"
      />
    </g>
  );
}

export function CrewOffice({
  agents,
  tasks,
  departments,
  meetings = [],
  onSelectAgent,
  onSelectTask,
  onSelectMeeting,
}: CrewOfficeProps): React.JSX.Element {
  const patternId = useId().replace(/:/g, "");
  const [view, setView] = useState<"floor" | "list">("floor");
  const [zoom, setZoom] = useState<"fit" | "actual">("fit");
  const [viewportWidth, setViewportWidth] = useState(1120);
  const [availableHeight, setAvailableHeight] = useState<number | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const stage = viewport.closest<HTMLElement>(".ic-stage");
    const measure = (observedWidth?: number) => {
      const rect = viewport.getBoundingClientRect();
      const width = observedWidth ?? rect.width;
      if (width > 0) setViewportWidth(width);
      const stageBottom = stage?.getBoundingClientRect().bottom ?? window.innerHeight;
      const viewportTop = rect.top + (stage?.scrollTop ?? 0);
      const footer = viewport.parentElement?.querySelector<HTMLElement>(".crew-office-meetings")?.offsetHeight ?? 0;
      setAvailableHeight(
        window.innerWidth > 780 && stageBottom > viewportTop
          ? Math.max(1, stageBottom - viewportTop - footer - 26)
          : null,
      );
    };
    const onResize = () => measure();
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((item) => item.target === viewport) ?? entries[0];
      measure(entry?.target === stage ? undefined : entry?.contentRect.width);
    });
    observer.observe(viewport);
    if (stage) observer.observe(stage);
    measure();
    window.addEventListener("resize", onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [view, agents.length]);
  const [departmentFilter, setDepartmentFilter] = useState("");
  const departmentById = useMemo(() => new Map(departments.map((d) => [d.id, d])), [departments]);
  const sortedAgents = useMemo(
    () =>
      [...agents].sort((a, b) => {
        const aIndex = departments.findIndex((d) => d.id === a.departmentId);
        const bIndex = departments.findIndex((d) => d.id === b.departmentId);
        return aIndex - bIndex || a.key.localeCompare(b.key);
      }),
    [agents, departments],
  );
  const rows = Math.max(3, Math.ceil(agents.length / 5));
  const currentTasks = useMemo(
    () => new Map(agents.map((a) => [a.id, currentOfficeTask(a.id, tasks)])),
    [agents, tasks],
  );
  const meetingAgents = sortedAgents.filter((a) => a.status === "in_meeting");
  const decisionAgents = sortedAgents.filter(
    (a) =>
      a.status !== "in_meeting" &&
      (a.status === "waiting_for_approval" || currentTasks.get(a.id)?.status === "approval_required"),
  );
  const meetingHeight = Math.max(218, Math.ceil(meetingAgents.length / 2) * 157 + 75);
  const decisionHeight = Math.max(180, Math.ceil(decisionAgents.length / 2) * 157 + 75);
  const height = Math.max(650, rows * 220 + 210, meetingHeight + decisionHeight + 170);
  const scale = zoom === "fit" ? officeFitScale(viewportWidth, height, availableHeight) : 1;
  const decisionTop = height - decisionHeight - 68;
  const visibleAgents = sortedAgents.filter((a) => !departmentFilter || a.departmentId === departmentFilter);
  const activeMeetings = meetings.filter((meeting) => meeting.status === "in_progress");
  const taskLabel = (agent: Agent) => {
    const task = currentTasks.get(agent.id);
    return task ? `${TASK_STATUS_LABEL[task.status]}: ${task.title}` : "Keine offene Aufgabe zugewiesen";
  };

  return (
    <section className="crew-office" aria-label="Virtuelles Büro" data-testid="crew-office">
      <header className="crew-office-toolbar">
        <div>
          <span className="crew-office-eyebrow">IRONCREW / OFFICE</span>
          <h2>Die Crew bei der Arbeit</h2>
          <p>Crew, Aufgaben und Entscheidungen an einem Ort.</p>
        </div>
        <div className="crew-office-controls">
          <label>
            <span className="ic-sr-only">Büro nach Abteilung filtern</span>
            <select
              aria-label="Büro nach Abteilung filtern"
              value={departmentFilter}
              onChange={(event) => setDepartmentFilter(event.target.value)}
            >
              <option value="">Alle Abteilungen</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <div className="crew-office-view-switch" role="group" aria-label="Büroansicht">
            <button type="button" aria-pressed={view === "floor"} onClick={() => setView("floor")}>
              Grundriss
            </button>
            <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>
              Liste
            </button>
          </div>
          {view === "floor" && (
            <div className="crew-office-view-switch" role="group" aria-label="Büro vergrößern">
              <button type="button" aria-pressed={zoom === "fit"} onClick={() => setZoom("fit")}>
                Einpassen
              </button>
              <button type="button" aria-pressed={zoom === "actual"} onClick={() => setZoom("actual")}>
                100 %
              </button>
            </div>
          )}
        </div>
      </header>
      <div className="crew-office-legend">
        <span>
          <i data-tone="active" />
          Arbeit / Analyse
        </span>
        <span>
          <i data-tone="decision" />
          Freigabe / Pause
        </span>
        <span>
          <i data-tone="error" />
          Fehler / Blocker
        </span>
        <span className="crew-office-count">
          {visibleAgents.length} von {agents.length} Agents
        </span>
      </div>
      {agents.length === 0 ? (
        <p className="crew-office-empty">
          Noch keine Crew vorhanden. Sobald Agents angelegt sind, erscheinen ihre Arbeitsplätze hier.
        </p>
      ) : view === "floor" ? (
        <div
          className="crew-office-viewport"
          ref={viewportRef}
          tabIndex={0}
          role="region"
          aria-label="Bürogrundriss, horizontal verschiebbar. Alternativ Listenansicht verwenden."
        >
          <div className="crew-office-canvas-space" style={{ width: 1120 * scale, height: height * scale }}>
            <div className="crew-office-floor" style={{ height, transform: `scale(${scale})` }}>
              <svg width="1120" height={height} viewBox={`0 0 1120 ${height}`} aria-hidden="true">
                <defs>
                  <pattern id={patternId} width="40" height="40" patternUnits="userSpaceOnUse">
                    <path d="M40 0H0v40" fill="none" stroke="#24333d" strokeWidth=".6" />
                  </pattern>
                </defs>
                <rect
                  x="16"
                  y="24"
                  width="1088"
                  height={height - 45}
                  rx="24"
                  fill="#111d27"
                  stroke="#455963"
                  strokeWidth="2"
                />
                <rect x="24" y="32" width="1072" height={height - 60} rx="20" fill={`url(#${patternId})`} />
                <path d={`M792 35v${height - 74}`} stroke="#33454f" strokeWidth="2" />
                <path d={`M800 55v${height - 110}`} stroke="#698991" opacity=".5" />
                <rect x="44" y="69" width="721" height={height - 128} rx="14" fill="#19262f" stroke="#34434d" />
                <path d="M57 42h243m40 0h220m35 0h171" stroke="#5e9aab" strokeWidth="5" opacity=".75" />
                <text x="56" y="102" className="crew-office-room-label">
                  ARBEITSBEREICH
                </text>
                <text x="713" y="102" className="crew-office-room-number">
                  01
                </text>
                <rect x="822" y="69" width="253" height={meetingHeight} rx="13" fill="#172c32" stroke="#46666c" />
                <text x="842" y="99" className="crew-office-room-label">
                  MEETINGRAUM
                </text>
                <rect x="854" y="143" width="186" height="68" rx="34" fill="#344b54" stroke="#688990" />
                <ellipse cx="947" cy="178" rx="47" ry="18" fill="#223a43" stroke="#74989e" />
                <path d="M928 178h38m-19-11v22" stroke="#66969d" />
                <text x="946" y={69 + meetingHeight - 17} textAnchor="middle" className="crew-office-scene-note">
                  {meetingAgents.length ? `${meetingAgents.length} Agents im Meeting` : "Für die nächste Abstimmung"}
                </text>
                <rect
                  x="822"
                  y={decisionTop}
                  width="253"
                  height={decisionHeight}
                  rx="13"
                  fill="#2a2b28"
                  stroke="#6c624c"
                />
                <text x="842" y={decisionTop + 30} className="crew-office-room-label">
                  ENTSCHEIDUNGEN
                </text>
                <path d={`M844 ${decisionTop + 56}h209`} stroke="#9e865c" />
                <rect x="846" y={decisionTop + 81} width="198" height="31" rx="9" fill="#4c4b3f" stroke="#857b60" />
                <text x="56" y={height - 35} className="crew-office-scene-note">
                  Figur: Agent öffnen · Auftrag: Aufgabe und Run-Verlauf öffnen
                </text>
                {sortedAgents.map((agent, index) => (
                  <Desk
                    key={agent.id}
                    x={114 + (index % 5) * 144}
                    y={198 + Math.floor(index / 5) * 220}
                    active={agent.status === "working" || agent.status === "thinking"}
                    label={departmentById.get(agent.departmentId ?? "")?.name ?? "Crew"}
                  />
                ))}
                <Plant x={754} y={height - 80} />
                <Plant x={1064} y={46} />
                <Plant x={831} y={height - 42} />
              </svg>
              {sortedAgents.map((agent, index) => {
                const meetingIndex = meetingAgents.indexOf(agent);
                const decisionIndex = decisionAgents.indexOf(agent);
                let x = 64 + (index % 5) * 144;
                let y = 191 + Math.floor(index / 5) * 220;
                if (meetingIndex >= 0) {
                  x = 835 + (meetingIndex % 2) * 123;
                  y = 115 + Math.floor(meetingIndex / 2) * 157;
                } else if (decisionIndex >= 0) {
                  x = 835 + (decisionIndex % 2) * 123;
                  y = decisionTop + 55 + Math.floor(decisionIndex / 2) * 157;
                }
                const task = currentTasks.get(agent.id);
                const filtered = !!departmentFilter && departmentFilter !== agent.departmentId;
                return (
                  <div
                    key={agent.id}
                    className="crew-office-occupant"
                    data-status={agent.status}
                    data-blocked={task?.status === "blocked" || undefined}
                    data-filtered={filtered || undefined}
                    data-testid={`office-person-${agent.id}`}
                    style={{ transform: `translate(${x}px, ${y}px)` }}
                  >
                    <button
                      type="button"
                      className="crew-office-person-button"
                      disabled={filtered}
                      onClick={() => onSelectAgent(agent)}
                      aria-label={`${agent.displayName} – ${AGENT_STATUS_LABEL[agent.status]} – ${taskLabel(agent)}`}
                      title={`${agent.displayName} · ${AGENT_STATUS_LABEL[agent.status]}\n${taskLabel(agent)}`}
                    >
                      <CharacterAvatar
                        characterId={agent.persona.character_id}
                        seed={agent.key}
                        fullBodyUrl={agent.persona.full_body}
                        animation={agent.persona.animation_config}
                        status={agent.status}
                        className="crew-office-person"
                      />
                      <span className="crew-office-name">{agent.displayName}</span>
                      <span className="crew-office-state">{AGENT_STATUS_LABEL[agent.status]}</span>
                    </button>
                    {task && (
                      <button
                        type="button"
                        disabled={filtered}
                        className="crew-office-task-link"
                        onClick={() => onSelectTask(task)}
                        aria-label={`Aufgabe von ${agent.displayName}: ${task.title}`}
                        title={task.title}
                      >
                        {task.status === "blocked" ? "Blockiert: " : ""}
                        {task.title}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <ul className="crew-office-roster" aria-label="Crew und aktuelle Aufgaben">
          {visibleAgents.map((agent) => {
            const task = currentTasks.get(agent.id);
            return (
              <li key={agent.id}>
                <button type="button" onClick={() => onSelectAgent(agent)}>
                  <strong>{agent.displayName}</strong>
                  <span>
                    {departmentById.get(agent.departmentId ?? "")?.name ?? "Crew"} · {AGENT_STATUS_LABEL[agent.status]}
                  </span>
                </button>
                {task ? (
                  <button type="button" className="crew-office-roster-task" onClick={() => onSelectTask(task)}>
                    {TASK_STATUS_LABEL[task.status]}: {task.title}
                  </button>
                ) : (
                  <span>Keine offene Aufgabe zugewiesen</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {visibleAgents.length === 0 && agents.length > 0 && (
        <p className="crew-office-empty">Dieser Abteilung ist noch kein Agent zugeordnet.</p>
      )}
      {activeMeetings.length > 0 && (
        <div className="crew-office-meetings" aria-label="Laufende Meetings">
          {activeMeetings.map((meeting) =>
            onSelectMeeting ? (
              <button key={meeting.id} type="button" onClick={() => onSelectMeeting(meeting.id)}>
                Meeting: {meeting.topic} · Runde {meeting.current_round}/{meeting.max_rounds}
              </button>
            ) : (
              <span key={meeting.id}>
                Meeting: {meeting.topic} · Runde {meeting.current_round}/{meeting.max_rounds}
              </span>
            ),
          )}
        </div>
      )}
    </section>
  );
}
