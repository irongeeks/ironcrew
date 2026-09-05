import { memo, useId } from "react";
import type { OfficeBuildingLayout, BuildingRoom } from "./office-building-layout";

function Plant({ x, y, size = 1 }: { x: number; y: number; size?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${size})`}>
      <ellipse cy="11" rx="17" ry="7" fill="#0b171a" opacity=".5" />
      <path d="M-13 0h26l-3 18H-10z" fill="#69736c" />
      <path
        d="M0 0C-31-3-28-27-13-24L0-4C-10-36 15-43 15-23L3-3C26-33 39-13 19-5z"
        fill="#436e60"
        stroke="#7c9b80"
        strokeWidth="1.2"
      />
      <path d="M0 3V-22m0 17-15-12M1-3l16-9" stroke="#a1b592" fill="none" />
    </g>
  );
}
function Screen({ x, y, wide = false }: { x: number; y: number; wide?: boolean }) {
  const w = wide ? 76 : 49;
  return (
    <g transform={`translate(${x} ${y})`}>
      <path d={`M${w / 2} 23v10m-12 0h24`} stroke="#607884" strokeWidth="3" />
      <rect width={w} height="27" rx="3" fill="#10232c" stroke="#728c97" />
      <path
        className="crew-office-screen-lines"
        d={`M7 7h${w - 18}M7 13h${w - 27}M7 19h${w - 22}`}
        fill="none"
        stroke="#69aaac"
        strokeWidth="1.4"
      />
    </g>
  );
}
function Workstation({ x, y, kind, active }: { x: number; y: number; kind: string; active: boolean }) {
  const warm = ["executive", "finance", "legal", "knowledge"].includes(kind);
  return (
    <g transform={`translate(${x} ${y})`} className="crew-office-desk" data-active={active}>
      <ellipse cx="0" cy="35" rx="37" ry="10" fill="#0c1720" opacity=".65" />
      <rect x="-24" y="9" width="48" height="42" rx="14" fill="#293b45" stroke="#5e7581" />
      <path d="M-20 28h40" stroke="#738997" />
      <path d="M-43-9v28m86-28v28" stroke="#687b82" strokeWidth="4" />
      <path
        d={kind === "executive" ? "M-49-19Q0-36 49-19L43 13Q0 25-43 13Z" : "M-47-23H47L50 13H-50Z"}
        fill={warm ? "#756758" : "#3f535e"}
        stroke={warm ? "#a58b6b" : "#7c929b"}
        strokeWidth="1.4"
      />
      {kind === "design" ? (
        <g transform="translate(-27 -30) rotate(-9)">
          <rect width="48" height="33" rx="2" fill="#9caeaa" />
          <path d="M8 8h24v14H8zM35 8v14" stroke="#385565" fill="none" />
          <circle cx="42" cy="8" r="3" fill="#cbaf79" />
        </g>
      ) : (
        <Screen x={-25} y={-43} wide={kind === "engineering" || kind === "quality"} />
      )}
      <rect x="-20" y="2" width="30" height="8" rx="2" fill="#203440" />
      <path d="M-15 6H5" stroke="#75909b" />
      <ellipse cx="33" cy="1" rx="5" ry="6" fill="#a3b2b8" />
      <path d="M-38-6v11h9V-6" fill="#bdb3a2" />
      <path d="M-29-4q9-1 6 6h-6" stroke="#bdb3a2" fill="none" />
    </g>
  );
}
function Shelf({ x, y, width = 65, folders = false }: { x: number; y: number; width?: number; folders?: boolean }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={width} height="49" rx="2" fill="#293839" stroke="#7e8273" />
      {[0, 1].map((row) => (
        <g key={row} transform={`translate(5 ${5 + row * 23})`}>
          {Array.from({ length: Math.floor((width - 10) / 9) }, (_, i) => (
            <rect
              key={i}
              x={i * 9}
              width={folders ? 7 : 5 + (i % 3)}
              height="17"
              rx="1"
              fill={["#889a93", "#9f9278", "#547b81", "#b2aa95"][i % 4]}
            />
          ))}
          <path d={`M-3 19h${width - 4}`} stroke="#a0967e" />
        </g>
      ))}
    </g>
  );
}
function Board({ x, y, kind, width = 83 }: { x: number; y: number; kind: string; width?: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={width} height="48" rx="3" fill="#b6c3bd" stroke="#637d84" strokeWidth="2" />
      {kind === "flow" ? (
        <g fill="none" stroke="#426b74">
          <rect x="8" y="9" width="18" height="12" />
          <rect x={width - 27} y="26" width="18" height="12" />
          <path d={`M26 15h14v17h${width - 67}`} />
          <path d="M8 33h17" />
        </g>
      ) : kind === "notes" ? (
        <g>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <rect
              key={i}
              x={8 + (i % 3) * 22}
              y={8 + Math.floor(i / 3) * 18}
              width="15"
              height="12"
              fill={["#bd9d67", "#6b9797", "#84976c"][i % 3]}
            />
          ))}
        </g>
      ) : (
        <g fill="none" stroke="#52777e" strokeWidth="2">
          <path d={`M9 33l14-10 14 6 17-15 16 6M9 39h${width - 18}`} />
          <circle cx="54" cy="14" r="3" />
        </g>
      )}
    </g>
  );
}
function RoomEquipment({ room }: { room: BuildingRoom }) {
  const w = room.width,
    h = room.height;
  switch (room.key) {
    case "executive":
      return (
        <>
          <path d={`M15 49h${w - 30}`} stroke="#bdad82" strokeWidth="4" />
          <rect x="17" y={h - 71} width="65" height="37" rx="11" fill="#716c5b" stroke="#a4997c" />
          <path d={`M25 ${h - 60}h49`} stroke="#b3a383" />
          <Plant x={w - 25} y={h - 32} />
          <rect x={w - 72} y="52" width="43" height="22" rx="3" fill="#a28a61" />
          <path d={`M${w - 62} 63h23`} stroke="#ebcf91" />
        </>
      );
    case "engineering":
      return (
        <>
          <Board x={18} y={43} kind="flow" width={100} />
          <rect x={w - 51} y="47" width="29" height="53" rx="3" fill="#263c48" stroke="#567d8a" />
          <path d={`M${w - 43} 59h13m-13 10h13m-13 10h13`} stroke="#83bcc1" />
          <path d={`M20 ${h - 54}h56v22H20z`} fill="#334955" stroke="#57717d" />
          <path d={`M28 ${h - 42}h38`} stroke="#95b1bc" />
        </>
      );
    case "infrastructure":
      return (
        <>
          {[18, w - 58].map((x) => (
            <g key={x} transform={`translate(${x} 48)`}>
              <rect width="38" height="82" rx="4" fill="#182b37" stroke="#718a96" />
              {[0, 1, 2, 3].map((i) => (
                <g key={i}>
                  <rect x="5" y={7 + i * 18} width="28" height="13" rx="1" fill="#394e5a" />
                  <path d={`M10 ${12 + i * 18}h12`} stroke="#9ab0b9" />
                  <circle cx="28" cy={13 + i * 18} r="1.8" fill="#75b79b" />
                </g>
              ))}
            </g>
          ))}
          <path d={`M35 141v18H${w - 37}v-18`} fill="none" stroke="#477988" strokeWidth="2" />
          <path d={`M20 ${h - 48}h55v15H20z`} fill="#2b4550" stroke="#6c8c96" />
        </>
      );
    case "security":
      return (
        <>
          <g transform="translate(18 43)">
            {[0, 1, 2].map((i) => (
              <g key={i} transform={`translate(${i * 65} 0)`}>
                <rect width="58" height="40" rx="3" fill="#172c35" stroke="#728792" />
                <path d="M29 7l11 5v10q-3 8-11 12-8-4-11-12V12z" fill="#28474f" stroke="#6eacae" />
              </g>
            ))}
          </g>
          <rect x="19" y={h - 78} width="44" height="47" rx="3" fill="#415058" stroke="#8b9b9d" />
          <circle cx="41" cy={h - 55} r="11" fill="#273b46" stroke="#8d9d9f" />
          <path d={`M41 ${h - 65}v20m-10-10h20`} stroke="#a4b2b3" />
        </>
      );
    case "finance":
      return (
        <>
          <Shelf x={16} y={44} width={68} folders />
          <g transform={`translate(${w - 66} 49)`}>
            <rect width="45" height="38" rx="3" fill="#405953" stroke="#87978b" />
            <path d="M8 9h29M8 18h29M8 27h29M19 5v28M31 5v28" stroke="#a9b7a1" />
          </g>
          <g transform={`translate(20 ${h - 74})`}>
            <rect width="48" height="30" rx="3" fill="#657b7c" />
            <rect x="9" y="-6" width="29" height="21" fill="#b7c2b9" />
            <path d="M14 1h19m-19 5h14" stroke="#638081" />
          </g>
        </>
      );
    case "legal":
      return (
        <>
          <Shelf x={18} y={43} width={95} />
          <g transform={`translate(${w - 53} 62)`} stroke="#baac85" fill="none" strokeWidth="2">
            <path d="M0-16v37m-17 0h34M-22-8h44M-16-8l-10 17h20zm32 0L6 9h20z" />
          </g>
          <rect x="19" y={h - 74} width="62" height="32" rx="4" fill="#76644e" stroke="#a5987b" />
          <path d={`M29 ${h - 63}h25m-25 8h39`} stroke="#c4b79a" />
        </>
      );
    case "research":
      return (
        <>
          <Board x={16} y={43} kind="notes" width={90} />
          <g transform={`translate(${w - 49} 77)`}>
            <circle r="25" fill="#315764" stroke="#99ada7" />
            <ellipse rx="12" ry="25" fill="none" stroke="#78a098" />
            <path d="M-25 0h50M-21-12h42M-21 12h42M0 25v12m-13 0h26" stroke="#91aaa3" />
          </g>
          <Shelf x={17} y={h - 83} width={59} />
        </>
      );
    case "quality":
      return (
        <>
          <Board x={16} y={43} kind="chart" width={100} />
          <g transform={`translate(${w - 66} 53)`}>
            <rect width="47" height="42" rx="3" fill="#425a5d" stroke="#8eaaab" />
            <path d="M7 21h7l5-12 6 26 5-14h10" fill="none" stroke="#b9cdb9" strokeWidth="2" />
          </g>
          <path d={`M20 ${h - 70}h52v35H20z`} fill="#314651" stroke="#668593" />
          <path d={`M27 ${h - 60}l6 6 10-14m3 13h18M27 ${h - 43}h37`} stroke="#99b5a7" fill="none" />
        </>
      );
    case "design":
      return (
        <>
          <Board x={16} y={43} kind="notes" width={90} />
          <g transform={`translate(${w - 51} 49)`}>
            {[0, 1, 2, 3].map((i) => (
              <rect
                key={i}
                x={(i % 2) * 15}
                y={Math.floor(i / 2) * 18}
                width="13"
                height="16"
                fill={["#ba936b", "#5f8f92", "#c2c0a8", "#71856c"][i]}
              />
            ))}
          </g>
          <path d={`M20 ${h - 69}h55v33H20z`} fill="#6d776e" stroke="#a7b0a2" />
          <path d={`M28 ${h - 43}l13-17 11 9 14-12`} stroke="#d1c7a7" fill="none" />
        </>
      );
    case "marketing":
      return (
        <>
          <g transform="translate(16 43)">
            <rect width="74" height="48" rx="3" fill="#7b8e8c" />
            <circle cx="26" cy="21" r="11" fill="#c1b389" />
            <path d="M43 12h22m-22 9h16M11 39h52" stroke="#304e5a" strokeWidth="3" />
          </g>
          <g transform={`translate(${w - 44} 75)`}>
            <circle r="17" fill="none" stroke="#b6ad8b" strokeWidth="5" />
            <path d="M0 17v27m-13 0h26" stroke="#84999d" strokeWidth="3" />
          </g>
          <rect x="17" y={h - 70} width="56" height="28" rx="8" fill="#637c79" stroke="#9bb0a3" />
        </>
      );
    case "sales":
      return (
        <>
          <Board x={16} y={43} kind="chart" width={90} />
          <g transform={`translate(${w - 48} 74)`}>
            <circle r="20" fill="#696c55" stroke="#b0aa7b" />
            <path d="M-8 1l6 6 12-16" stroke="#c9c89e" strokeWidth="3" fill="none" />
          </g>
          <rect x="17" y={h - 73} width="61" height="36" rx="12" fill="#677b75" stroke="#9bada2" />
          <ellipse cx="47" cy={h - 56} rx="15" ry="7" fill="#b0a58a" />
        </>
      );
    case "knowledge":
      return (
        <>
          <Shelf x={15} y={43} width={w - 30} />
          <g transform={`translate(20 ${h - 72})`}>
            <path d="M0 0q16-8 29 0 16-8 29 0v28q-15-7-29 0-14-7-29 0Z" fill="#bbbaa5" stroke="#788b85" />
            <path d="M29 1v25M7 7h14M37 7h13M7 14h14M37 14h13" stroke="#5e7a78" />
          </g>
          <Plant x={w - 29} y={h - 35} size={0.8} />
        </>
      );
    case "automation":
      return (
        <>
          <Board x={16} y={43} kind="flow" width={90} />
          <g transform={`translate(${w - 45} 91)`} fill="none" stroke="#9db3b5" strokeWidth="5" strokeLinecap="round">
            <path d="M-17 3h33M0 0l-12-20 18-17 11 10" />
            <circle cx="-12" cy="-20" r="5" fill="#447a83" />
            <circle cx="6" cy="-37" r="5" fill="#447a83" />
            <path d="M14-24l-7 6m12-7 4 7" strokeWidth="2" />
          </g>
          <rect x="18" y={h - 69} width="58" height="31" rx="3" fill="#2d4954" stroke="#728f98" />
          <path d={`M26 ${h - 58}h17m9 0h14m-40 9h39`} stroke="#72acae" />
        </>
      );
    default:
      return (
        <>
          <Board x={18} y={43} kind="notes" />
          <Plant x={w - 29} y={h - 38} />
        </>
      );
  }
}
function RoomShell({ room, children, floorId }: { room: BuildingRoom; children: React.ReactNode; floorId: string }) {
  const warm = ["executive", "legal", "finance", "knowledge", "lounge", "decision"].includes(room.key);
  const { x, y, width: w, height: h, door } = room;
  return (
    <g data-testid={`office-room-${room.id}`} data-room-kind={room.key} transform={`translate(${x} ${y})`}>
      <rect x="0" y="7" width={w} height={h} rx="7" fill="#080f16" opacity=".6" />
      <rect width={w} height={h} rx="6" fill={warm ? "#303430" : "#23323c"} stroke="#6c818a" strokeWidth="3" />
      <rect x="4" y="4" width={w - 8} height={h - 8} rx="4" fill={`url(#${floorId}-${warm ? "wood" : "tile"})`} />
      <path d={`M11 37H${w - 11}`} stroke={warm ? "#a09170" : "#6a929e"} opacity=".65" />
      {room.doorSide === "bottom" || room.doorSide === "top" ? (
        <g transform={`translate(${door.x - x} ${door.y - y})`}>
          <path d="M-24 0h48" stroke="#1b2c35" strokeWidth="8" />
          <path d="M-24 0v-35q35 0 35 35" stroke="#89a9ae" strokeWidth="1.1" fill="none" strokeDasharray="2 3" />
          <path d="M-24-1l22-28" stroke="#9cb9bd" strokeWidth="3" />
        </g>
      ) : (
        <g transform={`translate(${door.x - x} ${door.y - y})`}>
          <path d="M0-24v48" stroke="#1b2c35" strokeWidth="8" />
          <path
            d={`M0-24h${room.doorSide === "left" ? 35 : -35}q0 35 ${room.doorSide === "left" ? -35 : 35} 35`}
            stroke="#89a9ae"
            fill="none"
            strokeDasharray="2 3"
          />
          <path d={`M0-24l${room.doorSide === "left" ? 28 : -28} 22`} stroke="#9cb9bd" strokeWidth="3" />
        </g>
      )}
      {children}
    </g>
  );
}

export const OfficeBuilding = memo(function OfficeBuilding({
  layout,
  activeAgentIds,
}: {
  layout: OfficeBuildingLayout;
  activeAgentIds: ReadonlySet<string>;
}) {
  const id = useId().replace(/:/g, "");
  const { width, height, rooms } = layout;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      className="office-building-architecture"
    >
      <defs>
        <pattern id={`${id}-wood`} width="46" height="23" patternUnits="userSpaceOnUse">
          <path d="M0 23H46M23 0v23" stroke="#93917b" opacity=".14" fill="none" />
        </pattern>
        <pattern id={`${id}-tile`} width="32" height="32" patternUnits="userSpaceOnUse">
          <path d="M32 0H0v32" stroke="#8aa1aa" opacity=".09" fill="none" />
        </pattern>
        <pattern id={`${id}-hall`} width="14" height="14" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r=".6" fill="#5c737b" opacity=".3" />
        </pattern>
      </defs>
      <rect
        x="8"
        y="16"
        width={width - 16}
        height={height - 32}
        rx="24"
        fill="#111f28"
        stroke="#607680"
        strokeWidth="3"
      />
      <rect x="15" y="23" width={width - 30} height={height - 46} rx="20" fill={`url(#${id}-hall)`} />
      {[layout.northHall, layout.middleHall, layout.southHall].map((y) => (
        <g key={y}>
          <path d={`M37 ${y}H1084`} stroke="#273e48" strokeWidth="35" />
          <path d={`M38 ${y - 17}H1081`} stroke="#5b8189" strokeWidth="1" opacity=".45" />
        </g>
      ))}
      <path
        d={`M280 ${layout.northHall}V${layout.southHall}M840 ${layout.northHall}V${layout.southHall}`}
        stroke="#273e48"
        strokeWidth="35"
      />
      <path
        d={`M280 ${layout.northHall + 30}v${layout.southHall - layout.northHall - 60}M840 ${layout.northHall + 30}v${layout.southHall - layout.northHall - 60}`}
        stroke="#7b9297"
        strokeDasharray="2 24"
        opacity=".35"
      />
      <path d="M50 30h205m65 0h210m70 0h210m62 0h203" stroke="#89acb3" strokeWidth="4" opacity=".8" />
      <text x="40" y={layout.northHall + 4} className="crew-office-hall-label">
        NORD / TECHNIK
      </text>
      <text x="879" y={layout.middleHall + 4} className="crew-office-hall-label">
        TEAM / AUSTAUSCH
      </text>
      <text x="40" y={layout.southHall + 4} className="crew-office-hall-label">
        SÜD / STUDIO
      </text>
      {rooms.map((room) => (
        <RoomShell key={room.id} room={room} floorId={id}>
          {room.departmentId ? (
            <>
              <RoomEquipment room={room} />
              {Object.entries(layout.homes)
                .filter(
                  ([, home]) =>
                    home.point.x >= room.x &&
                    home.point.x <= room.x + room.width &&
                    home.point.y >= room.y &&
                    home.point.y <= room.y + room.height,
                )
                .map(([agentId, home]) => (
                  <Workstation
                    key={agentId}
                    x={home.point.x - room.x}
                    y={home.point.y - room.y - 52}
                    kind={room.key}
                    active={activeAgentIds.has(agentId)}
                  />
                ))}
            </>
          ) : room.key === "meeting" ? (
            <>
              <rect x="31" y="59" width={room.width - 62} height="64" rx="32" fill="#405c63" stroke="#86a5a7" />
              <ellipse cx={room.width / 2} cy="91" rx="48" ry="16" fill="#2b474f" stroke="#73969b" />
              <path d={`M${room.width / 2 - 15} 91h30`} stroke="#9ec4c4" />
              <Board x={room.width / 2 - 43} y={room.height - 75} kind="flow" />
              <Plant x={room.width - 24} y={room.height - 29} size={0.75} />
            </>
          ) : room.key === "decision" ? (
            <>
              <path d={`M28 65h${room.width - 56}v35H28z`} fill="#7c7057" stroke="#b6a077" />
              <rect x={room.width / 2 - 32} y="58" width="64" height="29" rx="3" fill="#384a48" stroke="#af9d72" />
              <path d={`M${room.width / 2 - 18} 67h36m-36 9h23`} stroke="#cdb482" />
              <rect
                x="28"
                y={room.height - 72}
                width={room.width - 56}
                height="36"
                rx="12"
                fill="#686952"
                stroke="#9d9c76"
              />
            </>
          ) : (
            <>
              <rect x="20" y="52" width="181" height="45" rx="5" fill="#6c705e" stroke="#aba487" />
              <rect x="28" y="44" width="57" height="45" rx="4" fill="#273b40" stroke="#9ba8a4" />
              <rect x="37" y="52" width="24" height="15" rx="2" fill="#7c9b9b" />
              <path d="M38 74h19m-13-3v14" stroke="#bfcbc5" />
              <path d="M95 64v16h14V64m14 0v16h14V64" fill="#c6c1a9" />
              <path d="M162 66q-15-21 1-27q15 7-1 27" fill="#5e8468" />
              <rect x="15" y="101" width="193" height="6" rx="3" fill="#a09577" />
              <rect x="299" y="53" width="142" height="40" rx="12" fill="#597771" stroke="#8da79a" />
              <path d="M309 74h122m-81-17v33m49-33v33" stroke="#a0b4a3" />
              <rect x="324" y="112" width="92" height="34" rx="17" fill="#877b60" stroke="#b6a789" />
              <ellipse cx="367" cy="130" rx="12" ry="5" fill="#314f4b" />
              <path d={`M24 ${room.height - 47}h${room.width - 48}`} stroke="#597267" strokeWidth="2" />
              <Plant x={room.width - 30} y={90} size={1.2} />
              <Plant x={255} y={room.height - 35} size={1.2} />
              <text x="32" y={room.height - 20} className="crew-office-scene-note">
                KAFFEEBAR
              </text>
              <text x="325" y={room.height - 20} className="crew-office-scene-note">
                TREFFPUNKT
              </text>
            </>
          )}
        </RoomShell>
      ))}
      <path d={`M470 ${height - 17}h180`} stroke="#9bb8ba" strokeWidth="5" />
      <path d={`M530 ${height - 20}v-24m60 24v-24`} stroke="#90afb3" strokeWidth="2" />
      <text x="560" y={height - 29} textAnchor="middle" className="crew-office-hall-label">
        EINGANG / IRONCREW
      </text>
    </svg>
  );
});
