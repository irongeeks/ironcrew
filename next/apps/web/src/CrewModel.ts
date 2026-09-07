/** Repository-owned, deterministic low-poly characters. No external textures or model calls. */
import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
} from "three";
export const crewKeys = [
  "chief_of_staff",
  "software",
  "operations",
  "design",
  "marketing",
  "finance",
  "research",
  "quality",
  "security",
] as const;
export const crewNames = [
  "cersei-lannister",
  "mr-robot",
  "morpheus",
  "steve-jobs",
  "tyrion-lannister",
  "saul-goodman",
  "karla-kolumna",
  "der-professor",
  "nick-fury",
];
export const crewFeatures = [
  ["golden-braids", "burgundy-dress", "gold-belt"],
  ["work-jacket", "dark-cap", "beard", "glasses"],
  ["bald", "rimless-sunglasses", "long-overcoat"],
  ["black-turtleneck", "round-glasses", "jeans", "sneakers"],
  ["short-stature", "wavy-hair", "beard", "burgundy-vest", "gold-buttons"],
  ["swept-hair", "blue-suit", "patterned-tie", "pocket-square"],
  ["short-dark-hair", "round-glasses", "red-jacket", "camera", "notebook"],
  ["tousled-hair", "beard", "angular-glasses", "rolled-shirt"],
  ["bald", "eye-patch", "broad-shoulders", "leather-coat"],
];
type Point = [number, number, number];
export function createCrewModel(index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= crewKeys.length) throw new Error("unknown_crew_model");
  const root = new Group();
  root.name = crewNames[index]!;
  root.userData = {
    provenance: "IronCrew repository-authored procedural character",
    revision: 2,
    seedKey: crewKeys[index],
    features: crewFeatures[index],
  };
  const coat = ["#6d2937", "#4b534b", "#24282a", "#242628", "#782f3b", "#3d527c", "#ab3934", "#afbab0", "#20272c"][
    index
  ]!;
  const skin = ["#e4baa2", "#c79c82", "#865938", "#c8a287", "#c59b7f", "#d3aa8c", "#deb49e", "#c5a186", "#76503b"][
    index
  ]!;
  const hair = ["#d1ac60", "#65503d", "#302b24", "#7e7b70", "#785238", "#654631", "#3e3027", "#3c3027", "#2d2822"][
    index
  ]!;
  const short = index === 4,
    slim = [0, 3, 6, 7].includes(index),
    broad = [2, 8].includes(index);
  const hip = short ? 0.49 : 0.87,
    shoulder = short ? 1.0 : 1.49,
    headY = short ? 1.31 : 1.79;
  const width = broad ? 0.31 : slim ? 0.225 : 0.26;
  const materials = new Map<string, MeshStandardMaterial>();
  const geometries = new Map<string, BufferGeometry>();
  function geometry(key: string, make: () => BufferGeometry) {
    if (!geometries.has(key)) geometries.set(key, make());
    return geometries.get(key)!;
  }
  function add(parent: Group, geo: BufferGeometry, p: Point, s: Point, color: string, name?: string) {
    if (!materials.has(color))
      materials.set(color, new MeshStandardMaterial({ color, roughness: color === "#20272c" ? 0.4 : 0.76 }));
    const mesh = new Mesh(geo, materials.get(color));
    mesh.position.set(...p);
    mesh.scale.set(...s);
    mesh.name = name ?? "";
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }
  const box = (parent: Group, p: Point, s: Point, c: string, name?: string) =>
    add(
      parent,
      geometry("box", () => new BoxGeometry(1, 1, 1)),
      p,
      s,
      c,
      name,
    );
  const ball = (parent: Group, p: Point, s: Point, c: string, name?: string) =>
    add(
      parent,
      geometry("sphere", () => new SphereGeometry(1, 10, 8)),
      p,
      s,
      c,
      name,
    );
  const tube = (parent: Group, p: Point, r: number, h: number, c: string) =>
    add(
      parent,
      geometry("tube", () => new CylinderGeometry(0.88, 1, 1, 8)),
      p,
      [r, h, r],
      c,
    );
  const joint = (parent: Group, name: string, p: Point) => {
    const group = new Group();
    group.name = name;
    group.position.set(...p);
    parent.add(group);
    return group;
  };
  const torso = joint(root, "Torso", [0, hip, 0]);
  const torsoHeight = shoulder - hip;
  ball(torso, [0, torsoHeight * 0.51, 0], [width, torsoHeight * 0.6, 0.16], coat);
  ball(torso, [0, torsoHeight - 0.08, 0], [width * 1.05, 0.13, 0.15], coat, "Shoulders");
  box(torso, [0, 0.02, 0], [width * 1.55, 0.16, 0.27], index === 3 ? "#536d88" : coat);
  for (const side of [-1, 1]) {
    const leg = joint(root, side < 0 ? "LeftLeg" : "RightLeg", [side * width * 0.49, hip, 0]);
    const length = (hip - 0.1) / 2,
      trouser = index === 3 ? "#536d88" : "#303538";
    tube(leg, [0, -length / 2, 0], short ? 0.093 : 0.079, length, trouser);
    const knee = joint(leg, side < 0 ? "LeftKnee" : "RightKnee", [0, -length, 0]);
    tube(knee, [0, -length / 2, 0], 0.071, length, trouser);
    box(knee, [0, -length, 0.07], [0.145, 0.11, 0.27], index === 3 ? "#c9c5b8" : "#252728");
    if (index === 3) box(knee, [0, -length - 0.039, 0.07], [0.15, 0.025, 0.28], "#e2dbcb");
    const arm = joint(torso, side < 0 ? "LeftArm" : "RightArm", [side * (width + 0.025), torsoHeight - 0.025, 0]);
    arm.rotation.z = -side * 0.08;
    const upper = short ? 0.22 : 0.29,
      lower = short ? 0.2 : 0.27;
    tube(arm, [0, -upper / 2, 0], broad ? 0.085 : 0.071, upper, coat);
    const elbow = joint(arm, side < 0 ? "LeftForearm" : "RightForearm", [0, -upper, 0]);
    tube(elbow, [0, -lower / 2, 0], 0.064, lower, index === 7 ? skin : coat);
    if (index === 7) tube(elbow, [0, -0.026, 0], 0.073, 0.065, "#d6dacd");
    ball(elbow, [0, -lower - 0.025, 0.008], [0.061, 0.077, 0.05], skin);
  }
  if ([0, 2, 8].includes(index)) {
    const skirt = add(
      root,
      geometry("coat", () => new CylinderGeometry(0.75, 1, 1, 10, 1, true)),
      [0, hip - 0.19, -0.025],
      [width * 1.13, index === 0 ? 0.87 : 0.62, 0.21],
      coat,
      "CoatSkirt",
    );
    skirt.position.y = index === 0 ? 0.56 : hip - 0.22;
    for (const side of [-1, 1]) {
      const lapel = box(
        torso,
        [side * 0.11, torsoHeight * 0.68, 0.16],
        [0.077, torsoHeight * 0.57, 0.026],
        index === 0 ? "#bd914a" : "#3b4243",
      );
      lapel.rotation.z = side * 0.24;
    }
  }
  if ([1, 5, 6, 7].includes(index)) {
    box(
      torso,
      [0, torsoHeight * 0.52, 0.159],
      [index === 7 ? 0.035 : 0.11, torsoHeight * 0.85, 0.023],
      index === 1 ? "#958b75" : index === 7 ? "#c1c8bd" : "#d5d4c4",
    );
    for (const side of [-1, 1]) {
      const lapel = box(torso, [side * 0.083, torsoHeight * 0.71, 0.175], [0.059, 0.22, 0.026], coat);
      lapel.rotation.z = side * 0.29;
    }
  }
  if ([0, 4].includes(index)) {
    box(torso, [0, 0.11, 0.157], [width * 1.65, 0.045, 0.035], "#b99553");
    for (let y = 0.2; y < torsoHeight - 0.09; y += 0.09)
      ball(torso, [0.04, y, 0.164], [0.018, 0.018, 0.012], "#d3b776");
  }
  if (index === 1)
    for (const side of [-1, 1]) box(torso, [side * 0.145, 0.32, 0.15], [0.13, 0.15, 0.03], "#62675a", "JacketPocket");
  if (index === 5) {
    box(torso, [0, 0.33, 0.19], [0.047, 0.33, 0.024], "#be833c", "Tie");
    for (const y of [0.23, 0.33, 0.43]) {
      const stripe = box(torso, [0, y, 0.205], [0.05, 0.024, 0.01], "#527d80");
      stripe.rotation.z = -0.3;
    }
    box(torso, [-0.13, 0.4, 0.166], [0.072, 0.048, 0.025], "#c6afa5", "PocketSquare");
  }
  tube(torso, [0, torsoHeight + 0.06, 0], index === 3 ? 0.092 : 0.069, 0.14, index === 3 ? coat : skin);
  const head = joint(root, "Head", [0, headY, 0]);
  ball(head, [0, 0, 0], [broad ? 0.158 : 0.145, short ? 0.19 : 0.202, 0.149], skin);
  for (const side of [-1, 1]) ball(head, [side * 0.146, -0.008, -0.005], [0.025, 0.045, 0.029], skin);
  ball(head, [0, -0.01, 0.146], [0.024, 0.043, 0.042], skin);
  box(head, [0, -0.081, 0.138], [index === 5 ? 0.079 : 0.058, 0.012, 0.013], "#835b4b");
  if (![2, 8].includes(index)) {
    ball(head, [0, 0.115, -0.028], [0.151, 0.119, 0.156], hair, "Hair");
    if ([4, 7].includes(index))
      for (const side of [-1, 0, 1])
        ball(head, [side * 0.09, 0.15 + (side === 0 ? 0.014 : 0), 0.06], [0.062, 0.081, 0.076], hair, "HairWave");
    if (index === 5) {
      const sweep = ball(head, [0.035, 0.16, -0.018], [0.13, 0.065, 0.14], hair, "SweptHair");
      sweep.rotation.z = -0.22;
    }
  }
  if (index === 0)
    for (const side of [-1, 1]) {
      ball(head, [side * 0.127, -0.02, -0.077], [0.067, 0.25, 0.1], hair, "GoldenHair");
      for (let j = 0; j < 5; j++)
        ball(head, [side * 0.129, 0.02 - j * 0.059, 0.035], [0.037, 0.043, 0.034], j % 2 ? "#e3c17b" : hair, "Braid");
    }
  if (index === 6) ball(head, [0, -0.004, -0.09], [0.168, 0.13, 0.1], hair, "ShortHair");
  if ([1, 3, 4, 7].includes(index)) {
    ball(head, [0, -0.1, 0.077], [0.112, 0.081, 0.082], hair, "Beard");
    box(head, [0, -0.074, 0.152], [0.071, 0.014, 0.012], "#b88f77");
  }
  const glasses = [1, 2, 3, 6, 7].includes(index);
  for (const side of [-1, 1]) {
    if (!glasses || index !== 2) ball(head, [side * 0.062, 0.036, 0.134], [0.014, 0.014, 0.01], "#302e28");
    if (glasses) {
      if (index === 2) ball(head, [side * 0.069, 0.042, 0.15], [0.056, 0.037, 0.012], "#252d31", "RimlessSunglasses");
      else if (index === 7 || index === 1) {
        for (const y of [0.012, 0.077]) box(head, [side * 0.069, y, 0.154], [0.098, 0.011, 0.014], "#514b3e");
        for (const dx of [-0.045, 0.045]) box(head, [side * 0.069 + dx, 0.044, 0.154], [0.01, 0.062, 0.014], "#514b3e");
      } else
        add(
          head,
          geometry("glasses", () => new TorusGeometry(0.048, 0.006, 4, 14)),
          [side * 0.066, 0.042, 0.152],
          [1, 1, 1],
          "#665d4b",
          "RoundGlasses",
        );
    }
  }
  if (glasses) box(head, [0, 0.045, 0.165], [0.043, 0.01, 0.012], "#817664");
  if (index === 8) {
    box(head, [-0.063, 0.036, 0.15], [0.085, 0.069, 0.024], "#1b2022", "EyePatch");
    const strap = box(head, [0, 0.07, 0.13], [0.295, 0.019, 0.018], "#272d2e", "PatchStrap");
    strap.rotation.z = -0.16;
    tube(torso, [0, torsoHeight + 0.018, 0], 0.12, 0.11, coat);
  }
  if (index === 1) {
    ball(head, [0, 0.182, -0.025], [0.162, 0.075, 0.16], "#303a34", "Cap");
    box(head, [0, 0.167, 0.137], [0.237, 0.022, 0.165], "#303a34", "CapBrim");
  }
  if (index === 6) {
    box(torso, [0, 0.22, 0.2], [0.21, 0.13, 0.09], "#323b3d", "Camera");
    const lens = tube(torso, [0.025, 0.22, 0.27], 0.051, 0.06, "#829294");
    lens.rotation.x = Math.PI / 2;
    box(torso, [0, 0.4, 0.164], [0.025, 0.25, 0.018], "#343937");
    const hand = root.getObjectByName("LeftForearm") as Group;
    box(hand, [-0.018, -0.26, 0.045], [0.19, 0.25, 0.041], "#d3c7a7", "Notebook");
  }
  return root;
}
