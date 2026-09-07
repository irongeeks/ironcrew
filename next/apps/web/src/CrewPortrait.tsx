import { useState } from "react";
import { string as str, type Row } from "./api.ts";
import portraits from "../public/crew/portraits.json" with { type: "json" };
import styles from "./Hall.module.css";
/** Static render of the same GLB used by the hall; no extra WebGL context for profile cards. */
export default function CrewPortrait({ person }: { person: Row }) {
  const [failed, setFailed] = useState(false);
  const portrait = portraits.portraits.find((entry) => entry.seedKey === person.seedKey);
  if (!portrait || failed) return null;
  return (
    <img
      className={styles.portrait}
      src={portrait.url}
      width={160}
      height={210}
      alt={`${str(person, "displayName")} · ${str(person, "appearance")}`}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
