/** Original IronCrew character archetypes. Visual identity never grants skills or permissions. */
export const CHARACTER_SKINS = [
  {
    id: "navigator",
    name: "Navigator",
    description: "Navigatorin mit geflochtenem Haar, türkisfarbener Tunika und Tablet.",
  },
  { id: "engineer", name: "Ingenieur", description: "Techniker mit Irokesenschnitt, Bart und Werkzeuggürtel." },
  { id: "sentinel", name: "Wächter", description: "Bärtiger Wächter mit breiter Schutzrüstung und Schild." },
  { id: "diplomat", name: "Diplomatin", description: "Langes bernsteinfarbenes Kleid und offene lange Haare." },
  { id: "analyst", name: "Analyst", description: "Analyst mit Brille, Weste und Tablet im Rollstuhl." },
  { id: "medic", name: "Medizinerin", description: "Weißer Kittel, hochgestecktes Haar und medizinischer Koffer." },
  { id: "pilot", name: "Pilotin", description: "Fluganzug mit Schultergurten und kompakter Ausrüstung." },
  { id: "ranger", name: "Kundschafter", description: "Leichte Reiseausrüstung mit asymmetrischem Umhang." },
  { id: "archivist", name: "Archivar", description: "Graues zurückgekämmtes Haar, Weste, Gehstock und Buch." },
  { id: "artisan", name: "Gestalterin", description: "Afrofrisur, Arbeitsschürze und Pinsel mit Farbakzenten." },
  { id: "strategist", name: "Stratege", description: "Bärtiger Stratege mit Glatze, Maßanzug und Aktentasche." },
  { id: "courier", name: "Kurier", description: "Bewegliche Silhouette mit kompakter Umhängetasche." },
  { id: "diver", name: "Taucher", description: "Druckanzug mit rundem Helm und maritimen Details." },
  { id: "mechanic", name: "Mechaniker", description: "Afrofrisur, Bart, robuster Overall und Schraubenschlüssel." },
  { id: "botanist", name: "Botanikerin", description: "Feldkleidung mit grünen Akzenten und Pflanzentasche." },
  { id: "android", name: "Androide", description: "Glatte synthetische Figur mit sichtbaren Gelenken." },
  { id: "automaton", name: "Automat", description: "Eigenständiger kompakter Roboter mit mechanischem Körper." },
  { id: "visitor", name: "Besucher", description: "Fremdartige Figur mit langem Kopf und eigener Anatomie." },
  { id: "cephalid", name: "Cephalid", description: "Nichtmenschliche Figur mit Tentakelsilhouette." },
  { id: "crystalline", name: "Kristallwesen", description: "Facettierter Körper aus klaren geometrischen Formen." },
] as const;
export type CharacterSkinId = (typeof CHARACTER_SKINS)[number]["id"];
export const CHARACTER_SKIN_IDS = CHARACTER_SKINS.map((skin) => skin.id);
