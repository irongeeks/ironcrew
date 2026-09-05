import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AGENT_STATUS_LABEL, TASK_STATUS_LABEL, type Agent, type Department, type Meeting, type Task } from "./types";
import { CharacterAvatar } from "./CharacterAvatar";
import { createOfficeBuilding } from "./office-building-layout";
import { OfficeBuilding } from "./OfficeBuilding";
import { useOfficeMotion } from "./useOfficeMotion";
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

export function CrewOffice({
  agents,
  tasks,
  departments,
  meetings = [],
  onSelectAgent,
  onSelectTask,
  onSelectMeeting,
}: CrewOfficeProps): React.JSX.Element {
  const [focusedRoomId, setFocusedRoomId] = useState<string | null>(null);
  const [motionPaused, setMotionPaused] = useState(false);
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
  const layout = useMemo(
    () => createOfficeBuilding(departments, sortedAgents, meetingAgents.length, decisionAgents.length),
    [departments, sortedAgents, meetingAgents.length, decisionAgents.length],
  );
  const height = layout.height;
  const focusedRoom = layout.rooms.find((room) => room.id === focusedRoomId);
  const focus = focusedRoom
    ? {
        x: Math.max(0, focusedRoom.x - 12),
        y: Math.max(0, focusedRoom.y - 12),
        width: focusedRoom.width + 24,
        height: focusedRoom.height + 24,
      }
    : { x: 0, y: 0, width: layout.width, height };
  const scale =
    zoom === "actual"
      ? 1
      : focusedRoom
        ? Math.min(2.5, viewportWidth / focus.width, availableHeight === null ? 2.5 : availableHeight / focus.height)
        : officeFitScale(viewportWidth, height, availableHeight);
  const motionSubjects = useMemo(
    () =>
      sortedAgents.map((agent) => {
        const meetingIndex = meetingAgents.indexOf(agent),
          decisionIndex = decisionAgents.indexOf(agent);
        const home = layout.homes[agent.id];
        return {
          id: agent.id,
          status: agent.status,
          taskStatus: currentTasks.get(agent.id)?.status,
          homeNodeId: home.nodeId,
          anchor:
            meetingIndex >= 0
              ? layout.meetingSeats[meetingIndex]
              : decisionIndex >= 0
                ? layout.decisionSeats[decisionIndex]
                : home.point,
          priority: meetingIndex >= 0 || decisionIndex >= 0,
        };
      }),
    [sortedAgents, meetingAgents, decisionAgents, layout, currentTasks],
  );
  const { refFor } = useOfficeMotion({
    graph: layout.graph,
    subjects: motionSubjects,
    paused: motionPaused,
    enabled: view === "floor",
    viewport: focusedRoom ? focus : undefined,
  });
  const activeAgentIds = useMemo(
    () => new Set(agents.filter((a) => a.status === "working" || a.status === "thinking").map((a) => a.id)),
    [agents],
  );
  const openRoom = (id: string) => {
    setFocusedRoomId(id);
    setZoom("fit");
  };
  const overview = () => {
    setFocusedRoomId(null);
    setDepartmentFilter("");
    setZoom("fit");
  };
  const visibleAgents = sortedAgents.filter((a) => !departmentFilter || a.departmentId === departmentFilter);
  const activeMeetings = meetings.filter((meeting) => meeting.status === "in_progress");
  const taskLabel = (agent: Agent) => {
    const task = currentTasks.get(agent.id);
    return task ? `${TASK_STATUS_LABEL[task.status]}: ${task.title}` : "Keine offene Aufgabe zugewiesen";
  };

  return (
    <section
      className="crew-office"
      aria-label="Virtuelles Büro"
      data-testid="crew-office"
      data-ambient-paused={motionPaused || undefined}
    >
      <header className="crew-office-toolbar">
        <div>
          <span className="crew-office-eyebrow">IRONCREW / OFFICE</span>
          <h2>{focusedRoom ? focusedRoom.name : "Ein Gebäude für die ganze Crew"}</h2>
          <p>
            {focusedRoom
              ? "Figur öffnen · Aufgabe verfolgen · Einrichtung und Crew im Detail"
              : "Eigene Büros, kurze Wege und ein gemeinsamer Treffpunkt."}
          </p>
        </div>
        <div className="crew-office-controls">
          <label>
            <span className="ic-sr-only">Büro nach Abteilung filtern</span>
            <select
              aria-label="Büro nach Abteilung filtern"
              value={departmentFilter}
              onChange={(event) => {
                const id = event.target.value;
                setDepartmentFilter(id);
                setFocusedRoomId(id || null);
                setZoom("fit");
              }}
            >
              <option value="">Alle Abteilungen</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          {focusedRoom && (
            <button type="button" className="crew-office-control-button" onClick={overview}>
              Gebäudeübersicht
            </button>
          )}
          <button
            type="button"
            className="crew-office-control-button"
            aria-pressed={motionPaused}
            onClick={() => setMotionPaused((value) => !value)}
          >
            {motionPaused ? "Bürobewegung fortsetzen" : "Bürobewegung pausieren"}
          </button>
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
        <span className="crew-office-ambient-note">Begegnungen zeigen Bereitschaft · Meetings zeigen echte Arbeit</span>
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
          <div
            className="crew-office-canvas-space"
            data-focused-room={focusedRoom?.id}
            style={{ width: focus.width * scale, height: focus.height * scale }}
          >
            <div
              className="crew-office-floor"
              style={{
                height,
                transform: focusedRoom ? `scale(${scale}) translate(${-focus.x}px, ${-focus.y}px)` : `scale(${scale})`,
              }}
            >
              <OfficeBuilding layout={layout} activeAgentIds={activeAgentIds} />
              {layout.rooms.map((room) => (
                <button
                  key={room.id}
                  type="button"
                  className="crew-office-room-focus"
                  data-testid={`office-room-focus-${room.id}`}
                  aria-label={`Raum öffnen: ${room.name}`}
                  tabIndex={focusedRoom && focusedRoom.id !== room.id ? -1 : 0}
                  aria-hidden={focusedRoom && focusedRoom.id !== room.id ? true : undefined}
                  aria-pressed={focusedRoom?.id === room.id}
                  style={{ left: room.x + 12, top: room.y + 8, maxWidth: room.width - 24 }}
                  onClick={() => openRoom(room.id)}
                >
                  <span>{room.name}</span>
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M4 2h6v6M10 2 2 10" fill="none" stroke="currentColor" strokeWidth="1.2" />
                  </svg>
                </button>
              ))}
              {sortedAgents.map((agent) => {
                const anchor = motionSubjects.find((subject) => subject.id === agent.id)!.anchor;
                const task = currentTasks.get(agent.id);
                const filtered = !!departmentFilter && departmentFilter !== agent.departmentId;
                return (
                  <div
                    key={agent.id}
                    ref={refFor(agent.id)}
                    className="crew-office-occupant"
                    data-status={agent.status}
                    data-blocked={task?.status === "blocked" || undefined}
                    data-filtered={filtered || undefined}
                    data-testid={`office-person-${agent.id}`}
                    style={{ "--office-x": anchor.x, "--office-y": anchor.y } as CSSProperties}
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
                      <span className="crew-office-encounter" aria-hidden="true">
                        <svg width="24" height="17" viewBox="0 0 24 17">
                          <path
                            d="M3 1h18a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-9l-5 4v-4H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2Z"
                            fill="#304c54"
                            stroke="#a5c4c4"
                          />
                          <circle cx="7" cy="6" r="1" fill="#d1e3dc" />
                          <circle cx="12" cy="6" r="1" fill="#d1e3dc" />
                          <circle cx="17" cy="6" r="1" fill="#d1e3dc" />
                        </svg>
                        <span>Begegnung</span>
                      </span>
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
