/** Repository-authored anatomical crew figures, revision 3. Locally adapted CC0 anatomy, no runtime network or model calls. */
import {
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
} from "three";
import { createHeadGeometry, createHairGeometry, projectHairPoints } from "./CrewAnatomy.ts";
import { surface, strand, packCrewMeshes, type Point, type Section } from "./CrewGeometry.ts";
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
export function createCrewModel(index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= crewKeys.length) throw new Error("unknown_crew_model");
  const root = new Group();
  root.name = crewNames[index]!;
  root.userData = {
    provenance: "IronCrew authored character with CC0 MakeHuman head topology",
    revision: 3,
    seedKey: crewKeys[index],
    features: crewFeatures[index],
  };
  const female = index === 0 || index === 6,
    short = index === 4,
    broad = index === 2 || index === 8;
  const coat = ["#602738", "#535c4b", "#24292d", "#252a2d", "#71313d", "#344665", "#923c37", "#a3aea8", "#252c30"][
    index
  ]!;
  const skin = ["#d8ae95", "#b99074", "#775039", "#bfa188", "#bb9275", "#c7a186", "#d5ad97", "#bc9a82", "#74503b"][
    index
  ]!;
  const hair = ["#a68245", "#55463a", "#302b25", "#68695f", "#654833", "#4b382c", "#352c28", "#352c25", "#302d28"][
    index
  ]!;
  const materials = new Map<string, MeshStandardMaterial>();
  function material(color: string, finish = "cloth") {
    const key = color + finish;
    if (!materials.has(key))
      materials.set(
        key,
        new MeshStandardMaterial({
          color,
          roughness:
            finish === "metal"
              ? 0.31
              : finish === "eye"
                ? 0.22
                : finish === "leather"
                  ? 0.43
                  : finish === "skin"
                    ? 0.6
                    : 0.88,
          metalness: finish === "metal" ? 0.72 : 0,
        }),
      );
    return materials.get(key)!;
  }
  function add(
    parent: Group,
    geometry: BufferGeometry,
    p: Point,
    scale: Point,
    color: string,
    name = "",
    finish = "cloth",
  ) {
    const mesh = new Mesh(geometry, material(color, finish));
    mesh.position.set(...p);
    mesh.scale.set(...scale);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  const sphere = new SphereGeometry(1, 16, 12),
    detailSphere = new SphereGeometry(1, 12, 8),
    irisSphere = new SphereGeometry(1, 8, 6),
    boxGeo = new BoxGeometry(1, 1, 1);
  const ball = (parent: Group, p: Point, scale: Point, color: string, name = "", finish = "cloth") =>
    add(parent, name === "Iris" || name === "Pupil" ? irisSphere : detailSphere, p, scale, color, name, finish);
  const box = (parent: Group, p: Point, scale: Point, color: string, name = "", finish = "cloth") =>
    add(parent, boxGeo, p, scale, color, name, finish);
  const curve = (
    parent: Group,
    points: Point[],
    radius: number,
    color: string,
    name = "",
    finish = "cloth",
    steps = 10,
  ) => add(parent, strand(points, radius, steps), [0, 0, 0], [1, 1, 1], color, name, finish);
  const shell = (parent: Group, sections: Section[], color: string, name = "", finish = "cloth", segments = 24) =>
    add(parent, surface(sections, segments), [0, 0, 0], [1, 1, 1], color, name, finish);
  const joint = (parent: Group, name: string, p: Point) => {
    const group = new Group();
    group.name = name;
    group.position.set(...p);
    parent.add(group);
    return group;
  };
  const hip = short ? 0.51 : 0.86,
    shoulder = short ? 1.01 : 1.47,
    height = shoulder - hip;
  const width = broad ? 0.235 : female ? 0.19 : 0.211;
  const torso = joint(root, "Torso", [0, hip, 0]);
  const leather = [2, 8].includes(index) ? "leather" : "cloth";
  shell(
    torso,
    [
      [-0.055, 0.13, 0.1],
      [0, 0.17, 0.12],
      [height * 0.18, width * 0.8, 0.12],
      [height * 0.38, width * 0.76, 0.113],
      [height * 0.65, width * 0.91, 0.133],
      [height * 0.84, width, 0.12],
      [height * 0.94, width, 0.1],
      [height + 0.015, 0.085, 0.07],
      [height + 0.025, 0.065, 0.059],
    ],
    coat,
    "TailoredTorso",
    leather,
  );
  const trousers = index === 3 ? "#40576d" : index === 4 ? "#3d342f" : "#303537";
  for (const side of [-1, 1]) {
    const leg = joint(root, side < 0 ? "LeftLeg" : "RightLeg", [side * 0.098, hip - 0.025, 0]);
    const length = (hip - 0.13) / 2;
    shell(
      leg,
      [
        [-length - 0.025, 0.064, 0.065],
        [-length * 0.85, 0.065, 0.072],
        [-length * 0.5, 0.078, 0.083],
        [-0.07, 0.09, 0.09],
        [0.025, 0.075, 0.08],
      ],
      trousers,
      "TrouserThigh",
      "cloth",
      16,
    );
    const knee = joint(leg, side < 0 ? "LeftKnee" : "RightKnee", [0, -length, 0]);
    shell(
      knee,
      [
        [-length, 0.051, 0.058],
        [-length * 0.8, 0.055, 0.064],
        [-length * 0.47, 0.068, 0.075],
        [-0.05, 0.068, 0.07],
        [0.02, 0.065, 0.067],
      ],
      trousers,
      "TrouserCalf",
      "cloth",
      16,
    );
    curve(
      knee,
      [
        [0, -0.03, 0.071],
        [0, -length * 0.5, 0.076],
        [0.002, -length + 0.02, 0.06],
      ],
      0.002,
      index === 3 ? "#688197" : "#44494a",
      "TrouserSeam",
      "cloth",
      6,
    );
    const foot = ball(
      knee,
      [0, -length - 0.017, 0.035],
      [0.071, 0.055, 0.137],
      index === 3 ? "#b8b5a9" : "#272a2b",
      "Shoe",
      "leather",
    );
    foot.rotation.x = -0.05;
    ball(knee, [0, -length - 0.049, 0.038], [0.074, 0.018, 0.14], "#393c3b", "Sole");
    if (index === 3)
      for (let j = 0; j < 3; j++)
        curve(
          knee,
          [
            [-0.04, -length + 0.022, 0.025 + j * 0.021],
            [0, -length + 0.03, 0.03 + j * 0.021],
            [0.04, -length + 0.022, 0.025 + j * 0.021],
          ],
          0.003,
          "#d4d2c8",
          "Laces",
          "cloth",
          3,
        );
    const arm = joint(torso, side < 0 ? "LeftArm" : "RightArm", [side * (width - 0.005), height - 0.05, 0]);
    const upper = short ? 0.22 : 0.29,
      lower = short ? 0.19 : 0.255,
      sleeve = broad ? 0.082 : female ? 0.062 : 0.071;
    shell(
      arm,
      [
        [-upper - 0.012, sleeve * 0.77, sleeve * 0.8],
        [-upper * 0.75, sleeve * 0.89, sleeve * 0.92],
        [-upper * 0.3, sleeve, sleeve],
        [0.008, sleeve * 0.91, sleeve * 0.91],
        [0.045, sleeve * 0.58, sleeve * 0.65],
        [0.057, 0.002, 0.002],
      ],
      coat,
      "TailoredSleeve",
      leather,
      16,
    );
    const elbow = joint(arm, side < 0 ? "LeftForearm" : "RightForearm", [0, -upper, 0]);
    shell(
      elbow,
      [
        [-lower, 0.041, 0.043],
        [-lower * 0.7, 0.047, 0.052],
        [-lower * 0.28, 0.058, 0.059],
        [0.025, sleeve * 0.79, sleeve * 0.79],
      ],
      index === 7 ? skin : coat,
      "Forearm",
      index === 7 ? "skin" : leather,
      16,
    );
    shell(
      elbow,
      [
        [-lower - 0.005, 0.043, 0.044],
        [-lower + 0.027, 0.045, 0.046],
      ],
      index === 7 ? skin : index === 5 ? "#d5d0c2" : coat,
      "Cuff",
      index === 7 ? "skin" : leather,
      16,
    );
    if (index === 7)
      shell(
        elbow,
        [
          [-0.054, 0.06, 0.065],
          [-0.014, 0.064, 0.065],
          [0.022, 0.059, 0.062],
        ],
        "#c0c7bf",
        "RolledCuff",
        "cloth",
        16,
      );
    const hand = joint(elbow, side < 0 ? "LeftHand" : "RightHand", [0, -lower - 0.043, 0.008]);
    add(hand, detailSphere, [0, 0, 0], [0.039, 0.054, 0.023], skin, "Palm", "skin");
    for (let finger = 0; finger < 4; finger++) {
      const x = (finger - 1.5) * 0.017,
        length = [0.052, 0.065, 0.061, 0.046][finger]!;
      curve(
        hand,
        [
          [x, -0.027, 0.002],
          [x, -0.057, 0.007],
          [x + side * 0.003, -0.037 - length, 0.022],
        ],
        0.008,
        skin,
        "Finger",
        "skin",
        5,
      );
    }
    curve(
      hand,
      [
        [side * 0.026, 0.02, 0.003],
        [side * 0.047, -0.014, 0.013],
        [side * 0.038, -0.038, 0.029],
      ],
      0.011,
      skin,
      "Thumb",
      "skin",
      5,
    );
  }
  if ([0, 2, 8].includes(index)) {
    const bottom = index === 0 ? 0.1 : 0.36;
    shell(
      root,
      [
        [bottom, width * 1.12, 0.175, -0.015],
        [bottom + 0.05, width * 1.14, 0.179, -0.015],
        [hip - 0.27, width * 0.97, 0.15, -0.01],
        [hip - 0.08, width * 0.83, 0.122],
        [hip + 0.08, width * 0.8, 0.116],
      ],
      coat,
      index === 0 ? "DrapedDress" : "CoatSkirt",
      leather,
      32,
    );
    for (const side of [-1, 1])
      curve(
        root,
        [
          [side * width * 0.63, bottom + 0.03, 0.136],
          [side * width * 0.58, hip - 0.24, 0.128],
          [side * 0.105, hip + 0.035, 0.115],
        ],
        0.003,
        index === 0 ? "#7c3b48" : "#3b4347",
        "GarmentFold",
        leather,
        8,
      );
  }
  const front = 0.132;
  if ([1, 2, 5, 6, 7, 8].includes(index)) {
    shell(
      torso,
      [
        [0.09, 0.045, 0.018, front - 0.009],
        [height * 0.55, 0.067, 0.015, front - 0.007],
        [height * 0.9, 0.071, 0.014, front - 0.017],
        [height, 0.047, 0.013, 0.086],
      ],
      index === 1 ? "#a29c88" : index === 7 ? "#aab6b0" : [2, 8].includes(index) ? "#343a3b" : "#d7d1c2",
      "ShirtFront",
      "cloth",
      12,
    );
    if (index !== 7)
      for (const side of [-1, 1]) {
        const lapel = box(
          torso,
          [side * 0.083, height * 0.68, 0.131],
          [0.06, height * 0.5, 0.013],
          coat,
          "Lapel",
          leather,
        );
        lapel.rotation.z = -side * 0.26;
        lapel.rotation.x = -0.06;
        curve(
          torso,
          [
            [side * 0.035, height * 0.43, 0.15],
            [side * 0.12, height * 0.77, 0.139],
            [side * 0.075, height * 0.95, 0.113],
          ],
          0.003,
          [2, 8].includes(index) ? "#4b5356" : coat,
          "LapelSeam",
          leather,
          5,
        );
      }
  }
  if ([0, 4].includes(index)) {
    shell(
      torso,
      [
        [0.064, width * 0.79, 0.125],
        [0.091, width * 0.8, 0.125],
      ],
      "#987646",
      "Belt",
      "metal",
      24,
    );
    for (let y = 0.15; y < height - 0.05; y += 0.075)
      ball(torso, [0.026, y, 0.14], [0.01, 0.01, 0.008], "#b59a66", "Button", "metal");
  }
  if (index === 1)
    for (const side of [-1, 1]) {
      const pocket = box(torso, [side * 0.12, height * 0.44, 0.134], [0.086, 0.1, 0.008], "#646c58", "JacketPocket");
      pocket.rotation.z = side * 0.06;
    }
  if (index === 5) {
    shell(
      torso,
      [
        [height * 0.29, 0.019, 0.008, 0.153],
        [height * 0.35, 0.03, 0.008, 0.155],
        [height * 0.76, 0.016, 0.008, 0.142],
        [height * 0.83, 0.024, 0.01, 0.14],
        [height * 0.88, 0.012, 0.01, 0.13],
      ],
      "#a37851",
      "Tie",
      "cloth",
      8,
    );
    for (let j = 0; j < 4; j++) {
      const stripe = box(torso, [0, height * 0.39 + j * 0.055, 0.166], [0.033, 0.008, 0.004], "#627c7e");
      stripe.rotation.z = -0.35;
    }
    const square = box(torso, [-0.123, height * 0.62, 0.15], [0.058, 0.028, 0.007], "#c3b39e", "PocketSquare");
    square.rotation.z = -0.12;
  }
  const neck = shell(
    torso,
    [
      [height - 0.01, 0.061, 0.058],
      [height + 0.1, 0.049, 0.051],
    ],
    index === 3 ? coat : skin,
    "Neck",
    index === 3 ? "cloth" : "skin",
    20,
  );
  if (index === 3) neck.scale.x = 1.1;
  const head = joint(root, "Head", [0, shoulder + 0.18, 0]);
  const face = new Mesh(
    createHeadGeometry(index, skin),
    new MeshStandardMaterial({ color: "#ffffff", vertexColors: true, roughness: 0.65 }),
  );
  face.name = "AnatomicalFace";
  face.castShadow = true;
  head.add(face);
  const glasses = [1, 2, 3, 6, 7].includes(index);
  for (const side of [-1, 1]) {
    const x = side * 0.034;
    if (index !== 2 && !(index === 8 && side < 0)) {
      ball(head, [x, 0.0144, 0.0688], [0.0145, 0.0145, 0.0145], "#c1bdb0", "EyeSclera", "eye");
      ball(
        head,
        [x, 0.0144, 0.082],
        [0.0064, 0.0064, 0.003],
        index === 0 ? "#597665" : index === 6 ? "#6b786c" : "#4c4436",
        "Iris",
        "eye",
      );
      ball(head, [x, 0.0144, 0.084], [0.0028, 0.0038, 0.0015], "#282b2a", "Pupil", "eye");
      curve(
        head,
        [
          [x - side * 0.02, 0.037, 0.087],
          [x, 0.04, 0.089],
          [x + side * 0.022, 0.035, 0.079],
        ],
        female ? 0.0026 : 0.004,
        hair,
        "Eyebrow",
        "cloth",
        7,
      );
    }
    if (glasses) {
      if (index === 2)
        ball(head, [side * 0.037, 0.02, 0.091], [0.027, 0.016, 0.006], "#293237", "RimlessSunglasses", "eye");
      else if ([1, 7].includes(index))
        curve(
          head,
          [
            [x - 0.023, 0.033, 0.088],
            [x + 0.023, 0.033, 0.087],
            [x + 0.023, -0.002, 0.087],
            [x - 0.023, -0.002, 0.087],
            [x - 0.023, 0.033, 0.088],
          ],
          0.0026,
          "#4d4c43",
          "AngularGlasses",
          "metal",
          12,
        );
      else
        add(
          head,
          new TorusGeometry(0.023, 0.0022, 5, 20),
          [x, 0.016, 0.089],
          [1, 0.88, 1],
          "#797365",
          "RoundGlasses",
          "metal",
        );
      curve(
        head,
        [
          [side * 0.059, 0.02, 0.088],
          [side * 0.084, 0.022, 0.044],
          [side * 0.085, 0.008, -0.003],
        ],
        0.0024,
        "#797365",
        "GlassesTemple",
        "metal",
        6,
      );
    }
  }
  if (glasses)
    curve(
      head,
      [
        [-0.011, 0.024, 0.08],
        [0, 0.03, 0.085],
        [0.011, 0.024, 0.08],
      ],
      0.0022,
      "#797365",
      "GlassesBridge",
      "metal",
      6,
    );
  if (![2, 8].includes(index)) {
    const hairGeometry = createHairGeometry(face.geometry, index);
    add(head, hairGeometry, [0, 0, 0], [1, 1, 1], hair, "Hair");
    const highlight = new Color(hair).lerp(new Color("#d3c4a3"), 0.2).getStyle();
    for (let j = 0; j < 6; j++) {
      const theta = (j / 6) * Math.PI * 2;
      const points: Point[] = Array.from({ length: 5 }, (_, k) => {
        const phi = 0.22 + k * 0.24;
        return [
          Math.sin(theta + k * 0.1) * 0.092 * Math.sin(phi) + (index === 5 ? 0.017 * Math.sin(phi) : 0),
          0.009 + Math.cos(phi) * 0.141,
          -0.012 + Math.cos(theta + k * 0.1) * 0.106 * Math.sin(phi),
        ];
      });
      curve(head, projectHairPoints(face.geometry, points), 0.0012, highlight, "HairStrand", "cloth", 8);
    }
  }
  if (index === 0)
    for (const side of [-1, 1]) {
      curve(
        head,
        [
          [side * 0.055, 0.11, -0.018],
          [side * 0.087, 0.035, -0.035],
          [side * 0.09, -0.068, -0.034],
          [side * 0.075, -0.17, -0.015],
        ],
        0.026,
        hair,
        "GoldenHair",
        "cloth",
        12,
      );
      for (let j = 0; j < 2; j++)
        curve(
          head,
          Array.from(
            { length: 15 },
            (_, k): Point => [
              side * (0.079 + Math.sin(k * 1.7 + j * Math.PI) * 0.008),
              0.042 - k * 0.014,
              0.005 + Math.cos(k * 1.7 + j * Math.PI) * 0.008,
            ],
          ),
          0.007,
          j ? "#bf9b55" : hair,
          "Braid",
          "cloth",
          16,
        );
    }
  if (index === 8) {
    ball(head, [-0.035, 0.016, 0.098], [0.027, 0.021, 0.009], "#272e30", "EyePatch", "leather");
    curve(
      head,
      [
        [-0.074, 0.043, 0.033],
        [-0.04, 0.033, 0.1],
        [0.01, 0.053, 0.09],
        [0.078, 0.079, 0.011],
      ],
      0.004,
      "#383e40",
      "PatchStrap",
      "leather",
      12,
    );
    shell(
      torso,
      [
        [height - 0.017, 0.079, 0.074],
        [height + 0.05, 0.076, 0.073],
      ],
      coat,
      "RaisedCollar",
      "leather",
      20,
    );
  }
  if (index === 1) {
    add(head, sphere, [0, 0.112, -0.014], [0.094, 0.047, 0.087], "#343e35", "Cap");
    ball(head, [0, 0.106, 0.074], [0.092, 0.008, 0.065], "#343e35", "CapBrim");
  }
  if (index === 6) {
    box(torso, [0, 0.19, 0.18], [0.135, 0.085, 0.055], "#323b3c", "Camera", "leather");
    const lens = ball(torso, [0.022, 0.19, 0.218], [0.028, 0.028, 0.028], "#45545b", "CameraLens", "eye");
    lens.scale.z = 0.65;
    for (const side of [-1, 1])
      curve(
        torso,
        [
          [side * 0.043, height * 0.89, 0.1],
          [side * 0.068, 0.36, 0.146],
          [side * 0.05, 0.215, 0.192],
        ],
        0.004,
        "#3c4040",
        "CameraStrap",
        "leather",
        8,
      );
    const hand = root.getObjectByName("LeftHand") as Group;
    box(hand, [-0.03, -0.012, 0.027], [0.11, 0.15, 0.018], "#8e6f50", "Notebook", "leather");
    box(hand, [-0.03, -0.012, 0.038], [0.097, 0.14, 0.005], "#cfc6ac", "NotebookPages");
  }
  for (const side of [-1, 1]) {
    root.getObjectByName(side < 0 ? "LeftArm" : "RightArm")!.rotation.z = -side * 0.06;
  }
  packCrewMeshes(root);
  return root;
}
