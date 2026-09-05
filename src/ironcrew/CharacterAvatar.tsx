import { useState, type ReactNode } from "react";
import { CHARACTER_SKINS, type CharacterSkinId } from "../shared/character-skins";
import type { AgentStatus, CharacterAnimationConfig } from "./types";
import { CharacterSprite } from "./CharacterSprite";

export interface CharacterAvatarProps {
  characterId?: string | null;
  seed?: string;
  fullBodyUrl?: string | null;
  portraitUrl?: string | null;
  animation?: CharacterAnimationConfig | null;
  mode?: "full_body" | "portrait";
  status?: AgentStatus;
  className?: string;
  label?: string;
}

export function resolveCharacterId(id: string | null | undefined, seed = "crew"): CharacterSkinId {
  const explicit = CHARACTER_SKINS.find((skin) => skin.id === id);
  if (explicit) return explicit.id;
  const hash = Array.from(seed).reduce((value, letter) => (value * 31 + letter.charCodeAt(0)) >>> 0, 0);
  return CHARACTER_SKINS[hash % CHARACTER_SKINS.length].id;
}

type Hair = "short" | "braid" | "long" | "bun" | "afro" | "bald" | "pony" | "swept" | "mohawk";
type Outfit =
  | "tunic"
  | "workshirt"
  | "armor"
  | "gown"
  | "vest"
  | "labcoat"
  | "flight"
  | "cloak"
  | "waistcoat"
  | "apron"
  | "suit"
  | "shorts"
  | "wetsuit"
  | "overalls"
  | "gardener";

function Human({
  skin,
  cloth,
  accent,
  hair,
  outfit,
  hairColor = "#26313b",
  beard = false,
  glasses = false,
  detail,
  headgear,
}: {
  skin: string;
  cloth: string;
  accent: string;
  hair: Hair;
  outfit: Outfit;
  hairColor?: string;
  beard?: boolean;
  glasses?: boolean;
  detail?: ReactNode;
  headgear?: ReactNode;
}): React.JSX.Element {
  const longCoat = ["cloak", "gown", "labcoat"].includes(outfit);
  return (
    <g strokeLinejoin="round" strokeLinecap="round">
      {hair === "long" && <path d="M24 11q-5 17-9 28h42q-9-20-8-29z" fill={hairColor} />}
      {hair === "pony" && <path d="M45 8q18 1 13 25l-9-8 1-15z" fill={hairColor} />}
      {outfit === "cloak" && <path d="M25 22 13 70q22 11 47-1L48 22z" fill={cloth} stroke="#6c858a" />}
      {outfit !== "gown" && (
        <>
          <path
            d={outfit === "shorts" ? "M25 48h10l-3 29h-9zm13 0h10l4 29H41z" : "M25 48h10l-3 29h-9zm13 0h10l4 29H41z"}
            fill={outfit === "shorts" ? skin : "#25333e"}
            stroke="#586772"
          />
          <path
            d="M23 74h10v8H18q-1-5 5-8m18 0h11q6 3 5 8H41z"
            fill={outfit === "flight" || outfit === "armor" ? "#5d717a" : "#18232c"}
            stroke="#85919a"
          />
        </>
      )}
      {outfit === "gown" ? (
        <path d="M28 25h16l7 27 8 28q-23 7-46 0l9-29z" fill={cloth} stroke="#b9a790" />
      ) : (
        <path
          d={
            outfit === "armor"
              ? "M19 28 35 23 53 28 50 59H22z"
              : longCoat
                ? "M25 27 36 23 48 27 55 68H18z"
                : "M25 27 36 23 48 27 49 55H23z"
          }
          fill={cloth}
          stroke="#83949c"
        />
      )}
      <path
        d={
          outfit === "armor"
            ? "M19 27 10 33 8 58l11 1 9-25m25-7 9 6 3 26-11 1-8-25"
            : "M25 28 17 33 12 54l6 4 10-22m20-8 8 7 5 20-7 3-8-21"
        }
        fill={cloth}
        stroke="#82929b"
      />
      <path d="m12 54 6 3-1 7-6-2m43-6 7-2 1 7-6 3" fill={skin} />
      {outfit === "tunic" && (
        <>
          <path d="m29 25 7 12 9-11m-9 11v20" fill="none" stroke={accent} strokeWidth="3" />
          <path d="M25 50h22" stroke={accent} />
        </>
      )}
      {outfit === "workshirt" && (
        <>
          <path d="M21 33h8v11h-8m21-10h8v10h-8M25 50h23" fill="none" stroke={accent} strokeWidth="3" />
          <path d="M27 52v9h6v-9m9 0v12" stroke="#d9b775" strokeWidth="4" />
        </>
      )}
      {outfit === "armor" && (
        <>
          <path d="m26 31 10-5 10 5-2 16-8 6-9-6z" fill="#425e67" stroke={accent} strokeWidth="2" />
          <path d="M24 57h9v11h-10m17-11h9l2 11H40" fill="#607b84" stroke="#9cabb1" />
          <path d="m10 34 12-4m31 0 10 6" stroke={accent} strokeWidth="4" />
        </>
      )}
      {outfit === "gown" && (
        <>
          <path d="m29 26 7 9 8-9M23 51h27m-15 0-7 27m13-27 8 27" fill="none" stroke={accent} strokeWidth="2" />
          <path d="M28 37q8 9 17 0" fill="none" stroke="#dfc27b" />
        </>
      )}
      {outfit === "vest" && (
        <>
          <path d="m27 27 9 15 10-15-2 28H27z" fill={accent} />
          <path d="M36 40v15m-8-9h5m6 0h5" stroke="#33434d" />
        </>
      )}
      {outfit === "labcoat" && (
        <>
          <path d="m29 26 7 15 8-15m-8 15v26M22 51h8v9h-8m19-9h8v9h-8" stroke="#7e9ca5" fill="none" />
          <path d="M44 36v9m-4-4h8" stroke={accent} strokeWidth="3" />
        </>
      )}
      {outfit === "flight" && (
        <>
          <path d="M29 27v28m15-28v28M23 47h27" stroke={accent} strokeWidth="3" />
          <rect x="30" y="35" width="13" height="12" rx="2" fill="#405867" stroke="#9babaf" />
          <path d="M33 39h7m-7 4h3" stroke="#c4d8d8" />
        </>
      )}
      {outfit === "cloak" && (
        <>
          <path d="m29 27 7 10 9-10M36 37v27" fill="none" stroke={accent} strokeWidth="2" />
          <path d="m44 45 12 23" stroke="#95b59c" strokeWidth="3" />
        </>
      )}
      {outfit === "waistcoat" && (
        <>
          <path d="m27 26 9 15 10-15-2 28H27z" fill="#6c6060" stroke={accent} />
          <path d="M36 40v14m1-8q11 4 12-4" fill="none" stroke="#c7b581" />
          <path d="m31 28 5 5 5-5" stroke="#ddd4bf" strokeWidth="4" />
        </>
      )}
      {outfit === "apron" && (
        <>
          <path d="M29 28h15v15l9 21H20l8-21z" fill={accent} stroke="#c0a087" />
          <path d="M28 46h16v10H28z" fill="#6c594d" />
          <path d="m32 44 2-9m5 9 3-12" stroke="#cbd1c3" strokeWidth="2" />
        </>
      )}
      {outfit === "suit" && (
        <>
          <path d="m29 26 7 21 8-21m-8 15-5-8 5-5 4 5z" fill="#cbd3ce" />
          <path d="m25 27 11 20-9 5m21-25-12 20 10 6" fill="none" stroke={accent} strokeWidth="2" />
          <circle cx="36" cy="52" r="1.5" fill={accent} />
        </>
      )}
      {outfit === "shorts" && (
        <>
          <path d="M24 49h25l1 14H38l-2-10-2 10H23z" fill="#536373" stroke="#8b9c9f" />
          <path d="M26 27 49 49" stroke={accent} strokeWidth="5" />
          <rect x="38" y="39" width="15" height="17" rx="3" fill="#987954" stroke="#cbb68a" />
        </>
      )}
      {outfit === "wetsuit" && (
        <>
          <path d="m29 26 7 9 8-9m-8 9v22M25 48h23" fill="none" stroke={accent} strokeWidth="3" />
          <path d="M24 58h8m10 0h7" stroke={accent} strokeWidth="5" />
        </>
      )}
      {(outfit === "overalls" || outfit === "gardener") && (
        <>
          <path d="M28 28v12h16V28m-16 9h16v17H28z" fill={accent} stroke="#9fa7a0" strokeWidth="2" />
          <path d="M32 43h8v6h-8" fill="#435157" />
          <circle cx="29" cy="38" r="1.5" fill="#d9be86" />
          <circle cx="43" cy="38" r="1.5" fill="#d9be86" />
        </>
      )}
      <path d="M31 19h10v9l-5 4-5-4z" fill={skin} />
      <path d="M26 10q1-10 11-9 11 1 10 13l-2 7q-9 9-17 0z" fill={skin} stroke="#31404a" strokeWidth=".6" />
      {hair === "short" && <path d="M25 13Q22 0 36 0q15 0 12 15l-5-7q-9 5-15 2z" fill={hairColor} />}
      {hair === "braid" && (
        <>
          <path d="M25 12Q22 0 36 0q15 1 11 16l-4-10q-8 8-15 4z" fill={hairColor} />
          <path d="M46 17q9 8 1 13 7 6 0 11" stroke={hairColor} strokeWidth="6" fill="none" />
        </>
      )}
      {hair === "long" && <path d="M25 14Q20 0 36 0q16-2 13 17l-7-12q-4 8-15 7z" fill={hairColor} />}
      {hair === "bun" && (
        <>
          <circle cx="38" cy="3" r="6" fill={hairColor} />
          <path d="M25 13Q22 0 36 0q15 0 12 14l-8-8-12 7z" fill={hairColor} />
        </>
      )}
      {hair === "afro" && (
        <path d="M26 16q-8 0-8-8 0-7 6-8 0-6 8-5 6-5 11 0 8-1 9 6 7 3 3 10 0 8-8 7l-4-7q-9 3-15-1z" fill={hairColor} />
      )}
      {hair === "bald" && <path d="M27 8q8-8 17 0" stroke="#f1d0af" opacity=".45" fill="none" />}
      {hair === "pony" && <path d="M25 13Q22 0 36 0q15 0 12 15l-8-8-13 5z" fill={hairColor} />}
      {hair === "swept" && <path d="M25 14q-5-12 0-15 1 6 6 3 16-11 19 6l-8-3q-7 9-17 9" fill={hairColor} />}
      {hair === "mohawk" && <path d="m31 7 1-12 5 4 4-2 2 10z" fill={hairColor} />}
      <path d="M29 16h3m8 0h3" stroke="#26343a" strokeWidth="1.6" />
      {beard && <path d="m27 19 5 2 4-2 5 2 5-3-3 8-7 4-7-5z" fill={hairColor} />}
      {glasses && <path d="M27 13h8v6h-8zm10 0h8v6h-8zm-2 2h2" fill="none" stroke="#384e59" strokeWidth="1.5" />}
      {headgear}
      {detail}
    </g>
  );
}

/** Each original preset has its own anatomy, clothing construction and details.
 * They are deliberately separate from professional role and permissions. */
function PresetBody({ id }: { id: CharacterSkinId }): React.JSX.Element {
  switch (id) {
    case "navigator":
      return (
        <Human
          skin="#bd8766"
          cloth="#385b67"
          accent="#80c5c4"
          hair="braid"
          outfit="tunic"
          hairColor="#292f37"
          detail={<path d="M53 42h12v18H53z" fill="#17353e" stroke="#92c3cb" />}
        />
      );
    case "engineer":
      return (
        <Human
          skin="#a87654"
          cloth="#ab704b"
          accent="#dbc7a0"
          hair="mohawk"
          outfit="workshirt"
          hairColor="#263139"
          beard
          detail={<path d="m15 48-5 10m-3 1 4-5 4 3-2 5z" fill="#9eadb3" stroke="#ccd2ce" />}
        />
      );
    case "sentinel":
      return (
        <Human
          skin="#755241"
          cloth="#546a75"
          accent="#8bbac4"
          hair="short"
          outfit="armor"
          beard
          detail={<path d="m53 41 14 3-1 20-11 6-5-8z" fill="#405864" stroke="#a2b6bd" />}
        />
      );
    case "diplomat":
      return (
        <Human
          skin="#e1b18d"
          cloth="#7e6250"
          accent="#e0bc78"
          hair="long"
          outfit="gown"
          hairColor="#40312d"
          detail={<path d="M25 15v5m22-5v5" stroke="#e4c980" strokeWidth="2" />}
        />
      );
    case "analyst":
      return (
        <g>
          <Human skin="#c89770" cloth="#37495c" accent="#8aa3b1" hair="short" outfit="vest" glasses />
          <path d="M18 48v20h34l5 11H43" fill="none" stroke="#a6bdc4" strokeWidth="4" />
          <circle cx="23" cy="66" r="17" fill="#223541" stroke="#a3b8c2" strokeWidth="3" />
          <circle cx="23" cy="66" r="10" fill="none" stroke="#668390" />
          <path d="m23 50 0 32m-16-16h32" stroke="#668390" />
          <circle cx="56" cy="78" r="5" fill="#23343d" stroke="#b0bdc3" />
          <path d="m33 44 20-3 3 13-20 3z" fill="#72959e" stroke="#b6d8d8" />
        </g>
      );
    case "medic":
      return (
        <Human
          skin="#835b47"
          cloth="#d3dbd8"
          accent="#589c97"
          hair="bun"
          outfit="labcoat"
          detail={<path d="M50 50h17v15H50zM55 48v-3h7v3" fill="#587f7c" stroke="#b7c9c4" />}
        />
      );
    case "pilot":
      return (
        <Human
          skin="#d6a282"
          cloth="#75837b"
          accent="#c7b08a"
          hair="short"
          outfit="flight"
          headgear={
            <>
              <path d="M24 13Q22-3 36-3q16 0 14 19l-5-4-2-8H30l-2 10z" fill="#9eafa9" stroke="#d0d8cf" />
              <path d="M27 9h20v9H27z" fill="#3d626d" stroke="#bfcdd0" />
              <path d="M48 17v10h-9" fill="none" stroke="#576e78" strokeWidth="3" />
            </>
          }
        />
      );
    case "ranger":
      return (
        <Human
          skin="#a68165"
          cloth="#425e56"
          accent="#a5bd94"
          hair="short"
          outfit="cloak"
          headgear={<path d="M23 20Q17-6 36-4q20 3 15 26l-7-16q-7-5-14 0z" fill="#557264" stroke="#829b81" />}
          detail={<path d="M13 42v40" stroke="#b7a078" strokeWidth="3" />}
        />
      );
    case "archivist":
      return (
        <Human
          skin="#ce9d7f"
          cloth="#55575b"
          accent="#bba078"
          hair="swept"
          hairColor="#c2c3b9"
          outfit="waistcoat"
          glasses
          detail={
            <>
              <path d="M54 52q6-9 8-1v31" fill="none" stroke="#c0ad85" strokeWidth="3" />
              <path d="M8 42h12v18H8z" fill="#806152" stroke="#c8b591" />
            </>
          }
        />
      );
    case "artisan":
      return (
        <Human
          skin="#8e5e48"
          cloth="#536978"
          accent="#b78a66"
          hair="afro"
          outfit="apron"
          hairColor="#40332e"
          detail={
            <>
              <path d="m9 42 4 11 6-2-3-11z" fill="#d7bf90" />
              <path d="m8 39 4-3 5 5-4 3z" fill="#a6cbc5" />
            </>
          }
        />
      );
    case "strategist":
      return (
        <Human
          skin="#a97556"
          cloth="#344252"
          accent="#8aadb7"
          hair="bald"
          outfit="suit"
          beard
          detail={<path d="M51 50h14v15H51zM55 49v-4h6v4" fill="#685e52" stroke="#b2a898" />}
        />
      );
    case "courier":
      return (
        <Human
          skin="#dcaa86"
          cloth="#9b684e"
          accent="#e1bc7a"
          hair="pony"
          outfit="shorts"
          hairColor="#54392d"
          detail={<path d="M21 72h12m9 0h10" stroke="#ccba9a" strokeWidth="4" />}
        />
      );
    case "diver":
      return (
        <Human
          skin="#8f6854"
          cloth="#354e68"
          accent="#89c4cb"
          hair="short"
          outfit="wetsuit"
          headgear={
            <>
              <circle cx="36" cy="13" r="17" fill="#5c8e9b" fillOpacity=".5" stroke="#a8c5cb" strokeWidth="3" />
              <path d="M24 1q-7 14 1 22" fill="none" stroke="#d4e2e0" />
              <path d="M50 21q13 10 3 21" fill="none" stroke="#b9a774" strokeWidth="3" />
            </>
          }
          detail={<path d="M22 79 15 85h18v-6m8 0v6h19l-9-6" fill="#78a0a7" stroke="#aec5c9" />}
        />
      );
    case "mechanic":
      return (
        <Human
          skin="#714e3e"
          cloth="#777c71"
          accent="#446678"
          hair="afro"
          hairColor="#26313b"
          beard
          outfit="overalls"
          detail={<path d="m58 39 4 3-4 4 2 12-4 1-2-14-3-4 2-3 3 4z" fill="#b5c5c9" />}
        />
      );
    case "botanist":
      return (
        <Human
          skin="#d4a381"
          cloth="#aaa586"
          accent="#58796b"
          hair="bun"
          hairColor="#805d46"
          outfit="gardener"
          detail={
            <>
              <path d="M49 50h18l-3 14H52z" fill="#92755b" stroke="#c3ac85" />
              <path
                d="M57 52q-17-8-11-14 12 2 11 14m0 0q15-16 19-9-4 11-17 10m-2-1q-7-20 1-22 8 11 1 23"
                fill="#6c967d"
                stroke="#9cb49b"
              />
            </>
          }
        />
      );
    case "android":
      return (
        <g stroke="#8dacae" strokeWidth="1.2">
          <path d="m26 48 9 1-3 28-6 3h-8l6-8zm12 1 9-1 3 24 6 8H44l-5-6z" fill="#c8d5d4" />
          <path d="m26 25 10-4 10 4 3 20-8 13H31l-9-13z" fill="#cedbd7" />
          <path d="m26 26-9 8-7 23 5 4 9-23m22-12 8 9 8 24-6 2-8-22" fill="#a3bfc2" />
          <ellipse cx="36" cy="12" rx="11" ry="14" fill="#d4e1da" />
          <path d="M27 11h18v5H27z" fill="#345e67" />
          <path d="M29 13h4m6 0h4" stroke="#9cdddc" strokeWidth="2" />
          <path d="M33 30h6v16h-6z" fill="#3c7e85" />
          <circle cx="27" cy="57" r="3" fill="#41616b" />
          <circle cx="45" cy="57" r="3" fill="#41616b" />
        </g>
      );
    case "automaton":
      return (
        <g stroke="#a2aeb0" strokeLinejoin="round">
          <path d="m23 59-11 15v7h12l6-15m13-7 9 5 10 13v5H49l-9-14m-4-7v18" strokeWidth="6" fill="#6b7f88" />
          <rect x="17" y="30" width="39" height="33" rx="8" fill="#687b7c" />
          <rect x="23" y="8" width="29" height="23" rx="5" fill="#a4aaa0" />
          <path d="M25 16h25v9H25z" fill="#293f47" />
          <circle cx="32" cy="20" r="3" fill="#d8bc7b" />
          <circle cx="43" cy="20" r="3" fill="#d8bc7b" />
          <path d="M38 8V0m-3 0h6" strokeWidth="2" />
          <path d="M19 36 7 43l1 15m47-21 10 8-4 14" fill="none" strokeWidth="5" />
          <rect x="26" y="38" width="21" height="15" rx="3" fill="#344f59" />
          <path d="M30 42h13m-13 5h8" stroke="#b5c9c7" />
        </g>
      );
    case "visitor":
      return (
        <g stroke="#769a98" strokeWidth="1">
          <path d="m29 43 7 1-3 34-10 5h-7l10-10zm9 1 6-1 4 32 11 8H47l-6-7z" fill="#77928e" />
          <path d="m28 24 8-4 9 4 3 23-12 8-10-8z" fill="#596e74" />
          <path d="M29 27 20 37 9 65m35-38 8 12 12 26" fill="none" stroke="#a4b5a7" strokeWidth="5" />
          <path d="M20 5q2-15 17-13 19 0 16 16-3 12-16 21Q24 22 20 5" fill="#acb7a8" />
          <path d="M24 5q12-2 10 12Q24 16 24 5m25 0q-12-2-10 12Q49 16 49 5" fill="#203b40" />
          <path d="M33 22h7" stroke="#5e7d76" />
          <circle cx="36" cy="38" r="5" fill="#9abfb3" />
        </g>
      );
    case "cephalid":
      return (
        <g stroke="#7bacab" strokeWidth="1.1">
          <path
            d="M26 44q-18 17-16 33 4 12 13 1-10 4-5-10l12-12m7-12q-7 13-6 29-3 12-10 5 3 12 13 5 5-6 6-19m4-22q12 13 10 29 0 10 8 4-2 13-12 7-6-9-4-21m-5-13q3 14 2 30 5 9 9 2-5 1-4-8l-1-25"
            fill="#5f9290"
          />
          <path d="M23 24q13-10 28 0l5 23-19 10-19-10z" fill="#8a785c" />
          <path d="M21 33 9 43l-5 14m47-24 11 11 5 12" fill="none" stroke="#80a9a0" strokeWidth="7" />
          <path d="M21 6q15-16 30-1l2 15q-17 19-33 0z" fill="#84aaa0" />
          <path d="m24 8-5-10m29 10 6-11" strokeWidth="3" />
          <ellipse cx="28" cy="14" rx="5" ry="6" fill="#263e43" />
          <ellipse cx="44" cy="14" rx="5" ry="6" fill="#263e43" />
          <path d="M28 32h16m-16 5h16m-16 5h8" stroke="#d1be8b" />
        </g>
      );
    case "crystalline":
      return (
        <g stroke="#dbc69e" strokeWidth="1" strokeLinejoin="round">
          <path d="m25 44 11 6-5 23-14 9 6-25zm13 6 11-6 3 28 9 10H44l-4-20" fill="#8b8e85" />
          <path d="m24 22 13-8 13 9 6 19-20 15-17-14z" fill="#8baba8" />
          <path d="m25 25 11 13 14-13-14 29z" fill="#b9c8b5" />
          <path d="m24 27-12 7-7 26 12-9 9-11m24-13 11 8 7 25-14-12-7-10" fill="#749b9e" />
          <path d="m22 4 6-13 8 9 10-9 6 15-8 19-10 6-10-11z" fill="#b7b99d" />
          <path d="m22 4 13 4 17-4-17 22z" fill="#8da9a1" />
          <path d="m27 10 5 2m8 0 5-3" stroke="#27454d" strokeWidth="3" />
          <path d="m35 8 1 18" fill="none" />
        </g>
      );
  }
}

export function CharacterAvatar({
  characterId,
  seed,
  fullBodyUrl,
  portraitUrl,
  animation,
  mode = "full_body",
  status = "idle",
  className,
  label,
}: CharacterAvatarProps): React.JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [failedAnimation, setFailedAnimation] = useState<string | null>(null);
  const id = resolveCharacterId(characterId, seed);
  const url = mode === "portrait" ? portraitUrl || fullBodyUrl : fullBodyUrl;
  const showUpload = !!url && url !== failedUrl;
  const squarePortrait = mode === "portrait" && !!portraitUrl && showUpload;
  const showAnimation =
    mode === "full_body" &&
    animation &&
    animation.url !== failedAnimation &&
    (animation.states[status] || animation.states.idle);
  const fallbackBody = showUpload ? (
    <image
      href={url}
      x="0"
      y={squarePortrait ? 0 : -8}
      width="72"
      height={squarePortrait ? 72 : 98}
      preserveAspectRatio={squarePortrait ? "xMidYMid meet" : "xMidYMax meet"}
      onError={() => setFailedUrl(url)}
    />
  ) : (
    <PresetBody id={id} />
  );
  return (
    <svg
      className={className}
      viewBox={squarePortrait ? "0 0 72 72" : mode === "portrait" ? "8 -9 56 61" : "0 -10 72 100"}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-character-id={id}
      data-character-source={showAnimation ? "animation" : showUpload ? "upload" : "preset"}
    >
      {mode === "full_body" && (
        <>
          <ellipse cx="36" cy="83" rx="25" ry="5" fill="#091016" opacity=".6" />
          <ellipse
            className="crew-office-person-ring"
            cx="36"
            cy="82"
            rx="29"
            ry="7"
            fill="none"
            stroke="currentColor"
            opacity=".6"
          />
        </>
      )}
      <g className="crew-office-person-body">
        {showAnimation ? (
          <CharacterSprite
            config={animation}
            status={status}
            fallback={fallbackBody}
            onError={() => setFailedAnimation(animation.url)}
          />
        ) : (
          fallbackBody
        )}
      </g>
      {status === "thinking" && (
        <g className="crew-office-thought">
          <path d="M2 18h17v11H6l-4 4z" fill="#173139" stroke="currentColor" />
          <path d="M6 22h9m-9 3h5" stroke="currentColor" />
        </g>
      )}
      {(status === "rate_limited" || status === "paused") && (
        <g>
          <circle cx="59" cy="15" r="10" fill="#272a2b" stroke="currentColor" />
          <path d="M56 10v10m6-10v10" stroke="currentColor" strokeWidth="2" />
        </g>
      )}
      {status === "error" && (
        <g>
          <path d="m57 4 12 21H45z" fill="#37232b" stroke="currentColor" />
          <path d="M57 10v7m0 3v1" stroke="currentColor" strokeWidth="2" />
        </g>
      )}
    </svg>
  );
}
