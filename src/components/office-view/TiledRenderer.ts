import { Assets, Container, Sprite, Texture, Rectangle } from "pixi.js";

export interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: TiledLayer[];
  tilesets: TiledTileset[];
}

export interface TiledLayer {
  name: string;
  type: "tilelayer" | "objectgroup";
  data?: number[];
  objects?: TiledObject[];
  visible: boolean;
  opacity: number;
}

export interface TiledObject {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  point?: boolean;
  properties?: Array<{ name: string; type: string; value: string | number | boolean }>;
}

export interface TiledTileset {
  firstgid: number;
  source: string;
  columns?: number;
  tilecount?: number;
  image?: string;
}

/** Maps tileset source names to actual image paths */
export interface TilesetImageMap {
  [tilesetSource: string]: string;
}

interface LoadedTileset {
  firstgid: number;
  lastgid: number; // exclusive upper bound (firstgid of next tileset, or Infinity)
  textures: Texture[];
}

export async function loadTiledMap(jsonPath: string, tilesetImages: TilesetImageMap) {
  const response = await fetch(jsonPath);
  const mapData: TiledMap = await response.json();

  const container = new Container();
  const tileWidth = mapData.tilewidth;
  const tileHeight = mapData.tileheight;

  // Sort tilesets by firstgid ascending
  const sortedTilesets = [...mapData.tilesets].sort((a, b) => a.firstgid - b.firstgid);

  // Load each tileset and create tile textures
  const loadedTilesets: LoadedTileset[] = [];

  for (let i = 0; i < sortedTilesets.length; i++) {
    const ts = sortedTilesets[i];
    const nextFirstGid = i + 1 < sortedTilesets.length ? sortedTilesets[i + 1].firstgid : Infinity;

    const basename = ts.source.replace(/^.*[/\\]/, "");
    const imagePath = tilesetImages[ts.source] ?? tilesetImages[basename];
    if (!imagePath) {
      // Skip tilesets without a mapped image
      loadedTilesets.push({
        firstgid: ts.firstgid,
        lastgid: nextFirstGid,
        textures: [],
      });
      continue;
    }

    const baseTexture = await Assets.load(imagePath);
    const cols = Math.floor(baseTexture.width / tileWidth);
    const rows = Math.floor(baseTexture.height / tileHeight);

    const textures: Texture[] = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const rect = new Rectangle(x * tileWidth, y * tileHeight, tileWidth, tileHeight);
        textures.push(
          new Texture({
            source: baseTexture.source,
            frame: rect,
          }),
        );
      }
    }

    loadedTilesets.push({
      firstgid: ts.firstgid,
      lastgid: nextFirstGid,
      textures,
    });
  }

  /** Resolve a Tiled GID to its texture */
  function getTexture(gid: number): Texture | undefined {
    for (let i = loadedTilesets.length - 1; i >= 0; i--) {
      const ts = loadedTilesets[i];
      if (gid >= ts.firstgid) {
        const localIndex = gid - ts.firstgid;
        return ts.textures[localIndex];
      }
    }
    return undefined;
  }

  const layersContainer = new Container();
  container.addChild(layersContainer);

  const objectGroups: Record<string, TiledObject[]> = {};

  mapData.layers.forEach((layer) => {
    if (layer.type === "tilelayer" && layer.data) {
      const layerCont = new Container();
      layerCont.label = layer.name;
      layerCont.alpha = layer.opacity;
      layerCont.visible = layer.visible;

      for (let i = 0; i < layer.data.length; i++) {
        const gid: number = layer.data[i];
        if (gid === 0) continue;

        const tex = getTexture(gid);
        if (tex) {
          const sprite = new Sprite(tex);
          sprite.x = (i % mapData.width) * tileWidth;
          sprite.y = Math.floor(i / mapData.width) * tileHeight;
          sprite.texture.source.scaleMode = "nearest";
          layerCont.addChild(sprite);
        }
      }
      layersContainer.addChild(layerCont);
    } else if (layer.type === "objectgroup" && layer.objects) {
      objectGroups[layer.name] = layer.objects;
    }
  });

  return {
    container,
    layersContainer,
    objectGroups,
    mapData,
    mapWidth: mapData.width * tileWidth,
    mapHeight: mapData.height * tileHeight,
  };
}
