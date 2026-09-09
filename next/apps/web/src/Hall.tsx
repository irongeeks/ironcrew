import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Group, LOD, TextureLoader, SRGBColorSpace, Vector3 } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { string as str, type Row } from "./api.ts";
import styles from "./App.module.css";
import { useCrewAssets } from "./CrewAssets.ts";
import { crewActivity, crewIndex, crewPosition, crewRig, poseCrew } from "./CrewMotion.ts";
import hallStyles from "./Hall.module.css";
type Point = [number, number, number];
function Box({ p, s, c, metal = 0 }: { p: Point; s: Point; c: string; metal?: number }) {
  return (
    <mesh position={p} castShadow receiveShadow>
      <boxGeometry args={s} />
      <meshStandardMaterial color={c} metalness={metal} roughness={0.7} />
    </mesh>
  );
}
function AssetCharacter({
  index,
  asset,
  distantAsset,
  employee,
  order,
  reduced,
  onClick,
}: {
  index: number;
  asset: Group;
  distantAsset?: Group;
  employee: Row;
  order?: Row;
  reduced: boolean;
  onClick: () => void;
}) {
  const root = useRef<Group>(null),
    model = useMemo(() => {
      const detail = new LOD();
      detail.addLevel(asset.clone(true), 0);
      if (distantAsset) detail.addLevel(distantAsset.clone(true), 6, 0.12);
      return detail;
    }, [asset, distantAsset]);
  const rigs = useMemo(() => model.levels.map((level) => crewRig(level.object as Group)), [model]);
  const activity = crewActivity(employee, order);
  const home = useMemo(() => new Vector3(...crewPosition(index, "idle")), [index]);
  const target = useMemo(() => new Vector3(...crewPosition(index, activity)), [index, activity]);
  useFrame((state, delta) => {
    const group = root.current;
    if (!group) return;
    const moving = !reduced && group.position.distanceTo(target) > 0.035;
    const dx = target.x - group.position.x,
      dz = target.z - group.position.z;
    if (reduced) group.position.copy(target);
    else group.position.lerp(target, 1 - Math.exp(-Math.min(delta, 0.1) * 2.2));
    group.rotation.y = moving
      ? Math.atan2(dx, dz)
      : activity === "working" || activity === "reviewing"
        ? Math.PI
        : Math.atan2(-target.x, -target.z);
    for (const rig of rigs) poseCrew(rig, activity, state.clock.elapsedTime, moving, reduced, index * 0.73);
  });
  return (
    <group
      ref={root}
      position={home}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <primitive object={model} />
      <mesh position={[0, 0.025, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.29, 0.34, 24]} />
        <meshBasicMaterial
          color={
            activity === "working" || activity === "reviewing" || activity === "discussing"
              ? "#efb34b"
              : order?.status === "blocked"
                ? "#f18e8e"
                : "#78878d"
          }
        />
      </mesh>
    </group>
  );
}
function CameraRig({ preset }: { preset: number }) {
  const { camera, gl, invalidate, size } = useThree();
  const controlsRef = useRef<OrbitControls | null>(null);
  const fit = Math.max(1, 1.35 / (size.width / size.height));
  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controlsRef.current = controls;
    controls.target.set(0, 1, 0);
    controls.minDistance = 7;
    controls.maxDistance = 19 * fit;
    controls.minPolarAngle = 0.48;
    controls.maxPolarAngle = 1.34;
    controls.minAzimuthAngle = -Math.PI * 0.7;
    controls.maxAzimuthAngle = Math.PI * 0.7;
    controls.maxTargetRadius = 3;
    controls.addEventListener("change", () => invalidate());
    return () => {
      controls.dispose();
      controlsRef.current = null;
    };
  }, [camera, gl, invalidate, fit]);
  useEffect(() => {
    camera.position.set(
      ...(
        [
          [10, 8, 12],
          [0, 6, 14],
          [-10, 6, 10],
        ] as Point[]
      )[preset % 3],
    );
    camera.position.multiplyScalar(fit);
    controlsRef.current?.target.set(0, 1, 0);
    camera.lookAt(0, 1, 0);
    controlsRef.current?.update();
    invalidate();
  }, [preset, camera, invalidate, fit]);
  return null;
}
function Emblem() {
  const texture = useLoader(TextureLoader, "/brand/emblem.png");
  texture.colorSpace = SRGBColorSpace;
  return (
    <mesh position={[0, 3.35, -4.82]}>
      <planeGeometry args={[3.2, 3.15]} />
      <meshStandardMaterial map={texture} transparent alphaTest={0.12} />
    </mesh>
  );
}
function Scene({
  assets,
  distantAssets,
  employees,
  orders,
  reduced,
  onEmployee,
  onOrder,
}: {
  assets: (Group | undefined)[];
  distantAssets: (Group | undefined)[];
  employees: Row[];
  orders: Row[];
  reduced: boolean;
  onEmployee: (id: string) => void;
  onOrder: (id: string) => void;
}) {
  const orderOf = (person: Row) =>
    orders.find(
      (order) =>
        order.status === "running" &&
        (order.activeCoordination as Row | undefined)?.status === "running" &&
        ((order.activeCoordination as Row).employeeIds as string[] | undefined)?.includes(String(person.id)),
    ) ??
    orders.find(
      (order) =>
        order.leadEmployeeId === person.id && !["completed", "cancelled", "failed"].includes(str(order, "status")),
    );
  return (
    <>
      <color attach="background" args={["#151c20"]} />
      <fog attach="fog" args={["#151c20", 17, 36]} />
      <ambientLight intensity={0.75} />
      <hemisphereLight args={["#c1d1db", "#55422b", 1.7]} />
      <directionalLight position={[3, 9, 4]} intensity={2.7} color="#f5d59b" castShadow shadow-mapSize={[1024, 1024]} />
      <pointLight position={[0, 4, -3]} intensity={30} distance={12} color="#efb34b" />
      <Box p={[0, -0.15, 0]} s={[17, 0.3, 12]} c="#323735" metal={0.4} />
      <Box p={[0, 3, -5]} s={[17, 6, 0.25]} c="#343635" />
      <Box p={[-8.5, 3, 0]} s={[0.25, 6, 10]} c="#252f33" />
      {[-7, -3.5, 3.5, 7].map((x) => (
        <group key={x}>
          <Box p={[x, 3, -4.75]} s={[0.18, 6, 0.22]} c="#182327" metal={0.8} />
          <Box p={[x, 5.4, 0.1]} s={[0.15, 0.2, 10]} c="#222b2c" metal={0.7} />
        </group>
      ))}
      {[-3, 0, 3].map((z) => (
        <group key={z}>
          <Box p={[0, 5.25, z]} s={[15, 0.08, 0.08]} c="#e3b572" />
          <pointLight position={[0, 4.9, z]} intensity={12} distance={10} color="#e8bc72" />
        </group>
      ))}
      <Suspense fallback={null}>
        <Emblem />
      </Suspense>
      <Box p={[0, 0.91, 0]} s={[4.8, 0.17, 2.5]} c="#423e32" metal={0.65} />
      <Box p={[0, 1.01, 0]} s={[4.35, 0.035, 2.15]} c="#243d43" metal={0.7} />
      {[-1.9, 1.9].flatMap((x) =>
        [-0.9, 0.9].map((z) => <Box key={`${x}${z}`} p={[x, 0.43, z]} s={[0.14, 0.9, 0.14]} c="#192429" metal={0.8} />),
      )}
      {[-6, 6].map((x) =>
        [-3.2, -1.65, -0.1, 1.45, 3].map((z) => (
          <group key={`${x}${z}`}>
            <Box p={[x, 0.85, z]} s={[1.5, 0.12, 0.75]} c="#5e5849" />
            <Box p={[x, 1.24, z - 0.21]} s={[0.75, 0.45, 0.07]} c="#142b32" />
            <Box p={[x, 0.4, z]} s={[0.1, 0.8, 0.65]} c="#253039" metal={0.7} />
            <mesh position={[x > 0 ? 7.7 : -7.7, 1.8, z]}>
              <boxGeometry args={[0.055, 3.6, 1.4]} />
              <meshPhysicalMaterial color="#9bafb7" transparent opacity={0.1} roughness={0.15} />
            </mesh>
            <Box p={[x > 0 ? 7.7 : -7.7, 3.6, z]} s={[0.07, 0.08, 1.4]} c="#4d5d61" />
          </group>
        )),
      )}
      {employees.map((employee, fallback) => {
        const index = crewIndex(employee, fallback),
          asset = assets[index];
        return asset ? (
          <AssetCharacter
            key={str(employee, "id")}
            index={index}
            asset={asset}
            distantAsset={distantAssets[index]}
            employee={employee}
            order={orderOf(employee)}
            reduced={reduced}
            onClick={() => onEmployee(str(employee, "id"))}
          />
        ) : null;
      })}
      {orders
        .filter((o) => !["completed", "cancelled", "failed"].includes(str(o, "status")))
        .slice(0, 5)
        .map((order, index) => (
          <mesh
            key={str(order, "id")}
            position={[-1.6 + index * 0.8, 1.11, 0]}
            rotation={[-Math.PI / 2, 0, 0]}
            onClick={(event) => {
              event.stopPropagation();
              onOrder(str(order, "id"));
            }}
          >
            <planeGeometry args={[0.55, 0.7]} />
            <meshStandardMaterial color={order.status === "blocked" ? "#f18e8e" : "#dfad57"} />
          </mesh>
        ))}
    </>
  );
}
export default function Hall({
  employees,
  orders,
  onEmployee,
  onOrder,
  locale,
}: {
  employees: Row[];
  orders: Row[];
  onEmployee: (id: string) => void;
  onOrder: (id: string) => void;
  locale: "de" | "en";
}) {
  const crewAssets = useCrewAssets();
  const [failed, setFailed] = useState(false),
    [preset, setPreset] = useState(0),
    [paused, setPaused] = useState(document.hidden),
    [reduced, setReduced] = useState(matchMedia("(prefers-reduced-motion: reduce)").matches),
    [quality, setQuality] = useState(false);
  useEffect(() => {
    const change = () => setPaused(document.hidden),
      media = matchMedia("(prefers-reduced-motion: reduce)"),
      motion = () => setReduced(media.matches);
    document.addEventListener("visibilitychange", change);
    media.addEventListener("change", motion);
    return () => {
      document.removeEventListener("visibilitychange", change);
      media.removeEventListener("change", motion);
    };
  }, []);
  return (
    <div
      className={styles.hall}
      data-crew-assets={crewAssets.state}
      data-motion={reduced ? "reduced" : paused ? "paused" : "animated"}
      role="region"
      aria-label={locale === "de" ? "Räumliche Einsatzzentrale" : "Spatial headquarters"}
    >
      <p className={hallStyles.srOnly}>
        {locale === "de"
          ? "Die Halle ergänzt die Auftragsliste. Crewprofile und Aufträge sind über die Links unterhalb der Halle vollständig mit Tastatur und Touch erreichbar. Die Kamera ist mit der Maus und über Kamera wechseln bedienbar. Bewegung zeigt keinen Arbeitserfolg."
          : "The hall complements the order list. Crew profiles and orders are fully accessible using the links below the hall. Use the mouse or Change camera to control the view. Movement does not prove work success."}
      </p>
      {failed ? (
        <div className={styles.empty} role="status">
          <h3>{locale === "de" ? "Kompakte Ansicht bleibt verfügbar." : "Compact view remains available."}</h3>
          <p>
            {locale === "de"
              ? "WebGL wurde beendet. Crewprofile und Aufträge bleiben unten erreichbar."
              : "WebGL stopped. Crew profiles and orders remain accessible below."}
          </p>
        </div>
      ) : (
        <Canvas
          className={styles.hallCanvas}
          camera={{ fov: 42, position: [10, 8, 12] }}
          aria-hidden="true"
          dpr={quality ? 1 : Math.min(devicePixelRatio, 1.5)}
          shadows={!quality}
          frameloop={paused || reduced ? "demand" : "always"}
          gl={{ antialias: !quality, powerPreference: "low-power" }}
          onCreated={({ gl }) => {
            gl.domElement.addEventListener(
              "webglcontextlost",
              (e) => {
                e.preventDefault();
                setFailed(true);
              },
              { once: true },
            );
          }}
          fallback={<p>{locale === "de" ? "3D wird nicht unterstützt." : "3D is unsupported."}</p>}
        >
          <CameraRig preset={preset} />
          <Scene
            assets={crewAssets.assets}
            distantAssets={crewAssets.distantAssets}
            employees={employees}
            orders={orders}
            reduced={reduced}
            onEmployee={onEmployee}
            onOrder={onOrder}
          />
        </Canvas>
      )}
      <span className={styles.hallNote}>
        {locale === "de"
          ? "Neun Crew-Personas · Positionen zeigen den Auftragsstatus"
          : "Nine crew personas · positions reflect order status"}
        {crewAssets.state === "fallback" &&
          (locale === "de" ? " · GLB nicht verfügbar, Ersatzdarstellung aktiv" : " · GLB unavailable, fallback active")}
      </span>
      {!failed && (
        <div className={styles.hallTools} role="group" aria-label={locale === "de" ? "Hallenansicht" : "Hall view"}>
          <button onClick={() => setPreset((v) => v + 1)}>
            {locale === "de" ? "Kamera wechseln" : "Change camera"}
          </button>
          <button aria-pressed={quality} onClick={() => setQuality((v) => !v)}>
            {quality
              ? locale === "de"
                ? "Höhere Qualität"
                : "Higher quality"
              : locale === "de"
                ? "Grafik reduzieren"
                : "Reduce graphics"}
          </button>
          <button aria-pressed={reduced} onClick={() => setReduced((v) => !v)}>
            {reduced
              ? locale === "de"
                ? "Bewegung an"
                : "Enable motion"
              : locale === "de"
                ? "Bewegung aus"
                : "Disable motion"}
          </button>
        </div>
      )}
    </div>
  );
}
