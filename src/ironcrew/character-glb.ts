/** Validate before invoking any GLTF loader. The supported format deliberately
 * excludes textures, extensions and references which could start extra fetches. */
export function validateCharacterGlb(buffer: ArrayBuffer): void {
  if (buffer.byteLength < 28 || buffer.byteLength > 5 * 1024 * 1024)
    throw new Error("GLB muss zwischen 28 Byte und 5 MiB groß sein.");
  const view = new DataView(buffer);
  if (
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== buffer.byteLength
  )
    throw new Error("Ungültige GLB-2-Datei.");
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || length > 1024 * 1024 || length + 20 > buffer.byteLength)
    throw new Error("GLB enthält keine gültige Szenenbeschreibung.");
  const parsed: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length)).trim());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Ungültige GLB-Szene.");
  const json = parsed as Record<string, unknown>;
  const entries = (key: string, max: number): unknown[] => {
    const list = json[key] ?? [];
    if (!Array.isArray(list) || list.length > max) throw new Error(`GLB überschreitet das Limit für ${key}.`);
    return list;
  };
  const nodes = entries("nodes", 256);
  const finished = new Set<number>();
  const path = new Set<number>();
  const visit = (index: number, depth: number) => {
    if (depth > 64 || path.has(index)) throw new Error("GLB enthält eine zyklische oder zu tiefe Szenenhierarchie.");
    if (finished.has(index)) return;
    const node = nodes[index];
    if (!node || typeof node !== "object") throw new Error("Ungültiger GLB-Knoten.");
    const children = (node as Record<string, unknown>).children ?? [];
    if (!Array.isArray(children) || children.length > 64) throw new Error("Zu viele GLB-Unterknoten.");
    path.add(index);
    for (const child of children) {
      if (!Number.isSafeInteger(child) || child < 0 || child >= nodes.length)
        throw new Error("Ungültiger GLB-Knotenverweis.");
      visit(child, depth + 1);
    }
    path.delete(index);
    finished.add(index);
  };
  nodes.forEach((_node, index) => visit(index, 0));
  entries("meshes", 64);
  entries("materials", 64);
  entries("animations", 32);
  entries("skins", 32);
  entries("images", 0);
  entries("textures", 0);
  entries("extensionsUsed", 0);
  entries("extensionsRequired", 0);
  let count = 0;
  for (const accessor of entries("accessors", 512)) {
    if (!accessor || typeof accessor !== "object") throw new Error("Ungültiger GLB-Accessor.");
    const value = (accessor as Record<string, unknown>).count;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new Error("Ungültige GLB-Geometriedaten.");
    count += value;
  }
  if (count > 1_000_000) throw new Error("GLB enthält zu viele Geometrieelemente.");
  const pending: unknown[] = [json];
  let visited = 0;
  while (pending.length) {
    if (++visited > 50_000) throw new Error("GLB-Struktur ist zu komplex.");
    const item = pending.pop();
    if (!item || typeof item !== "object") continue;
    for (const [key, value] of Object.entries(item)) {
      if (key === "uri" || key === "extensions")
        throw new Error(
          "Nur eingebettete GLB-Geometrie ohne Texturen, Erweiterungen oder externe Dateien wird unterstützt.",
        );
      if (value && typeof value === "object") pending.push(value);
    }
  }
}
