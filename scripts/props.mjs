/**
 * Prop presets: save a canvas selection (tiles + walls + lights) as a reusable
 * preset, and re-instantiate it later with arbitrary position/rotation.
 *
 * A preset is a JSON file under <propsRoot>/<category>/<name>.json. All
 * geometry is stored relative to the selection's top-left corner, in pixels
 * at the authoring grid size, so it can be rescaled to any target grid.
 */

const MODULE_ID = "paradigma-map-generator";

export const PROP_CATEGORIES = ["stairs", "stairs_down", "arena", "building", "decor", "trap", "misc"];

function getFilePicker() {
  return foundry.applications?.apps?.FilePicker?.implementation
    ?? foundry.applications?.apps?.FilePicker
    ?? globalThis.FilePicker;
}

function normalizePath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Visual top-left of a tile document, accounting for the v14 texture anchor. */
function tileTopLeft(doc) {
  const ax = Number(doc.texture?.anchorX ?? 0);
  const ay = Number(doc.texture?.anchorY ?? 0);
  return { left: doc.x - ax * doc.width, top: doc.y - ay * doc.height };
}

/**
 * Build a preset object from the current canvas selection.
 * Returns null if nothing suitable is selected.
 */
export function serializeSelection() {
  const scene = canvas?.scene;
  if (!scene) return null;
  const grid = scene.grid.size;
  const tiles = Array.from(canvas.tiles?.controlled ?? []).map((t) => t.document);
  const walls = Array.from(canvas.walls?.controlled ?? []).map((w) => w.document);
  const lights = Array.from(canvas.lighting?.controlled ?? []).map((l) => l.document);
  if (!tiles.length && !walls.length) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const acc = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const d of tiles) {
    const { left, top } = tileTopLeft(d);
    acc(left, top);
    acc(left + d.width, top + d.height);
  }
  for (const d of walls) { acc(d.c[0], d.c[1]); acc(d.c[2], d.c[3]); }
  for (const d of lights) acc(d.x, d.y);

  const preset = {
    format: 1,
    cellsW: Math.max(1, Math.round((maxX - minX) / grid)),
    cellsH: Math.max(1, Math.round((maxY - minY) / grid)),
    gridSize: grid,
    tiles: tiles.map((d) => {
      const { left, top } = tileTopLeft(d);
      const fa = d.flags?.["fa-nexus"] ?? null;
      return {
        src: d.texture.src,
        x: Math.round(left - minX),
        y: Math.round(top - minY),
        width: Math.round(d.width),
        height: Math.round(d.height),
        rotation: d.rotation || 0,
        scaleX: d.texture.scaleX ?? 1,
        scaleY: d.texture.scaleY ?? 1,
        tint: d.texture.tint ?? null,
        alpha: d.alpha ?? 1,
        // Layer order comes from the FA Nexus elevation you set per tile
        // (Alt+scroll on placement); sort is the tie-break within an elevation.
        elevation: d.elevation ?? 0,
        sort: d.sort ?? 0,
        hidden: !!d.hidden,
        faShadow: fa ? { ...fa } : null
      };
    }),
    walls: walls.map((d) => ({
      c: [
        Math.round(d.c[0] - minX), Math.round(d.c[1] - minY),
        Math.round(d.c[2] - minX), Math.round(d.c[3] - minY)
      ],
      door: d.door ?? 0,
      ds: d.ds ?? 0,
      sight: d.sight,
      move: d.move
    })),
    lights: lights.map((d) => ({
      x: Math.round(d.x - minX),
      y: Math.round(d.y - minY),
      config: foundry.utils.deepClone(d.config ?? {})
    }))
  };
  return preset;
}

/** Save a preset object to <propsRoot>/<category>/<name>.json. */
export async function savePreset(preset, category, name) {
  const propsRoot = normalizePath(game.settings.get(MODULE_ID, "propsRoot") || "paradigma-props");
  const cat = normalizePath(category) || "misc";
  const slug = String(name || "preset").trim().replace(/[^\w\-]+/g, "_") || "preset";
  const dir = `${propsRoot}/${cat}`;
  const FP = getFilePicker();

  // Ensure the folder chain exists
  let chain = "";
  for (const part of dir.split("/")) {
    chain = chain ? `${chain}/${part}` : part;
    try {
      await FP.createDirectory("data", chain);
    } catch (error) {
      if (!/EEXIST|already exists/i.test(String(error?.message ?? error))) throw error;
    }
  }

  const withMeta = { ...preset, name: slug, category: cat };
  const blob = new Blob([JSON.stringify(withMeta, null, 2)], { type: "application/json" });
  const file = new File([blob], `${slug}.json`, { type: "application/json" });
  const result = await FP.upload("data", dir, file, {}, { notify: false });
  return result?.path ?? `${dir}/${slug}.json`;
}

/** Paths the user has disabled (Foundry can't delete files via API). */
export function getDisabledPresets() {
  try {
    return new Set(game.settings.get(MODULE_ID, "disabledPresets") ?? []);
  } catch (_) {
    return new Set();
  }
}

/**
 * List saved presets grouped by category: { category: [{name, path}] }.
 * Disabled presets are excluded.
 */
export async function listPresets() {
  const propsRoot = normalizePath(game.settings.get(MODULE_ID, "propsRoot") || "paradigma-props");
  const FP = getFilePicker();
  const disabled = getDisabledPresets();
  const out = {};
  let root;
  try {
    root = await FP.browse("data", propsRoot);
  } catch (_) {
    return out;
  }
  for (const dir of root.dirs || []) {
    const category = dir.slice(dir.lastIndexOf("/") + 1);
    let listing;
    try {
      listing = await FP.browse("data", dir);
    } catch (_) {
      continue;
    }
    for (const file of listing.files || []) {
      if (!file.toLowerCase().endsWith(".json")) continue;
      const path = normalizePath(file);
      if (disabled.has(path)) continue;
      const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/i, "");
      (out[category] ??= []).push({ name, path });
    }
  }
  return out;
}

/**
 * "Delete" a preset. Foundry has no file-delete API, so we add the path to a
 * disabled list — the generator and picker then ignore it (file stays on disk;
 * can be removed manually from the props folder).
 */
export async function deletePreset(path) {
  const disabled = getDisabledPresets();
  disabled.add(normalizePath(path));
  await game.settings.set(MODULE_ID, "disabledPresets", [...disabled]);
  return true;
}

/** Fetch and parse a preset JSON by data-relative path. */
export async function loadPreset(path) {
  try {
    const url = path.startsWith("/") ? path : `/${path}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    return data?.tiles || data?.walls ? data : null;
  } catch (error) {
    console.warn(`${MODULE_ID} | Failed to load preset ${path}`, error);
    return null;
  }
}
