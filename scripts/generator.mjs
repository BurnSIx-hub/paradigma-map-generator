/**
 * Scene generation core.
 *
 * Produces a real playable scene: ground tiles, procedural road, preset feature
 * (camp / ruins / tavern), scattered decorations, Foundry walls and lights.
 * Object tiles carry `flags.fa-nexus` shadow settings, so FA Nexus renders its
 * elevation drop shadows for them and they show up in its Layer Manager.
 */

import { Rng, makeSeed } from "./rng.mjs";
import { composeTags, LEGACY_PRESETS } from "./presets.mjs";
import { buildLibrary, getFilePicker } from "./scanner.mjs";
import { loadPreset } from "./props.mjs";

const MODULE_ID = "paradigma-map-generator";

// Occupancy bit masks
const OBJ = 1;
const ROAD = 2;
const RESERVED = 4;
const AVOID_MASKS = { object: OBJ, road: ROAD, reserved: RESERVED };

// Sort bands (painterly order inside one elevation)
const SORT_GROUND = 0;
const SORT_FEATURE_BG = 50;
const SORT_FLAT = 100;
const SORT_MID = 1000;
const SORT_TALL = 3000;
const SORT_OVERLAY = 6000;
const SORT_ROOF = 9000;

/**
 * FA Nexus shadow flags. Offset distance is in pixels; without an offset the
 * shadow hides under the asset itself and is effectively invisible.
 * Angle 135° casts down-left, matching the baked shadows in FA artwork.
 */
function makeFaShadow(distancePx) {
  const theta = 135 * Math.PI / 180;
  return {
    shadow: true,
    shadowAlpha: 0.55,
    shadowDilation: 1.6,
    shadowBlur: 2.2,
    shadowOffsetDistance: distancePx,
    shadowOffsetAngle: 135,
    shadowOffsetX: Math.round(Math.cos(theta) * distancePx * 100) / 100,
    shadowOffsetY: Math.round(Math.sin(theta) * distancePx * 100) / 100,
    shadowOnly: false
  };
}

function i18n(key, data) {
  const full = `${MODULE_ID}.${key}`;
  return data ? game.i18n.format(full, data) : game.i18n.localize(full);
}

class Occupancy {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.cells = new Uint8Array(w * h);
  }

  /** any cell of the rect has any of the mask bits */
  test(x, y, w, h, mask) {
    if (x < 0 || y < 0 || x + w > this.w || y + h > this.h) return true;
    for (let j = y; j < y + h; j++) {
      const row = j * this.w;
      for (let i = x; i < x + w; i++) if (this.cells[row + i] & mask) return true;
    }
    return false;
  }

  /** every cell of the rect has all of the mask bits (out of bounds = false) */
  contains(x, y, w, h, mask) {
    if (x < 0 || y < 0 || x + w > this.w || y + h > this.h) return false;
    for (let j = y; j < y + h; j++) {
      const row = j * this.w;
      for (let i = x; i < x + w; i++) if ((this.cells[row + i] & mask) !== mask) return false;
    }
    return true;
  }

  mark(x, y, w, h, mask) {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.w, x + w);
    const y1 = Math.min(this.h, y + h);
    for (let j = y0; j < y1; j++) {
      const row = j * this.w;
      for (let i = x0; i < x1; i++) this.cells[row + i] |= mask;
    }
  }

  markCircle(cx, cy, r, mask) {
    const x0 = Math.max(0, Math.floor(cx - r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(this.w - 1, Math.ceil(cx + r));
    const y1 = Math.min(this.h - 1, Math.ceil(cy + r));
    const r2 = r * r;
    for (let j = y0; j <= y1; j++) {
      const row = j * this.w;
      for (let i = x0; i <= x1; i++) {
        const dx = i + 0.5 - cx;
        const dy = j + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) this.cells[row + i] |= mask;
      }
    }
  }
}

async function loadTextureSize(src) {
  try {
    const fn = foundry.canvas?.loadTexture ?? globalThis.loadTexture;
    const tex = await fn(src);
    if (tex?.width && tex?.height) return { width: tex.width, height: tex.height };
  } catch (error) {
    console.warn(`${MODULE_ID} | Failed to load texture ${src}`, error);
  }
  return null;
}

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
  };
}

/** Sample a smooth polyline (cell coordinates) through the control points. */
function samplePath(points, step = 0.5) {
  const samples = [];
  const pts = [points[0], ...points, points[points.length - 1]];
  for (let i = 1; i < pts.length - 2; i++) {
    const segLen = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    const n = Math.max(2, Math.ceil(segLen / step));
    for (let k = 0; k < n; k++) samples.push(catmullRom(pts[i - 1], pts[i], pts[i + 1], pts[i + 2], k / n));
  }
  samples.push(points[points.length - 1]);
  return samples;
}

class GenerationContext {
  constructor({ rng, library, cellsW, cellsH, grid, gridDistance, shadowsEnabled }) {
    this.rng = rng;
    this.lib = library;
    this.cellsW = cellsW;
    this.cellsH = cellsH;
    this.grid = grid;
    this.gridDistance = gridDistance;
    this.shadowsEnabled = shadowsEnabled;
    this.occ = new Occupancy(cellsW, cellsH);
    this.tiles = [];
    this.walls = [];
    this.lights = [];
    this.sounds = [];
    this.missingBuckets = new Set();
  }

  pxW() { return this.cellsW * this.grid; }
  pxH() { return this.cellsH * this.grid; }

  /** feet for N grid cells (light radii) */
  feet(cells) { return cells * this.gridDistance; }

  moduleFlags(extra = {}) {
    return { generated: true, ...extra };
  }

  /** shadow: false | "mid" | "tall" — tall objects cast a longer shadow */
  buildFlags({ shadow = false } = {}) {
    const flags = { [MODULE_ID]: this.moduleFlags() };
    if (shadow && this.shadowsEnabled) {
      const distance = shadow === "tall" ? this.grid * 0.22 : this.grid * 0.11;
      flags["fa-nexus"] = makeFaShadow(Math.round(distance));
    }
    return flags;
  }

  /**
   * Add a tile by its center in pixels. Size from footprint (grid cells) * scale.
   * v14: x/y is the texture anchor position, so with anchor 0.5 we store the center.
   */
  addTile(entry, centerX, centerY, { scale = 1, rotation = 0, sort = SORT_MID, shadow = false, elevation = 0, occlusion = null } = {}) {
    const w = Math.max(8, Math.round((entry.w || 1) * this.grid * scale));
    const h = Math.max(8, Math.round((entry.h || 1) * this.grid * scale));
    const tile = {
      texture: { src: entry.src, anchorX: 0.5, anchorY: 0.5 },
      x: Math.round(centerX),
      y: Math.round(centerY),
      width: w,
      height: h,
      rotation: Math.round(rotation * 10) / 10,
      elevation,
      sort,
      flags: this.buildFlags({ shadow })
    };
    // "fade" = the whole tile fades to transparent when a token stands under it
    // (Foundry occlusion mode FADE). Only meaningful for overhead tiles, i.e.
    // tiles raised above token elevation.
    if (occlusion === "fade") {
      tile.occlusion = { mode: CONST.TILE_OCCLUSION_MODES?.FADE ?? 1, alpha: 0 };
    }
    this.tiles.push(tile);
  }

  /** Add a center-anchored tile with explicit pixel size (road segments). */
  addSizedTile(src, centerX, centerY, width, height, { rotation = 0, sort = SORT_GROUND, shadow = false, tint = null } = {}) {
    this.tiles.push({
      texture: { src, anchorX: 0.5, anchorY: 0.5, ...(tint ? { tint } : {}) },
      x: Math.round(centerX),
      y: Math.round(centerY),
      width: Math.round(width),
      height: Math.round(height),
      rotation: Math.round(rotation * 10) / 10,
      elevation: 0,
      sort,
      flags: this.buildFlags({ shadow })
    });
  }

  /** Add a tile with explicit top-left pixel rect (ground chunks, building prefabs). */
  addRawTile(src, x, y, width, height, { sort = SORT_GROUND, hidden = false, shadow = false, alpha = 1 } = {}) {
    this.tiles.push({
      texture: { src, anchorX: 0, anchorY: 0 },
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
      rotation: 0,
      elevation: 0,
      sort,
      hidden,
      alpha,
      flags: this.buildFlags({ shadow })
    });
  }

  /**
   * Instantiate a saved preset (tiles + walls + lights) at a cell position,
   * rotated by `rotationDeg` (0/90/180/270) around the preset centre and
   * rescaled from its authoring grid to this scene's grid.
   */
  placeProp(preset, cellX, cellY, rotationDeg = 0) {
    const s = this.grid / (preset.gridSize || this.grid); // author px -> scene px factor
    const pw = preset.cellsW * preset.gridSize * s;
    const ph = preset.cellsH * preset.gridSize * s;
    const theta = (rotationDeg % 360) * Math.PI / 180;
    const cosT = Math.round(Math.cos(theta));
    const sinT = Math.round(Math.sin(theta));
    // Rotate a point (px within preset, top-left origin) around preset centre,
    // then translate to the target cell origin.
    const cx = pw / 2;
    const cy = ph / 2;
    const originX = cellX * this.grid;
    const originY = cellY * this.grid;
    // After rotation the bounding box may swap w/h; keep the rotated box's
    // own top-left at the target origin
    const boxW = (rotationDeg % 180 === 0) ? pw : ph;
    const boxH = (rotationDeg % 180 === 0) ? ph : pw;
    const map = (px, py) => {
      const dx = px - cx;
      const dy = py - cy;
      return {
        x: originX + boxW / 2 + (dx * cosT - dy * sinT),
        y: originY + boxH / 2 + (dx * sinT + dy * cosT)
      };
    };

    // Layer order = the elevation you set per tile in FA Nexus (steps low,
    // rails higher, shadow highest), sort as tie-break. We keep every tile on
    // scene elevation 0 (so tokens stay on top) but re-issue sort in that
    // order, safely above the ground/feature plate.
    const shadowRank = (t) => (/shadow/i.test(t.src) ? 1 : 0);
    const presetTiles = (preset.tiles || [])
      .map((t, i) => ({ t, i }))
      .sort((a, b) =>
        (a.t.elevation ?? 0) - (b.t.elevation ?? 0)   // FA Nexus height wins
        || shadowRank(a.t) - shadowRank(b.t)          // shadows sit on top
        || (a.t.sort ?? 0) - (b.t.sort ?? 0)
        || a.i - b.i);
    let layerSort = 0;
    for (const { t } of presetTiles) {
      const tileSort = SORT_MID + layerSort;
      layerSort += 1;
      // Tile stored top-left; find its centre, map, re-derive top-left post-rotation
      const w = t.width * s;
      const h = t.height * s;
      const centre = map((t.x * s) + w / 2, (t.y * s) + h / 2);
      const flags = { [MODULE_ID]: this.moduleFlags() };
      if (t.faShadow && this.shadowsEnabled) flags["fa-nexus"] = { ...t.faShadow };
      // Keep sub-pixel precision (round to 0.01): independently rounding each
      // tile's position and size to whole pixels makes adjacent parts (steps
      // vs side rails) drift apart when the scene grid differs from the
      // preset's authoring grid.
      const round2 = (v) => Math.round(v * 100) / 100;
      this.tiles.push({
        texture: {
          src: t.src,
          anchorX: 0.5,
          anchorY: 0.5,
          scaleX: t.scaleX ?? 1,
          scaleY: t.scaleY ?? 1,
          ...(t.tint ? { tint: t.tint } : {})
        },
        x: round2(centre.x),
        y: round2(centre.y),
        width: round2(w),
        height: round2(h),
        rotation: ((t.rotation || 0) + rotationDeg) % 360,
        elevation: 0,
        sort: tileSort,
        hidden: !!t.hidden,
        alpha: t.alpha ?? 1,
        flags
      });
    }
    for (const w of preset.walls || []) {
      const a = map(w.c[0] * s, w.c[1] * s);
      const b = map(w.c[2] * s, w.c[3] * s);
      this.walls.push({
        c: [Math.round(a.x), Math.round(a.y), Math.round(b.x), Math.round(b.y)],
        door: w.door ?? 0,
        flags: { [MODULE_ID]: this.moduleFlags() }
      });
    }
    for (const l of preset.lights || []) {
      const p = map(l.x * s, l.y * s);
      this.lights.push({
        x: Math.round(p.x),
        y: Math.round(p.y),
        config: foundry.utils?.deepClone?.(l.config) ?? { ...l.config },
        flags: { [MODULE_ID]: this.moduleFlags() }
      });
    }
    return { boxW, boxH };
  }

  addLight(x, y, { brightCells, dimCells, color = "#ff9b3d", animation = null, alpha = 0.5 }) {
    this.lights.push({
      x: Math.round(x),
      y: Math.round(y),
      config: {
        bright: this.feet(brightCells),
        dim: this.feet(dimCells),
        color,
        alpha,
        ...(animation ? { animation } : {})
      },
      flags: { [MODULE_ID]: this.moduleFlags() }
    });
  }

  /**
   * AmbientSound. radiusCells → feet. A scene-wide bed uses walls:false,
   * easing:false so it plays uniformly everywhere; a positional emitter
   * (campfire) uses walls:true, easing:true so it fades with distance.
   */
  addSound(x, y, radiusCells, path, { volume = 0.6, walls = true, easing = true } = {}) {
    if (!path) return;
    this.sounds.push({
      x: Math.round(x),
      y: Math.round(y),
      radius: this.feet(radiusCells),
      path,
      repeat: true,
      volume,
      walls,
      easing,
      flags: { [MODULE_ID]: this.moduleFlags() }
    });
  }

  /**
   * Deterministic audio file from library.audio[key], or null. Uses a separate
   * RNG stream (audioRng) so whether a sound file exists never shifts the tile
   * layout — same seed, same map, with or without audio present.
   */
  audioFor(key) {
    const list = this.lib.audio?.[key];
    if (!list?.length) return null;
    return (this.audioRng ?? this.rng).pick(list);
  }

  addWall(x1, y1, x2, y2, { door = 0 } = {}) {
    this.walls.push({
      c: [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)],
      door,
      flags: { [MODULE_ID]: this.moduleFlags() }
    });
  }

  /** entry passes when it has no tone words or all of them are allowed */
  toneAllowed(entry) {
    if (!this.allowedTones || !entry.tones?.length) return true;
    return entry.tones.every((t) => this.allowedTones.includes(t));
  }

  /** hard exclusion, applies even where the palette is off (winter in summer) */
  toneBanned(entry) {
    if (!this.excludeTones?.length || !entry.tones?.length) return false;
    return entry.tones.some((t) => this.excludeTones.includes(t));
  }

  /**
   * Merged bucket entries with a valid footprint, filtered by cell size range.
   * Tone filtering is on by default; feature code with curated buckets
   * (furniture, tents) opts out via { tones: false }. Hard-banned tones
   * (snowy assets outside winter) are excluded regardless.
   */
  entries(buckets, { maxCells = 99, minCells = 0, minW = 1, tones = true, exclude = null } = {}) {
    const out = [];
    const excludeRe = exclude ? new RegExp(exclude, "i") : null;
    for (const name of buckets) {
      const list = this.lib.buckets[name];
      if (!list?.length) continue;
      for (const e of list) {
        if (!e.w || !e.h) continue;
        const size = Math.max(e.w, e.h);
        if (size > maxCells || size < minCells || e.w < minW) continue;
        // Context filter: e.g. dungeons want plain crates, not "Filled" barrels
        // of fresh apples/fish that belong in a camp or tavern storeroom.
        if (excludeRe && excludeRe.test(e.src)) continue;
        if (this.toneBanned(e)) continue;
        if (tones && !this.toneAllowed(e)) continue;
        out.push(e);
      }
    }
    // Only report when the whole group came up empty — single fallback buckets are fine
    if (!out.length) for (const name of buckets) this.missingBuckets.add(name);
    return out;
  }
}

/* -------------------------------- Ground -------------------------------- */

function placeGround(ctx, biome) {
  // A biome may point at its own texture bucket (e.g. dark-forest floor from the
  // Woodlands pack) with an optional tint; fall back to the /Maps/ ground.
  const pd = ctx.presetData;
  let src = null;
  if (pd?.groundBucket) {
    const list = ctx.lib.buckets?.[pd.groundBucket];
    if (list?.length) src = ctx.rng.pick(list).src;
  }
  src = src ?? ctx.lib.ground[biome] ?? ctx.lib.ground.grass ?? Object.values(ctx.lib.ground)[0];
  if (!src) return;
  const tint = pd?.groundTint ?? null;
  // Equal-sized chunks (no squeezed leftover column at the edges) +
  // mirror tiling: alternate chunks are flipped, so adjacent borders always
  // match pixel-for-pixel and the repeat seams disappear
  const nx = Math.max(1, Math.round(ctx.cellsW / 14));
  const ny = Math.max(1, Math.round(ctx.cellsH / 14));
  const wPx = ctx.pxW() / nx;
  const hPx = ctx.pxH() / ny;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      ctx.tiles.push({
        texture: {
          src,
          anchorX: 0.5,
          anchorY: 0.5,
          scaleX: ix % 2 ? -1 : 1,
          scaleY: iy % 2 ? -1 : 1,
          ...(tint ? { tint } : {})
        },
        x: Math.round((ix + 0.5) * wPx),
        y: Math.round((iy + 0.5) * hPx),
        width: Math.ceil(wPx) + 2,
        height: Math.ceil(hPx) + 2,
        rotation: 0,
        elevation: 0,
        sort: SORT_GROUND,
        flags: ctx.buildFlags({})
      });
    }
  }
}

/* --------------------------------- Road ---------------------------------- */

const GENERATED_DIR = "paradigma-generated";

/**
 * Paint the road into an offscreen canvas: a texture-pattern brush stroked
 * along the smooth path with round joins, feathered edges and width wobble.
 * The result is uploaded as a webp and placed as ONE scene-sized tile —
 * no rectangle collage, no hard seams. Returns the uploaded path or null.
 */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`image load failed: ${src}`));
    image.src = encodeURI(src);
  });
}

async function renderRoadTexture(ctx, samples, halfWidth) {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;

  // Preset brush (e.g. Arctic disturbed-snow overlay) beats the dirt fallback.
  // Brushes are ready-made overlays — no tint applied to them.
  let brushSrc = null;
  const brushBucket = ctx.presetData?.roadBrush;
  if (brushBucket && ctx.lib.buckets[brushBucket]?.length) {
    brushSrc = ctx.rng.pick(ctx.lib.buckets[brushBucket]).src;
  }
  // groundKey lets a biome pick its own dirt (desert roads use the cave floor,
  // since sand-on-sand would be invisible)
  const groundKey = ctx.presetData?.roadGroundKey;
  const baseSrc = brushSrc
    ?? (groundKey ? ctx.lib.ground[groundKey] : null)
    ?? ctx.lib.ground.desert
    ?? ctx.lib.ground.underground;
  if (!baseSrc) return null;
  const tint = brushSrc ? (ctx.presetData?.roadBrushTint ?? null) : ctx.roadTint;

  const img = await loadImage(baseSrc);

  const scale = Math.min(1, 2200 / Math.max(ctx.pxW(), ctx.pxH()));
  const cw = Math.round(ctx.pxW() * scale);
  const chh = Math.round(ctx.pxH() * scale);

  // --- soft mask: overlapping round-cap strokes with breathing width ---
  const mask = document.createElement("canvas");
  mask.width = cw;
  mask.height = chh;
  const m = mask.getContext("2d");
  m.strokeStyle = "#ffffff";
  m.fillStyle = "#ffffff";
  m.lineCap = "round";
  m.lineJoin = "round";
  m.filter = `blur(${Math.max(2, Math.round(5 * scale))}px)`;

  const baseW = halfWidth * 2 * ctx.grid * scale;
  const phase = ctx.rng.float(0, Math.PI * 2);
  const px = (s) => s.x * ctx.grid * scale;
  const py = (s) => s.y * ctx.grid * scale;

  let travelled = 0;
  for (let i = 0; i < samples.length - 1; i += 3) {
    const end = Math.min(samples.length - 1, i + 4); // 1-sample overlap between chunks
    travelled += Math.hypot(samples[end].x - samples[i].x, samples[end].y - samples[i].y);
    m.lineWidth = baseW * (1 + 0.20 * Math.sin(travelled * 0.5 + phase) + ctx.rng.float(-0.07, 0.07));
    m.beginPath();
    m.moveTo(px(samples[i]), py(samples[i]));
    for (let j = i + 1; j <= end; j++) m.lineTo(px(samples[j]), py(samples[j]));
    m.stroke();

    // Irregular blobs bulging out of the edge
    if (ctx.rng.chance(0.4)) {
      const s = samples[Math.min(samples.length - 1, i + 2)];
      const n = samples[Math.min(samples.length - 1, i + 3)];
      const angle = Math.atan2(n.y - s.y, n.x - s.x) + (ctx.rng.chance(0.5) ? 1 : -1) * Math.PI / 2;
      const off = halfWidth * ctx.rng.float(0.5, 0.9) * ctx.grid * scale;
      const r = ctx.rng.float(0.35, 0.8) * ctx.grid * scale;
      m.beginPath();
      m.arc(px(s) + Math.cos(angle) * off, py(s) + Math.sin(angle) * off, r, 0, Math.PI * 2);
      m.fill();
    }
  }

  // --- textured fill, tinted, clipped by the mask ---
  const cnv = document.createElement("canvas");
  cnv.width = cw;
  cnv.height = chh;
  const c = cnv.getContext("2d");
  const pattern = c.createPattern(img, "repeat");
  c.fillStyle = pattern;
  c.fillRect(0, 0, cw, chh);
  if (tint) {
    c.globalCompositeOperation = "multiply";
    c.fillStyle = tint;
    c.fillRect(0, 0, cw, chh);
  }
  c.globalCompositeOperation = "destination-in";
  c.drawImage(mask, 0, 0);

  // Weathering, clipped to the road alpha: a darker trodden center line and
  // soft light/dark blotches — kills the sterile uniform look
  c.globalCompositeOperation = "source-atop";
  c.filter = `blur(${Math.max(3, Math.round(9 * scale))}px)`;
  c.strokeStyle = "rgba(38, 30, 20, 0.10)";
  c.lineCap = "round";
  c.lineJoin = "round";
  c.lineWidth = baseW * 0.45;
  c.beginPath();
  c.moveTo(px(samples[0]), py(samples[0]));
  for (let i = 1; i < samples.length; i++) c.lineTo(px(samples[i]), py(samples[i]));
  c.stroke();

  // Dark-only mottling: damp patches and worn dirt. Lightening blotches read
  // as weird pale circles, so we only ever darken.
  const blotches = Math.round(samples.length / 2.5);
  for (let k = 0; k < blotches; k++) {
    const s = samples[ctx.rng.int(0, samples.length - 1)];
    const angle = ctx.rng.float(0, Math.PI * 2);
    const off = ctx.rng.float(0, halfWidth * 0.8);
    const bxp = (s.x + Math.cos(angle) * off) * ctx.grid * scale;
    const byp = (s.y + Math.sin(angle) * off) * ctx.grid * scale;
    const r = ctx.rng.float(0.4, 1.3) * ctx.grid * scale;
    const alpha = ctx.rng.float(0.04, 0.1).toFixed(3);
    c.fillStyle = `rgba(35, 28, 18, ${alpha})`;
    c.beginPath();
    c.arc(bxp, byp, r, 0, Math.PI * 2);
    c.fill();
  }
  c.filter = "none";
  c.globalCompositeOperation = "source-over";

  const blob = await new Promise((resolve) => cnv.toBlob(resolve, "image/webp", 0.85));
  if (!blob) return null;

  const FP = getFilePicker();
  try {
    await FP.createDirectory("data", GENERATED_DIR);
  } catch (error) {
    if (!/EEXIST|already exists/i.test(String(error?.message ?? error))) throw error;
  }
  const file = new File([blob], `road-${ctx.seedTag}.webp`, { type: "image/webp" });
  const uploaded = await FP.upload("data", GENERATED_DIR, file, {}, { notify: false });
  return uploaded?.path ?? null;
}

/**
 * Sensible road shapes: a near-straight line with a gentle diagonal drift,
 * or a soft C-arc bowing to one side. (Winding switchbacks are for future
 * mountain/dungeon biomes.)
 */
function makeRoadSamples(ctx) {
  const horizontal = ctx.rng.chance(0.5);
  const mainLen = horizontal ? ctx.cellsW : ctx.cellsH;
  const crossLen = horizontal ? ctx.cellsH : ctx.cellsW;
  const nPoints = 5;
  const arc = ctx.rng.chance(0.5);
  const base = crossLen * ctx.rng.float(0.3, 0.7);
  const drift = ctx.rng.float(-0.18, 0.18) * crossLen;
  const bow = (ctx.rng.chance(0.5) ? 1 : -1) * ctx.rng.float(0.14, 0.26) * crossLen;

  const points = [];
  for (let i = 0; i < nPoints; i++) {
    const t = i / (nPoints - 1);
    let cross = base + drift * (t - 0.5);
    if (arc) cross += bow * Math.sin(t * Math.PI);
    cross += ctx.rng.float(-0.03, 0.03) * crossLen; // subtle organic wobble
    cross = Math.max(2, Math.min(crossLen - 2, cross));
    const main = t * mainLen;
    points.push(horizontal ? { x: main, y: cross } : { x: cross, y: main });
  }
  return samplePath(points, 0.5);
}

async function buildRoad(ctx) {
  const samples = makeRoadSamples(ctx);
  const [hwMin, hwMax] = ctx.presetData?.roadHalfWidth ?? [1.3, 1.7];
  const halfWidth = ctx.rng.float(hwMin, hwMax);
  for (const s of samples) ctx.occ.markCircle(s.x, s.y, halfWidth + 0.5, ROAD);

  // Preferred: paint the whole road into one soft-edged texture
  let painted = false;
  try {
    const roadSrc = await renderRoadTexture(ctx, samples, halfWidth);
    if (roadSrc) {
      ctx.addRawTile(roadSrc, 0, 0, ctx.pxW(), ctx.pxH(), { sort: SORT_GROUND + 10 });
      painted = true;
    }
  } catch (error) {
    console.warn(`${MODULE_ID} | Road texture painting failed, falling back to segments`, error);
  }

  // Fallback: rotated segments of the dirt texture (older, more mechanical look)
  const dirtSrc = ctx.lib.ground.desert ?? ctx.lib.ground.underground;
  if (!painted && dirtSrc) {
    const segLen = 0.8;
    const segH = (segLen + 1.4) * ctx.grid;
    const phase = ctx.rng.float(0, Math.PI * 2);
    let acc = segLen;
    let travelledTotal = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      acc += d;
      travelledTotal += d;
      if (acc < segLen) continue;
      acc = 0;
      const widthMod = 1 + 0.22 * Math.sin(travelledTotal * 0.45 + phase) + ctx.rng.float(-0.08, 0.08);
      const segW = halfWidth * 2 * ctx.grid * widthMod;
      const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI + 90;
      const mx = (a.x + b.x) / 2 * ctx.grid;
      const my = (a.y + b.y) / 2 * ctx.grid;
      ctx.addSizedTile(dirtSrc, mx, my, segW, segH, { rotation: angle, sort: SORT_GROUND + 10, tint: ctx.roadTint });
    }
  }

  // Hoofprints trailing along the road, one family, one direction
  let tracks = ctx.entries(ctx.presetData?.roadTracks ?? ["tracks"], { maxCells: 2 });
  if (tracks.length) {
    const horse = tracks.filter((e) => /horse|foot/i.test(e.family));
    if (horse.length) tracks = horse;
    const family = ctx.rng.pick([...new Set(tracks.map((e) => e.family))]);
    tracks = tracks.filter((e) => e.family === family);
    let travelled = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      travelled += Math.hypot(b.x - a.x, b.y - a.y);
      if (travelled < 4.2) continue;
      travelled = 0;
      if (!ctx.rng.chance(0.6)) continue; // occasional prints, not a stamp line
      if (ctx.occ.test(Math.floor(b.x), Math.floor(b.y), 1, 1, RESERVED)) continue;
      const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI + 90;
      const lateral = ctx.rng.float(-0.3, 0.3);
      const px = (b.x + Math.cos(Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2) * lateral) * ctx.grid;
      const py = (b.y + Math.sin(Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2) * lateral) * ctx.grid;
      ctx.addTile(ctx.rng.pick(tracks), px, py, {
        scale: ctx.rng.float(0.8, 0.95),
        rotation: angle + ctx.rng.float(-8, 8),
        sort: SORT_FLAT - 50
      });
    }
  }

  // Edge blending: biome-appropriate tufts straddle the dirt seam on both
  // sides, plus debris scattered on the road itself — the transition
  // reads as overgrowth instead of a cut-out band
  let verge = ctx.entries(ctx.presetData?.roadVerge ?? ["plants", "bushes"], { maxCells: 2 });
  verge = limitFamilies(ctx, verge, 2);
  const debris = ctx.entries(ctx.presetData?.roadDebris ?? ["leaves", "sticks", "rocks"], { maxCells: 2 });
  for (let i = 3; i < samples.length - 3; i += 3) {
    const a = samples[i - 1];
    const b = samples[i];
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    for (const side of [1, -1]) {
      if (!verge.length || !ctx.rng.chance(0.4)) continue;
      // Right on the seam: half on dirt, half on grass
      const off = halfWidth + ctx.rng.float(-0.35, 0.45);
      const px = (b.x + Math.cos(angle + side * Math.PI / 2) * off) * ctx.grid;
      const py = (b.y + Math.sin(angle + side * Math.PI / 2) * off) * ctx.grid;
      if (px < 0 || py < 0 || px > ctx.pxW() || py > ctx.pxH()) continue;
      if (ctx.occ.test(Math.floor(px / ctx.grid), Math.floor(py / ctx.grid), 1, 1, RESERVED)) continue;
      ctx.addTile(ctx.rng.pick(verge), px, py, {
        scale: ctx.rng.float(0.55, 1.0),
        rotation: ctx.rng.float(0, 360),
        sort: SORT_FLAT + 10,
        shadow: false
      });
    }
    if (debris.length && ctx.rng.chance(0.07)) {
      const off = ctx.rng.float(-0.6, 0.6) * halfWidth;
      const px = (b.x + Math.cos(angle + Math.PI / 2) * off) * ctx.grid;
      const py = (b.y + Math.sin(angle + Math.PI / 2) * off) * ctx.grid;
      if (px < 0 || py < 0 || px > ctx.pxW() || py > ctx.pxH()) continue;
      if (ctx.occ.test(Math.floor(px / ctx.grid), Math.floor(py / ctx.grid), 1, 1, RESERVED)) continue;
      ctx.addTile(ctx.rng.pick(debris), px, py, {
        scale: ctx.rng.float(0.45, 0.65),
        rotation: ctx.rng.float(0, 360),
        sort: SORT_FLAT - 40,
        shadow: false
      });
    }
  }
  return samples;
}

/* -------------------------------- Scatter -------------------------------- */

/** Keep only a few random asset families so the map looks coherent. */
function limitFamilies(ctx, entries, maxFamilies) {
  if (!maxFamilies) return entries;
  const families = [...new Set(entries.map((e) => e.family))];
  if (families.length <= maxFamilies) return entries;
  const chosen = new Set();
  while (chosen.size < maxFamilies) chosen.add(ctx.rng.pick(families));
  return entries.filter((e) => chosen.has(e.family));
}

function runScatter(ctx, def, densityMult) {
  let entries = ctx.entries(def.buckets, { maxCells: def.maxCells ?? 6, minCells: def.minCells ?? 0, exclude: def.exclude });
  // Soft tone preference: autumn bushes on an autumn map, if any exist
  if (def.tonePrefer) {
    const preferred = entries.filter((e) => e.tones?.includes(def.tonePrefer));
    if (preferred.length >= 3) entries = preferred;
  }
  entries = limitFamilies(ctx, entries, def.families ?? 0);
  if (!entries.length) return 0;

  // Overhead tree canopies (def.overhead) rise to 20ft and fade under tokens.
  // A ground-level stump is dropped directly under each one so that when the
  // canopy fades there's still a trunk base visible. Stump kind matches the
  // tree: palms get palm-trunk cross-sections, anything in a winter scene gets
  // snowy stumps (so bare winter trees don't get brown wood on snow).
  let stumpBuckets = ["stumps"];
  if (def.overhead) {
    if (def.buckets.includes("trees_palm")) stumpBuckets = ["stumps_palm", "stumps"];
    else if (ctx.presetData?.tags?.biome === "winter" || def.buckets.some((b) => /snow/.test(b))) stumpBuckets = ["stumps_snow", "stumps"];
  }
  // Take the FIRST bucket that has entries — don't merge them. Merging let
  // brown stumps mix into snow scenes and generic stumps into palm groves.
  // Also keep only round, roughly-square cross-sections: elongated 1x2/1x4
  // "trunks" are side-view logs (a fallen palm), not a cut base.
  let stumpEntries = null;
  if (def.overhead) {
    for (const b of stumpBuckets) {
      const list = ctx.entries([b], { tones: false })
        .filter((e) => Math.max(e.w, e.h) <= Math.min(e.w, e.h) * 1.4);
      if (list.length) { stumpEntries = list; break; }
    }
  }

  const target = Math.max(1, Math.round((def.per100 * densityMult * ctx.cellsW * ctx.cellsH) / 100));
  const avoidMask = (def.avoid || []).reduce((m, k) => m | (AVOID_MASKS[k] || 0), 0);
  let placed = 0;

  // Cluster centers: growth happens in patches, not uniform noise
  let clusters = null;
  if (def.cluster) {
    const count = Math.max(2, Math.round((ctx.cellsW * ctx.cellsH) / 200));
    clusters = Array.from({ length: count }, () => ({
      x: ctx.rng.float(2, ctx.cellsW - 2),
      y: ctx.rng.float(2, ctx.cellsH - 2),
      r: ctx.rng.float(3.5, 7)
    }));
  }

  // Draw variants from a shuffled bag: every distinct asset appears before any
  // repeat, so dense scatter (e.g. dungeon crates on max saturation) doesn't
  // spam the same texture over and over.
  let bag = [];
  const drawEntry = () => {
    if (!bag.length) bag = ctx.rng.shuffle(entries.slice());
    return bag.pop();
  };

  for (let attempts = target * 12; attempts > 0 && placed < target; attempts--) {
    const entry = drawEntry();
    const scale = ctx.rng.float(def.scale?.[0] ?? 0.9, def.scale?.[1] ?? 1.1);
    const fw = Math.max(1, Math.round(entry.w * scale));
    const fh = Math.max(1, Math.round(entry.h * scale));

    let cx;
    let cy;
    if (clusters && ctx.rng.chance(0.85)) {
      const c = ctx.rng.pick(clusters);
      cx = Math.round(c.x + ctx.rng.gauss(-1, 1) * c.r - fw / 2);
      cy = Math.round(c.y + ctx.rng.gauss(-1, 1) * c.r - fh / 2);
      if (cx < 0 || cy < 0 || cx + fw > ctx.cellsW || cy + fh > ctx.cellsH) continue;
    } else {
      cx = ctx.rng.int(0, ctx.cellsW - fw);
      cy = ctx.rng.int(0, ctx.cellsH - fh);
    }

    if (avoidMask && ctx.occ.test(cx, cy, fw, fh, avoidMask)) continue;
    const insideMask = AVOID_MASKS[def.inside];
    if (insideMask) {
      // Strict by default: the WHOLE footprint must sit inside the region, so
      // crates/rubble can't hang out over dungeon/arena walls. `insideLoose`
      // (winter road drifts) keeps the old "any cell overlaps" behaviour.
      const fits = def.insideLoose
        ? ctx.occ.test(cx, cy, fw, fh, insideMask)
        : ctx.occ.contains(cx, cy, fw, fh, insideMask);
      if (!fits) continue;
    }

    const centerX = (cx + fw / 2 + ctx.rng.float(-0.25, 0.25)) * ctx.grid;
    const centerY = (cy + fh / 2 + ctx.rng.float(-0.25, 0.25)) * ctx.grid;
    const tall = def.layer === "tall";
    const sortBase = def.layer === "flat" ? SORT_FLAT : tall ? SORT_TALL : SORT_MID;

    // A matching stump on the ground, exactly under the canopy, BEFORE the
    // canopy is added — it stays at elevation 0 so the raised, fading canopy
    // covers it until a token walks underneath. Scaled to ~half the canopy so
    // a big tree gets a big base, a sapling a small one.
    if (def.overhead && stumpEntries?.length) {
      const stump = ctx.rng.pick(stumpEntries);
      // A trunk base, not a giant ring: ~0.28 of the canopy span, capped at
      // ~1.8 cells so wide sprawling trees don't get an oversized stump.
      const wantCells = Math.min(fw * 0.28, 1.8);
      const stumpScale = Math.max(0.2, wantCells / (stump.w || 1));
      // NO random rotation: some stump variants have the cut disc drawn slightly
      // off-centre in their sprite, and spinning them swings that offset out to
      // the side (the "stump drifted left" glitch). Placed as authored, the
      // disc stays over the trunk.
      ctx.addTile(stump, centerX, centerY, {
        scale: stumpScale,
        rotation: 0,
        sort: SORT_TALL + cy,
        shadow: "mid"
      });
    }

    // Tall assets keep their baked shadow direction — only a slight jitter,
    // otherwise the lighting looks inconsistent across the map.
    //  - def.overhead: canopy rises to 20ft, FADES under a token, and gets a
    //    stump (leafy trees).
    //  - def.elevation: just raised to that height, NO fade, NO stump (bare
    //    trees — the user wants them elevated but a stump amid the branches
    //    looks wrong).
    const raise = def.overhead
      ? { elevation: 20, occlusion: "fade" }
      : (def.elevation ? { elevation: def.elevation } : {});
    ctx.addTile(entry, centerX, centerY, {
      scale,
      rotation: tall ? ctx.rng.float(-12, 12) : ctx.rng.float(0, 360),
      sort: sortBase + cy,
      shadow: def.layer === "flat" ? false : def.layer,
      ...raise
    });

    if (def.layer !== "flat") {
      // Tall assets (tree canopies) only block their core, so forests stay dense
      const bw = tall ? Math.max(1, Math.round(fw * 0.5)) : fw;
      const bh = tall ? Math.max(1, Math.round(fh * 0.5)) : fh;
      ctx.occ.mark(cx + Math.floor((fw - bw) / 2), cy + Math.floor((fh - bh) / 2), bw, bh, OBJ);
    }
    placed++;
  }
  return placed;
}

/* ----------------------------- Feature placement ------------------------- */

/**
 * Find a spot for a w×h feature that overlaps the road and other features
 * as little as possible (30 random candidates, lowest collision score wins).
 */
function findFeatureSpot(ctx, w, h) {
  let best = null;
  for (let i = 0; i < 30; i++) {
    const x = ctx.rng.int(1, Math.max(1, ctx.cellsW - w - 1));
    const y = ctx.rng.int(1, Math.max(1, ctx.cellsH - h - 1));
    let score = 0;
    for (let cy = y; cy < y + h; cy += 2) {
      for (let cx = x; cx < x + w; cx += 2) {
        if (ctx.occ.test(cx, cy, 1, 1, ROAD | RESERVED | OBJ)) score++;
      }
    }
    // Mild pull toward the middle of the map
    const dcx = (x + w / 2) / ctx.cellsW - 0.5;
    const dcy = (y + h / 2) / ctx.cellsH - 0.5;
    score += (dcx * dcx + dcy * dcy) * 10;
    if (!best || score < best.score) best = { x0: x, y0: y, score };
    if (best.score === 0) break;
  }
  return best;
}

/**
 * Strictly collision-free rect: 60 random spots must have ZERO overlap with
 * road/features/objects; if none fits, the feature shrinks by 10% and tries
 * again (down to minScale). Guarantees buildings never sit on the road.
 */
function planRect(ctx, wantW, wantH, { minScale = 0.6 } = {}) {
  for (let s = 1; s >= minScale - 1e-6; s -= 0.1) {
    const w = Math.max(5, Math.round(wantW * s));
    const h = Math.max(4, Math.round(wantH * s));
    for (let i = 0; i < 60; i++) {
      const x = ctx.rng.int(1, Math.max(1, ctx.cellsW - w - 1));
      const y = ctx.rng.int(1, Math.max(1, ctx.cellsH - h - 1));
      if (!ctx.occ.test(x, y, w, h, ROAD | RESERVED | OBJ)) return { x0: x, y0: y, w, h };
    }
  }
  // Last resort on a hopelessly crowded map: least-bad spot at minimum size
  const w = Math.max(5, Math.round(wantW * minScale));
  const h = Math.max(4, Math.round(wantH * minScale));
  const spot = findFeatureSpot(ctx, w, h);
  console.warn(`${MODULE_ID} | No clean spot for a ${w}x${h} feature, placing with overlap`);
  return { x0: spot.x0, y0: spot.y0, w, h };
}

/** Spot for an outbuilding hugging the main rect (1-3 cell gap), or null. */
function findAdjacentSpot(ctx, main, w, h) {
  for (let i = 0; i < 12; i++) {
    const gap = ctx.rng.int(1, 3);
    const side = ctx.rng.int(0, 3);
    let x;
    let y;
    if (side === 0) { x = main.x0 - w - gap; y = main.y0 + ctx.rng.int(0, Math.max(0, main.h - h)); }
    else if (side === 1) { x = main.x0 + main.w + gap; y = main.y0 + ctx.rng.int(0, Math.max(0, main.h - h)); }
    else if (side === 2) { x = main.x0 + ctx.rng.int(0, Math.max(0, main.w - w)); y = main.y0 - h - gap; }
    else { x = main.x0 + ctx.rng.int(0, Math.max(0, main.w - w)); y = main.y0 + main.h + gap; }
    if (x < 1 || y < 1 || x + w > ctx.cellsW - 1 || y + h > ctx.cellsH - 1) continue;
    if (ctx.occ.test(x, y, w, h, ROAD | RESERVED | OBJ)) continue;
    return { x0: x, y0: y };
  }
  return null;
}

/**
 * Plan all feature rects BEFORE the road is routed: reserve their footprints
 * so the road can steer around them and features never stack on each other.
 */
async function planFeatures(ctx, features) {
  const plans = [];
  for (const type of features) {
    if (type === "camp") {
      const box = Math.ceil(Math.min(ctx.cellsW, ctx.cellsH) * 0.48);
      const rect = planRect(ctx, box, box);
      ctx.occ.mark(rect.x0, rect.y0, rect.w, rect.h, RESERVED);
      plans.push({ type, rect });
    } else if (type === "graveyard") {
      const w = Math.round(ctx.cellsW * ctx.rng.float(0.25, 0.35));
      const h = Math.round(ctx.cellsH * ctx.rng.float(0.25, 0.35));
      const rect = planRect(ctx, w, h);
      ctx.occ.mark(rect.x0, rect.y0, rect.w, rect.h, RESERVED);
      plans.push({ type, rect });
    } else if (type === "lake") {
      const box = Math.round(Math.min(ctx.cellsW, ctx.cellsH) * ctx.rng.float(0.4, 0.55));
      const rect = planRect(ctx, box, Math.round(box * ctx.rng.float(0.72, 1.0)));
      ctx.occ.mark(rect.x0, rect.y0, rect.w, rect.h, RESERVED);
      plans.push({ type, rect });
    } else if (type === "building") {
      // A user-authored building preset placed as-is (never scaled). Skip with
      // a hint if the user hasn't saved any into the "building" category.
      const presets = ctx.buildingPresets ?? [];
      if (!presets.length) {
        ui.notifications.warn(i18n("Notifications.NeedBuildingPreset"));
        continue;
      }
      const preset = ctx.rng.pick(presets);
      const rect = planRect(ctx, preset.cellsW, preset.cellsH, { minScale: 1 });
      ctx.occ.mark(rect.x0, rect.y0, preset.cellsW, preset.cellsH, RESERVED);
      plans.push({ type, rect, preset });
    } else if (type === "tavern") {
      let w = Math.min(ctx.cellsW - 4, Math.max(16, Math.round(ctx.cellsW * 0.55)));
      let h = Math.round(w * 0.75);
      if (ctx.lib.tavern.bg) {
        const size = await loadTextureSize(ctx.lib.tavern.bg);
        if (size) h = Math.round(w * (size.height / size.width));
      } else {
        w = Math.round(ctx.cellsW * 0.5);
        h = Math.round(ctx.cellsH * 0.5);
      }
      if (h > ctx.cellsH - 4) {
        const aspect = h / w;
        h = ctx.cellsH - 4;
        w = Math.round(h / aspect);
      }
      const rect = planRect(ctx, w, h, { minScale: 0.7 });
      ctx.occ.mark(rect.x0, rect.y0, rect.w, rect.h, RESERVED);
      plans.push({ type, rect });
    } else if (type === "ruins") {
      // Two layouts: a big hall with interior rooms, or a smaller main
      // building with 1-2 half-collapsed outbuildings around it
      const mode = ctx.rng.chance(0.5) ? "rooms" : "compound";
      const range = mode === "rooms" ? [0.32, 0.44] : [0.24, 0.34];
      const rw = Math.max(8, Math.round(ctx.cellsW * ctx.rng.float(range[0], range[1])));
      const rh = Math.max(7, Math.round(ctx.cellsH * ctx.rng.float(range[0], range[1])));
      const main = planRect(ctx, rw, rh);
      ctx.occ.mark(main.x0, main.y0, main.w, main.h, RESERVED);
      const outbuildings = [];
      if (mode === "compound") {
        for (let i = 0; i < ctx.rng.int(1, 2); i++) {
          const ow = ctx.rng.int(5, 7);
          const oh = ctx.rng.int(4, 6);
          const adj = findAdjacentSpot(ctx, main, ow, oh);
          if (!adj) continue;
          const rect = { x0: adj.x0, y0: adj.y0, w: ow, h: oh };
          ctx.occ.mark(rect.x0, rect.y0, ow, oh, RESERVED);
          outbuildings.push(rect);
        }
      }
      plans.push({ type, rect: main, mode, outbuildings });
    }
  }
  return plans;
}

/* ------------------------------ Feature: camp ---------------------------- */

function placeCamp(ctx, rect) {
  const rng = ctx.rng;
  const grid = ctx.grid;
  const clearR = rect.w / 2 - 0.5;
  const cx = rect.x0 + rect.w / 2;
  const cy = rect.y0 + rect.h / 2;
  ctx.occ.markCircle(cx, cy, clearR, RESERVED);

  const centerX = cx * grid;
  const centerY = cy * grid;

  // Campfire + light
  const fire = rng.pick(ctx.entries(["campfires_lit"], { maxCells: 3, tones: false }))
    ?? rng.pick(ctx.entries(["campfires_cold"], { maxCells: 3, tones: false }));
  if (fire) {
    ctx.addTile(fire, centerX, centerY, { scale: rng.float(1.0, 1.2), rotation: rng.float(0, 360), sort: SORT_MID });
    ctx.occ.markCircle(cx, cy, 1.5, OBJ);
    if (/lit/i.test(fire.name) && !/unlit/i.test(fire.name)) {
      ctx.addLight(centerX, centerY, {
        brightCells: 2, dimCells: 5, color: "#ff9b3d",
        animation: { type: "torch", speed: 3, intensity: 4 }
      });
      ctx.addSound(centerX, centerY, 6, ctx.audioFor("campfire"), { volume: 0.8, walls: true, easing: true });
    }
  }

  // Tents in a ring, entrances facing the fire
  const tents = ctx.entries(["tents"], { maxCells: 5, tones: false });
  if (tents.length) {
    const count = rng.int(3, 5);
    const angle0 = rng.float(0, Math.PI * 2);
    for (let i = 0; i < count; i++) {
      const angle = angle0 + (i / count) * Math.PI * 2 + rng.float(-0.25, 0.25);
      const r = clearR * rng.float(0.55, 0.72);
      const tx = centerX + Math.cos(angle) * r * grid;
      const ty = centerY + Math.sin(angle) * r * grid;
      const entry = rng.pick(tents);
      const facing = Math.atan2(centerY - ty, centerX - tx) * 180 / Math.PI - 90;
      ctx.addTile(entry, tx, ty, { scale: rng.float(0.95, 1.1), rotation: facing + rng.float(-10, 10), sort: SORT_TALL + Math.round(ty / grid), shadow: "tall" });
      ctx.occ.markCircle(tx / grid, ty / grid, Math.max(entry.w, entry.h) * 0.55, OBJ);
    }
  }

  // Seating logs near the fire
  const logs = ctx.entries(["logs"], { maxCells: 4, tones: false });
  if (logs.length) {
    const count = rng.int(2, 3);
    for (let i = 0; i < count; i++) {
      const angle = rng.float(0, Math.PI * 2);
      const r = rng.float(2.0, 2.8);
      const lx = centerX + Math.cos(angle) * r * grid;
      const ly = centerY + Math.sin(angle) * r * grid;
      const tangent = angle * 180 / Math.PI + 90;
      ctx.addTile(rng.pick(logs), lx, ly, { scale: rng.float(0.8, 1.0), rotation: tangent + rng.float(-12, 12), sort: SORT_MID + Math.round(ly / grid), shadow: "mid" });
      ctx.occ.markCircle(lx / grid, ly / grid, 1, OBJ);
    }
  }

  // Supplies pile + cart at the edge of the clearing
  const supplies = ctx.entries(["barrels", "crates"], { maxCells: 3, tones: false });
  if (supplies.length) {
    const angle = rng.float(0, Math.PI * 2);
    const baseX = centerX + Math.cos(angle) * clearR * 0.75 * grid;
    const baseY = centerY + Math.sin(angle) * clearR * 0.75 * grid;
    const count = rng.int(2, 4);
    for (let i = 0; i < count; i++) {
      const sx = baseX + rng.float(-1.2, 1.2) * grid;
      const sy = baseY + rng.float(-1.2, 1.2) * grid;
      ctx.addTile(rng.pick(supplies), sx, sy, { scale: rng.float(0.8, 1.0), rotation: rng.float(0, 360), sort: SORT_MID + Math.round(sy / grid), shadow: "mid" });
      ctx.occ.markCircle(sx / grid, sy / grid, 0.8, OBJ);
    }
  }

  const carts = ctx.entries(["carts"], { maxCells: 5, tones: false });
  if (carts.length && rng.chance(0.8)) {
    const angle = rng.float(0, Math.PI * 2);
    const cxPx = centerX + Math.cos(angle) * clearR * 0.95 * grid;
    const cyPx = centerY + Math.sin(angle) * clearR * 0.95 * grid;
    ctx.addTile(rng.pick(carts), cxPx, cyPx, { scale: 1, rotation: rng.float(0, 360), sort: SORT_MID + Math.round(cyPx / grid), shadow: "mid" });
    ctx.occ.markCircle(cxPx / grid, cyPx / grid, 1.6, OBJ);
  }

  // Perimeter torches with small lights
  const torches = ctx.entries(["torches_lit", "torches_cold"], { maxCells: 2, tones: false });
  if (torches.length) {
    const count = rng.int(2, 4);
    const angle0 = rng.float(0, Math.PI * 2);
    for (let i = 0; i < count; i++) {
      const angle = angle0 + (i / count) * Math.PI * 2 + rng.float(-0.3, 0.3);
      const tx = centerX + Math.cos(angle) * clearR * 0.9 * grid;
      const ty = centerY + Math.sin(angle) * clearR * 0.9 * grid;
      ctx.addTile(rng.pick(torches), tx, ty, { scale: rng.float(0.8, 1.0), rotation: rng.float(0, 360), sort: SORT_MID + Math.round(ty / grid), shadow: "mid" });
      ctx.addLight(tx, ty, {
        brightCells: 1, dimCells: 3, color: "#ffb45e",
        animation: { type: "torch", speed: 4, intensity: 3 }
      });
    }
  }
}

/* ------------------------------ Feature: ruins ---------------------------- */

/** Mark 1-cell occupancy along a pixel-space run. */
function markRunCells(ctx, run, mask) {
  const len = Math.hypot(run.x2 - run.x1, run.y2 - run.y1);
  const steps = Math.max(1, Math.ceil(len / (ctx.grid * 0.5)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = Math.floor((run.x1 + (run.x2 - run.x1) * t) / ctx.grid);
    const cy = Math.floor((run.y1 + (run.y2 - run.y1) * t) / ctx.grid);
    ctx.occ.mark(cx, cy, 1, 1, mask);
  }
}

/**
 * Paint the ruin into one texture: flagstone floor plates with eaten-away
 * edges + wall strips with broken endings along the surviving runs.
 * Handles multiple plates (main hall + outbuildings) in one canvas.
 * Built from FA Core_Settlements modular parts. Returns uploaded path or null.
 */
async function renderRuinTexture(ctx, { plates, runs }) {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  const floorList = ctx.lib.buckets.ruin_floor_tex ?? [];
  const stripList = ctx.lib.buckets.ruin_wall_strip ?? [];
  if (!floorList.length && !stripList.length) return null;

  const margin = 1; // cells of transparent padding around the plates
  const minX = Math.min(...plates.map((p) => p.x0)) - margin;
  const minY = Math.min(...plates.map((p) => p.y0)) - margin;
  const maxX = Math.max(...plates.map((p) => p.x0 + p.w)) + margin;
  const maxY = Math.max(...plates.map((p) => p.y0 + p.h)) + margin;
  const bx = minX * ctx.grid;
  const by = minY * ctx.grid;
  const bw = (maxX - minX) * ctx.grid;
  const bh = (maxY - minY) * ctx.grid;
  const scale = Math.min(1, 2048 / Math.max(bw, bh));
  const cw = Math.round(bw * scale);
  const chh = Math.round(bh * scale);
  const toX = (px) => (px - bx) * scale;
  const toY = (py) => (py - by) * scale;

  const cnv = document.createElement("canvas");
  cnv.width = cw;
  cnv.height = chh;
  const c = cnv.getContext("2d");

  // --- floors: flagstone pattern with organically eroded edges, per plate ---
  if (floorList.length) {
    const img = await loadImage(ctx.rng.pick(floorList).src);
    const pattern = c.createPattern(img, "repeat");
    // One texture repeat ≈ 7 cells, matching FA's intended density
    const patScale = (7 * ctx.grid * scale) / img.width;
    if (pattern.setTransform && typeof DOMMatrix !== "undefined") {
      pattern.setTransform(new DOMMatrix().scale(patScale));
    }
    for (const plate of plates) {
      const { x0, y0, w: rw, h: rh } = plate;
      c.fillStyle = pattern;
      c.fillRect(toX(x0 * ctx.grid), toY(y0 * ctx.grid), rw * ctx.grid * scale, rh * ctx.grid * scale);

      // Eat away the edges so the slab reads as crumbled, not laser-cut
      c.globalCompositeOperation = "destination-out";
      c.filter = `blur(${Math.max(2, Math.round(5 * scale))}px)`;
      const perimeter = [
        ...Array.from({ length: rw + 1 }, (_, i) => ({ x: x0 + i, y: y0 })),
        ...Array.from({ length: rw + 1 }, (_, i) => ({ x: x0 + i, y: y0 + rh })),
        ...Array.from({ length: rh + 1 }, (_, i) => ({ x: x0, y: y0 + i })),
        ...Array.from({ length: rh + 1 }, (_, i) => ({ x: x0 + rw, y: y0 + i }))
      ];
      for (const p of perimeter) {
        if (!ctx.rng.chance(0.55)) continue;
        const r = ctx.rng.float(0.25, 0.8) * ctx.grid * scale;
        c.beginPath();
        c.arc(
          toX((p.x + ctx.rng.float(-0.4, 0.4)) * ctx.grid),
          toY((p.y + ctx.rng.float(-0.4, 0.4)) * ctx.grid),
          r, 0, Math.PI * 2
        );
        c.fill();
      }
      // A few large collapsed bites
      for (let i = 0; i < ctx.rng.int(2, 4); i++) {
        const p = ctx.rng.pick(perimeter);
        const r = ctx.rng.float(1.0, 1.8) * ctx.grid * scale;
        c.beginPath();
        c.arc(toX(p.x * ctx.grid), toY(p.y * ctx.grid), r, 0, Math.PI * 2);
        c.fill();
      }
      c.filter = "none";
      c.globalCompositeOperation = "source-over";
    }
  }

  // --- walls: tiled strip segments along the surviving runs ---
  if (stripList.length) {
    // Prefer materials fitting the biome (earthy/brick for forest, slate for winter)
    const tonePrefer = ctx.presetData?.wallTonePrefer;
    let stripPool = stripList;
    if (tonePrefer) {
      const matched = stripList.filter((e) => tonePrefer.test(e.name.toLowerCase()));
      if (matched.length) stripPool = matched;
    }
    const stripEntry = ctx.rng.pick(stripPool);
    const strip = await loadImage(stripEntry.src);
    // Match broken endings to the wall material (stone wall → stone ending)
    const material = stripEntry.name.toLowerCase().match(/(stone|brick|wood|adobe)/)?.[1];
    // The strip band sits centered with transparent margins; draw so the
    // visible wall is ~0.5 cell thick
    const drawH = 1.4 * ctx.grid * scale;
    const segW = strip.width * (drawH / strip.height);
    for (const run of runs) {
      const len = Math.hypot(run.x2 - run.x1, run.y2 - run.y1) * scale;
      const angle = Math.atan2(run.y2 - run.y1, run.x2 - run.x1);
      c.save();
      c.translate(toX(run.x1), toY(run.y1));
      c.rotate(angle);
      let drawn = 0;
      while (drawn < len) {
        const w = Math.min(segW, len - drawn);
        c.drawImage(strip, 0, 0, strip.width * (w / segW), strip.height, drawn, -drawH / 2, w, drawH);
        drawn += w;
      }
      c.restore();
    }

    // Broken endings cap every run, fade pointing into the collapsed gap
    let endings = ctx.lib.buckets.ruin_wall_ending ?? [];
    if (material) {
      const matched = endings.filter((e) => e.name.toLowerCase().includes(material));
      if (matched.length) endings = matched;
    }
    if (endings.length) {
      const images = await Promise.all(
        endings.slice(0, 4).map((e) => loadImage(e.src).catch(() => null))
      );
      const usable = images.filter(Boolean);
      if (usable.length) {
        const size = 0.9 * ctx.grid * scale;
        for (const run of runs) {
          const angle = Math.atan2(run.y2 - run.y1, run.x2 - run.x1);
          for (const t of [0, 1]) {
            // Source art fades to the left (-X): rotate so the fade points
            // outward past the run end
            const theta = t === 0 ? angle : angle + Math.PI;
            c.save();
            c.translate(toX(t ? run.x2 : run.x1), toY(t ? run.y2 : run.y1));
            c.rotate(theta);
            c.drawImage(ctx.rng.pick(usable), -size / 2, -size / 2, size, size);
            c.restore();
          }
        }
      }
    }
  }

  const blob = await new Promise((resolve) => cnv.toBlob(resolve, "image/webp", 0.85));
  if (!blob) return null;
  const FP = getFilePicker();
  try {
    await FP.createDirectory("data", GENERATED_DIR);
  } catch (error) {
    if (!/EEXIST|already exists/i.test(String(error?.message ?? error))) throw error;
  }
  const file = new File([blob], `ruin-${ctx.seedTag}.webp`, { type: "image/webp" });
  const uploaded = await FP.upload("data", GENERATED_DIR, file, {}, { notify: false });
  return { path: uploaded?.path ?? null, bx, by, bw, bh };
}

/** Broken wall runs (px) along a cell-space segment, with collapse gaps. */
function brokenRuns(ctx, from, to, { minRun = 2.5, maxRun = 6.5, minGap = 1.5, maxGap = 3.5 } = {}) {
  const runs = [];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  let pos = ctx.rng.float(0, 2);
  while (pos < len - 1.5) {
    const runLen = Math.min(len - pos, ctx.rng.float(minRun, maxRun));
    runs.push({
      x1: (from.x + ux * pos) * ctx.grid,
      y1: (from.y + uy * pos) * ctx.grid,
      x2: (from.x + ux * (pos + runLen)) * ctx.grid,
      y2: (from.y + uy * (pos + runLen)) * ctx.grid
    });
    pos += runLen + ctx.rng.float(minGap, maxGap); // gap = collapsed section / doorway
  }
  return runs;
}

async function placeRuins(ctx, plan) {
  const rng = ctx.rng;
  const grid = ctx.grid;
  const { x0, y0, w: rw, h: rh } = plan.rect;
  const plates = [plan.rect, ...(plan.outbuildings ?? [])];

  // Perimeter walls for every plate (main hall + outbuildings)
  const runs = [];
  for (const rect of plates) {
    const corners = [
      { x: rect.x0, y: rect.y0 },
      { x: rect.x0 + rect.w, y: rect.y0 },
      { x: rect.x0 + rect.w, y: rect.y0 + rect.h },
      { x: rect.x0, y: rect.y0 + rect.h }
    ];
    const small = rect !== plan.rect;
    for (let i = 0; i < 4; i++) {
      runs.push(...brokenRuns(ctx, corners[i], corners[(i + 1) % 4],
        small ? { minRun: 1.5, maxRun: 4, minGap: 1.2, maxGap: 2.5 } : {}));
    }
  }

  // Interior rooms: 1-2 half-collapsed dividing walls with wide doorways
  if (plan.mode === "rooms") {
    const vertical = rw >= rh;
    const splitAt = vertical
      ? Math.round(x0 + rw * rng.float(0.35, 0.65))
      : Math.round(y0 + rh * rng.float(0.35, 0.65));
    const roomOpts = { minRun: 2, maxRun: 5, minGap: 2, maxGap: 3.2 };
    if (vertical) runs.push(...brokenRuns(ctx, { x: splitAt, y: y0 }, { x: splitAt, y: y0 + rh }, roomOpts));
    else runs.push(...brokenRuns(ctx, { x: x0, y: splitAt }, { x: x0 + rw, y: splitAt }, roomOpts));

    if (rng.chance(0.6)) {
      // Second split across one of the halves, perpendicular to the first
      if (vertical) {
        const half = rng.chance(0.5)
          ? { a: x0, b: splitAt }
          : { a: splitAt, b: x0 + rw };
        const ySplit = Math.round(y0 + rh * rng.float(0.35, 0.65));
        runs.push(...brokenRuns(ctx, { x: half.a, y: ySplit }, { x: half.b, y: ySplit }, roomOpts));
      } else {
        const half = rng.chance(0.5)
          ? { a: y0, b: splitAt }
          : { a: splitAt, b: y0 + rh };
        const xSplit = Math.round(x0 + rw * rng.float(0.35, 0.65));
        runs.push(...brokenRuns(ctx, { x: xSplit, y: half.a }, { x: xSplit, y: half.b }, roomOpts));
      }
    }
  }

  // Foundry walls block sight/movement along the surviving masonry
  for (const run of runs) {
    ctx.addWall(run.x1, run.y1, run.x2, run.y2);
    markRunCells(ctx, run, OBJ);
  }

  // Painted plates: flagstone floors + wall art in one texture
  let painted = false;
  try {
    const plate = await renderRuinTexture(ctx, { plates, runs });
    if (plate?.path) {
      ctx.addRawTile(plate.path, plate.bx, plate.by, plate.bw, plate.bh, { sort: SORT_FEATURE_BG });
      painted = true;
    }
  } catch (error) {
    console.warn(`${MODULE_ID} | Ruin plate painting failed, falling back to boulders`, error);
  }

  // Fallback: boulder walls (no Core_Settlements pack / no canvas)
  if (!painted) {
    const boulders = ctx.entries(["rocks"], { maxCells: 3, tones: false });
    if (boulders.length) {
      for (const run of runs) {
        const len = Math.hypot(run.x2 - run.x1, run.y2 - run.y1) / grid;
        const ux = (run.x2 - run.x1) / (len * grid);
        const uy = (run.y2 - run.y1) / (len * grid);
        for (let d = 0; d <= len; d += rng.float(0.9, 1.4)) {
          const px = run.x1 + ux * d * grid + rng.float(-0.15, 0.15) * grid;
          const py = run.y1 + uy * d * grid + rng.float(-0.15, 0.15) * grid;
          ctx.addTile(rng.pick(boulders), px, py, {
            scale: rng.float(0.45, 0.75),
            rotation: rng.float(0, 360),
            sort: SORT_MID + Math.round(py / grid),
            shadow: "mid"
          });
        }
      }
    }
  }

  // Rubble spilling into the collapsed gaps (run ends)
  const rubble = ctx.entries(["rubble"], { maxCells: 2, tones: false });
  if (rubble.length) {
    for (const run of runs) {
      if (!rng.chance(0.65)) continue;
      const t = rng.chance(0.5) ? 0 : 1;
      const px = (t ? run.x2 : run.x1) + rng.float(-0.5, 0.5) * grid;
      const py = (t ? run.y2 : run.y1) + rng.float(-0.5, 0.5) * grid;
      ctx.addTile(rng.pick(rubble), px, py, {
        scale: rng.float(0.7, 1.0),
        rotation: rng.float(0, 360),
        sort: SORT_MID + Math.round(py / grid),
        shadow: "mid"
      });
    }
  }

  // Broken pillars inside the hall
  const pillars = ctx.entries(["pillars_broken"], { maxCells: 3, tones: false });
  if (pillars.length) {
    for (let i = 0; i < rng.int(2, 4); i++) {
      const cx = rng.int(x0 + 2, x0 + rw - 2);
      const cy = rng.int(y0 + 2, y0 + rh - 2);
      if (ctx.occ.test(cx, cy, 1, 1, OBJ)) continue;
      ctx.addTile(rng.pick(pillars), (cx + 0.5) * grid, (cy + 0.5) * grid, {
        scale: rng.float(0.9, 1.1),
        rotation: rng.float(0, 360),
        sort: SORT_MID + cy,
        shadow: "mid"
      });
      ctx.occ.mark(cx, cy, 1, 1, OBJ);
    }
  }

  // A cold brazier or fire pit in the middle sells "someone lived here"
  const centerpiece = ctx.rng.pick(ctx.entries(["braziers", "campfires_cold"], { maxCells: 2, tones: false }));
  if (centerpiece && rng.chance(0.7)) {
    const px = (x0 + rw / 2 + rng.float(-2, 2)) * grid;
    const py = (y0 + rh / 2 + rng.float(-2, 2)) * grid;
    ctx.addTile(centerpiece, px, py, { scale: 1, rotation: rng.float(0, 360), sort: SORT_MID + Math.round(py / grid), shadow: "mid" });
    ctx.occ.markCircle(px / grid, py / grid, 1, OBJ);
  }
}

/* ---------------------------- Feature: graveyard -------------------------- */

function placeGraveyard(ctx, rect) {
  const rng = ctx.rng;
  const grid = ctx.grid;
  const gw = rect.w;
  const gh = rect.h;
  const spot = { x0: rect.x0, y0: rect.y0 };

  const stones = ctx.entries(["tombstones"], { maxCells: 2, tones: false });
  if (!stones.length) {
    ctx.missingBuckets.add("tombstones");
    return;
  }
  const piles = ctx.entries(["dirt_piles"], { maxCells: 2, tones: false });

  // Rows of graves: headstone with the grave mound below it
  for (let gy = spot.y0 + 1; gy < spot.y0 + gh - 2; gy += 3) {
    for (let gx = spot.x0 + 1; gx < spot.x0 + gw - 1; gx += 2) {
      if (!rng.chance(0.75)) continue;
      const px = (gx + 0.5 + rng.float(-0.15, 0.15)) * grid;
      const py = (gy + 0.5 + rng.float(-0.1, 0.1)) * grid;
      ctx.addTile(rng.pick(stones), px, py, {
        scale: rng.float(0.85, 1.0),
        rotation: rng.float(-8, 8),
        sort: SORT_MID + gy,
        shadow: "mid"
      });
      if (piles.length && rng.chance(0.8)) {
        ctx.addTile(rng.pick(piles), px, py + 1.1 * grid, {
          scale: rng.float(0.9, 1.05),
          rotation: rng.float(-6, 6),
          sort: SORT_FLAT + 20
        });
      }
      ctx.occ.mark(gx, gy, 1, 2, OBJ);
    }
  }

  // Sarcophagus centerpiece for the family crypt feel
  const sarcophagi = ctx.entries(["sarcophagi"], { maxCells: 3, tones: false });
  if (sarcophagi.length && rng.chance(0.7)) {
    const px = (spot.x0 + gw / 2) * grid;
    const py = (spot.y0 + gh / 2) * grid;
    ctx.addTile(rng.pick(sarcophagi), px, py, {
      scale: 1,
      rotation: rng.pick([0, 90]),
      sort: SORT_MID + Math.round(py / grid),
      shadow: "mid"
    });
    ctx.occ.markCircle(px / grid, py / grid, 1.5, OBJ);
  }
}

/* ------------------------------- Feature: lake --------------------------- */

// Per biome: FA Nexus tiling water/ice texture bucket (`tex`) with an optional
// multiply `tint`; `deep`/`water` are the painted fallback if the texture pack
// isn't installed. `ice` switches the frozen-lake styling on.
const LAKE_STYLE = {
  forest:  { tex: "water_forest", tint: null,      deep: "#173f4a", water: "#2f6b74", edge: "#26331d", ice: false, irregularity: 0.16, shore: "rgba(24,18,9,0.62)", mud: "rgba(30,22,11,0.9)" },
  desert:  { tex: "water_desert", tint: null,      deep: "#0f6472", water: "#2ba0ad", edge: "#7c623a", ice: false, irregularity: 0.16, shore: "rgba(60,44,20,0.42)", mud: "rgba(74,54,26,0.75)" },
  winter:  { tex: "water_ice",    tint: null,      deep: "#6f9aac", water: "#a6cad8", edge: "#456f82", ice: true,  irregularity: 0.13, shore: null },
  // Constructed basin: rectangular, a carved stone lip and a deep inner shadow
  dungeon: { tex: "water_forest", tint: "#2c4a52", deep: "#08131a", water: "#132a33", edge: "#20262c", ice: false, irregularity: 0.05, shape: "rect", shore: "rgba(0,0,0,0.6)", rim: "#5a5f66" }
};

/**
 * Smooth closed blob outline centred in a cw×chh canvas (Path2D). Points on a
 * jittered ellipse are joined with quadratic curves through their midpoints, so
 * there are no sharp corners. `irregularity` 0 = clean ellipse (pool/basin),
 * ~0.16 = natural lake shore. `margin` leaves room for an outer stone rim.
 */
function lakeBlobPath(ctx, cw, chh, irregularity = 0.16, margin = 0.92) {
  const cx = cw / 2, cy = chh / 2;
  const rx = (cw / 2) * margin, ry = (chh / 2) * margin;
  const N = 18;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = 1 - irregularity * 0.5 + ctx.rng.float(0, irregularity);
    pts.push([cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]);
  }
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const path = new Path2D();
  const start = mid(pts[N - 1], pts[0]);
  path.moveTo(start[0], start[1]);
  for (let i = 0; i < N; i++) {
    const cur = pts[i];
    const m = mid(cur, pts[(i + 1) % N]);
    path.quadraticCurveTo(cur[0], cur[1], m[0], m[1]);
  }
  path.closePath();
  return path;
}

/** Rounded-rectangle outline (constructed basin/reservoir) as a Path2D. */
function lakeRectPath(cw, chh, margin = 0.82) {
  const w = cw * margin, h = chh * margin;
  const x = (cw - w) / 2, y = (chh - h) / 2;
  const r = Math.min(w, h) * 0.09;
  const path = new Path2D();
  path.moveTo(x + r, y);
  path.arcTo(x + w, y, x + w, y + h, r);
  path.arcTo(x + w, y + h, x, y + h, r);
  path.arcTo(x, y + h, x, y, r);
  path.arcTo(x, y, x + w, y, r);
  path.closePath();
  return path;
}

/** Paint an irregular water blob (FA Nexus texture, biome-styled) to a webp. */
async function renderLakeTexture(ctx, rect, style, tag) {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  const scale = 0.6;
  const cw = Math.max(16, Math.round(rect.w * ctx.grid * scale));
  const chh = Math.max(16, Math.round(rect.h * ctx.grid * scale));
  const cnv = document.createElement("canvas");
  cnv.width = cw;
  cnv.height = chh;
  const c = cnv.getContext("2d");
  const cx = cw / 2, cy = chh / 2;
  const hasOuter = style.rim || style.mud;
  const margin = hasOuter ? 0.8 : 0.92;
  const path = style.shape === "rect"
    ? lakeRectPath(cw, chh, margin)
    : lakeBlobPath(ctx, cw, chh, style.irregularity ?? 0.16, margin);

  // Wet muddy shore ON THE GROUND: a wide, blurred dark stroke drawn first so
  // the water fill covers its inner half, leaving a dark mud ring around the
  // water where the ground would be churned and damp.
  if (style.mud) {
    c.save();
    c.strokeStyle = style.mud;
    c.lineWidth = Math.max(6, cw * 0.11);
    c.filter = `blur(${Math.max(3, Math.round(cw * 0.02))}px)`;
    c.stroke(path);
    c.filter = "none";
    c.restore();
  }

  // Carved stone lip for a constructed basin (dungeon): a wide stone stroke on
  // the outline, drawn first so the water fill covers its inner half — the
  // outer half reads as a raised rim around the pool.
  if (style.rim) {
    c.save();
    c.lineJoin = "round";
    c.strokeStyle = "#2b2f34";
    c.lineWidth = Math.max(6, cw * 0.075);
    c.stroke(path);
    c.strokeStyle = style.rim;
    c.lineWidth = Math.max(3, cw * 0.045);
    c.stroke(path);
    c.restore();
  }

  // Prefer the FA Nexus tiling water/ice texture (much nicer than a flat fill).
  // Frozen lakes prefer a "cracked" ice variant. Fall back to a painted
  // gradient if the theme pack isn't installed.
  let texList = style.tex ? ctx.lib.buckets[style.tex] : null;
  if (style.ice && texList?.length) {
    const cracked = texList.filter((e) => /crack/i.test(e.name));
    if (cracked.length) texList = cracked;
  }
  const img = texList?.length ? await loadImage(ctx.rng.pick(texList).src) : null;

  if (img) {
    c.save();
    c.clip(path);
    c.fillStyle = c.createPattern(img, "repeat");
    c.fillRect(0, 0, cw, chh);
    if (style.tint) {
      c.globalCompositeOperation = "multiply";
      c.fillStyle = style.tint;
      c.fillRect(0, 0, cw, chh);
      c.globalCompositeOperation = "source-over";
    }
    // Depth vignette (skip for solid ice): darker toward the middle
    if (!style.ice) {
      const g = c.createRadialGradient(cx, cy, Math.min(cw, chh) * 0.5, cx, cy, Math.min(cw, chh) * 0.1);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(0,0,0,0.30)");
      c.fillStyle = g;
      c.fillRect(0, 0, cw, chh);
    }
    c.restore();
  } else {
    const g = c.createRadialGradient(cx, cy, Math.min(cw, chh) * 0.05, cx, cy, Math.max(cw, chh) * 0.55);
    g.addColorStop(0, style.deep);
    g.addColorStop(1, style.water);
    c.fillStyle = g;
    c.fill(path);
  }

  // Dark, wet shoreline: a soft dark band hugging the inner edge (mud / wet
  // sand for a forest pond, a deep-shadow lip for the dungeon basin).
  if (style.shore) {
    c.save();
    c.clip(path);
    c.strokeStyle = style.shore;
    c.lineWidth = Math.max(5, cw * 0.09);
    c.filter = `blur(${Math.max(2, Math.round(cw * 0.012))}px)`;
    c.stroke(path);
    c.filter = "none";
    c.restore();
  }

  // Procedural surface detail — only for the painted fallback; the real
  // texture already carries its own ripples/cracks and doesn't need more.
  if (!img) {
  c.save();
  c.clip(path);
  if (style.ice) {
    for (let k = 0; k < 10; k++) {
      const bx = ctx.rng.float(0, cw), by = ctx.rng.float(0, chh);
      const r = ctx.rng.float(cw * 0.05, cw * 0.18);
      c.fillStyle = `rgba(255,255,255,${ctx.rng.float(0.05, 0.14).toFixed(3)})`;
      c.beginPath(); c.arc(bx, by, r, 0, Math.PI * 2); c.fill();
    }
    // Fracture lines
    c.strokeStyle = "rgba(255,255,255,0.55)";
    c.lineWidth = Math.max(1, cw * 0.004);
    for (let k = 0; k < 7; k++) {
      let x = ctx.rng.float(cw * 0.2, cw * 0.8), y = ctx.rng.float(chh * 0.2, chh * 0.8);
      c.beginPath(); c.moveTo(x, y);
      for (let s = 0, segs = ctx.rng.int(2, 4); s < segs; s++) {
        x += ctx.rng.float(-cw * 0.2, cw * 0.2); y += ctx.rng.float(-chh * 0.2, chh * 0.2);
        c.lineTo(x, y);
      }
      c.stroke();
    }
  } else {
    // Dark depth blotches (never lighten — reads as pale artefacts)
    for (let k = 0; k < 14; k++) {
      const bx = ctx.rng.float(0, cw), by = ctx.rng.float(0, chh);
      const r = ctx.rng.float(cw * 0.04, cw * 0.16);
      c.fillStyle = `rgba(0,0,0,${ctx.rng.float(0.04, 0.12).toFixed(3)})`;
      c.beginPath(); c.arc(bx, by, r, 0, Math.PI * 2); c.fill();
    }
    // Faint highlight ripples
    c.strokeStyle = "rgba(255,255,255,0.10)";
    c.lineWidth = Math.max(1, cw * 0.003);
    for (let k = 0; k < 8; k++) {
      const bx = ctx.rng.float(cw * 0.15, cw * 0.85), by = ctx.rng.float(chh * 0.15, chh * 0.85);
      const rr = ctx.rng.float(cw * 0.05, cw * 0.14);
      c.beginPath(); c.arc(bx, by, rr, ctx.rng.float(0, 3), ctx.rng.float(3, 6)); c.stroke();
    }
  }
  c.restore();
  }

  // Shore / shallow rim
  c.strokeStyle = style.edge;
  c.lineWidth = Math.max(2, cw * 0.03);
  c.globalAlpha = style.ice ? 0.45 : 0.3;
  c.stroke(path);
  c.globalAlpha = 1;

  const blob = await new Promise((resolve) => cnv.toBlob(resolve, "image/webp", 0.85));
  if (!blob) return null;
  const FP = getFilePicker();
  try {
    await FP.createDirectory("data", GENERATED_DIR);
  } catch (error) {
    if (!/EEXIST|already exists/i.test(String(error?.message ?? error))) throw error;
  }
  const file = new File([blob], `lake-${tag}-${ctx.seedTag}.webp`, { type: "image/webp" });
  const uploaded = await FP.upload("data", GENERATED_DIR, file, {}, { notify: false });
  return uploaded?.path ?? null;
}

/**
 * Surface lake feature: a forest pond, a desert oasis (palm ring) or a frozen
 * winter lake. Water is painted, its footprint reserved so nothing scatters on
 * it. (The dungeon's central lake is handled inside buildDungeon.)
 */
async function placeLake(ctx, plan) {
  const rect = plan.rect;
  const grid = ctx.grid;
  const variant = ctx.presetData?.tags?.biome ?? "forest";
  const style = LAKE_STYLE[variant] ?? LAKE_STYLE.forest;

  const src = await renderLakeTexture(ctx, rect, style, variant);
  if (src) ctx.addRawTile(src, rect.x0 * grid, rect.y0 * grid, rect.w * grid, rect.h * grid, { sort: SORT_FEATURE_BG + 5 });

  const cx = rect.x0 + rect.w / 2, cy = rect.y0 + rect.h / 2;
  const rxCells = rect.w / 2, ryCells = rect.h / 2;

  if (variant === "forest") {
    // Lilypads floating on the surface (kept well inside the waterline)
    const pads = ctx.entries(["lilypads", "water_plants"], { maxCells: 3, tones: false });
    if (pads.length) {
      const n = Math.max(2, Math.round((rect.w * rect.h) / 45));
      for (let i = 0; i < n; i++) {
        const a = ctx.rng.float(0, Math.PI * 2), rr = Math.sqrt(ctx.rng.random()) * 0.58;
        const gx = (cx + Math.cos(a) * rxCells * rr) * grid;
        const gy = (cy + Math.sin(a) * ryCells * rr) * grid;
        ctx.addTile(ctx.rng.pick(pads), gx, gy, { scale: ctx.rng.float(0.55, 1.0), rotation: ctx.rng.float(0, 360), sort: SORT_FLAT + 30 });
      }
    }
  } else if (variant === "desert") {
    // Oasis: a ring of palms just past the shore
    const palms = ctx.entries(["trees_palm"], { maxCells: 6, tones: false });
    if (palms.length) {
      const n = ctx.rng.int(3, 5);
      const a0 = ctx.rng.float(0, Math.PI * 2);
      for (let i = 0; i < n; i++) {
        const a = a0 + (i / n) * Math.PI * 2 + ctx.rng.float(-0.3, 0.3);
        const pcx = cx + Math.cos(a) * (rxCells + 1.2);
        const pcy = cy + Math.sin(a) * (ryCells + 1.2);
        if (pcx < 1 || pcy < 1 || pcx > ctx.cellsW - 1 || pcy > ctx.cellsH - 1) continue;
        const entry = ctx.rng.pick(palms);
        ctx.addTile(entry, pcx * grid, pcy * grid, {
          scale: ctx.rng.float(0.9, 1.1),
          rotation: ctx.rng.float(-12, 12),
          sort: SORT_TALL + Math.round(pcy),
          shadow: "tall"
        });
        ctx.occ.markCircle(pcx, pcy, 1, OBJ);
      }
    }
  }

  // Cattails / reeds (Рогоз/камыш) standing at the shoreline, in a few clumps
  // straddling the waterline. Water reaches ~80% of the rect half-extent.
  if (variant === "forest" || variant === "desert") {
    let reeds = ctx.entries(["cattails"], { maxCells: 2, tones: false });
    const natural = reeds.filter((e) => !e.tones?.includes("exotic"));
    if (natural.length >= 3) reeds = natural;
    if (reeds.length) {
      const clusters = ctx.rng.int(4, 7);
      for (let cl = 0; cl < clusters; cl++) {
        const a = ctx.rng.float(0, Math.PI * 2);
        for (let j = 0, clumps = ctx.rng.int(2, 4); j < clumps; j++) {
          const rr = 0.8 * ctx.rng.float(0.9, 1.08);
          const aa = a + ctx.rng.float(-0.18, 0.18);
          const gx = cx + Math.cos(aa) * rxCells * rr;
          const gy = cy + Math.sin(aa) * ryCells * rr;
          if (gx < 0.5 || gy < 0.5 || gx > ctx.cellsW - 0.5 || gy > ctx.cellsH - 0.5) continue;
          ctx.addTile(ctx.rng.pick(reeds), gx * grid, gy * grid, {
            scale: ctx.rng.float(0.8, 1.15),
            rotation: ctx.rng.float(-10, 10),
            sort: SORT_TALL + Math.round(gy),
            shadow: "mid"
          });
        }
      }
    }
  }

  // Reserve the water footprint so scatter / roads keep off it
  ctx.occ.mark(rect.x0, rect.y0, rect.w, rect.h, RESERVED | OBJ);
}

/* ----------------------------- Feature: building ------------------------- */

/**
 * Bake a building's SHELL (tiled wood floor + masonry walls) into one webp, the
 * exact same way the dungeon does it: the wall strip is tiled along each run at
 * its NATIVE aspect (no stretch) with 45° mitred corners, so the wall reads as
 * one monolithic run at the right brick size instead of stretched tile segments.
 * `preset.shell = { floorSrc, wallSrc, runs:[[x1,y1,x2,y2]...], floorRect?, wallThick? }`
 * in author px (relative to the preset origin).
 */
async function renderBuildingShell(ctx, preset, rectX0, rectY0) {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  const shell = preset.shell;
  if (!shell?.floorSrc || !shell?.wallSrc || !shell?.runs?.length) return null;

  const sA = ctx.grid / (preset.gridSize || ctx.grid);   // author px -> scene px
  const pxW = preset.cellsW * ctx.grid;
  const pxH = preset.cellsH * ctx.grid;
  const rScale = Math.min(1, 2200 / Math.max(pxW, pxH));
  const k = sA * rScale;                                  // author px -> canvas px
  const cs = ctx.grid * rScale;                           // one cell in canvas px
  const cnv = document.createElement("canvas");
  cnv.width = Math.max(8, Math.round(pxW * rScale));
  cnv.height = Math.max(8, Math.round(pxH * rScale));
  const c = cnv.getContext("2d");

  // --- floor: tiled wood at native scale ---
  try {
    const floorImg = await loadImage(shell.floorSrc);
    const pattern = c.createPattern(floorImg, "repeat");
    const patScale = (3 * cs) / floorImg.width;
    if (pattern.setTransform && typeof DOMMatrix !== "undefined") pattern.setTransform(new DOMMatrix().scale(patScale));
    c.fillStyle = pattern;
    const fr = shell.floorRect ? shell.floorRect.map((v) => v * k) : [0, 0, cnv.width, cnv.height];
    c.fillRect(fr[0], fr[1], fr[2], fr[3]);
  } catch (e) {
    console.warn(`${MODULE_ID} | building floor render failed`, e);
  }

  // --- walls: strip tiled along runs, native aspect, mitred corners ---
  try {
    const strip = await loadImage(shell.wallSrc);
    const drawH = (shell.wallThick ?? 1.2) * cs;
    const H2 = drawH / 2;
    const segW = strip.width * (drawH / strip.height);
    const runs = shell.runs.map(([x1, y1, x2, y2]) => ({ x1: x1 * k, y1: y1 * k, x2: x2 * k, y2: y2 * k }));
    const pointKey = (x, y) => `${Math.round(x)},${Math.round(y)}`;
    const endpoints = new Map();
    for (const run of runs) for (const end of [0, 1]) {
      const kk = pointKey(end ? run.x2 : run.x1, end ? run.y2 : run.y1);
      if (!endpoints.has(kk)) endpoints.set(kk, []);
      endpoints.get(kk).push({ run, end });
    }
    const joinTurn = (run, end, angle) => {
      const kk = pointKey(end ? run.x2 : run.x1, end ? run.y2 : run.y1);
      const list = endpoints.get(kk);
      if (!list || list.length !== 2) return null;
      const other = list.find((e) => e.run !== run);
      if (!other) return null;
      const o = other.run;
      const olen = Math.hypot(o.x2 - o.x1, o.y2 - o.y1) || 1;
      let dx = (o.x2 - o.x1) / olen, dy = (o.y2 - o.y1) / olen;
      if (other.end === 1) { dx = -dx; dy = -dy; }
      const localY = -dx * Math.sin(angle) + dy * Math.cos(angle);
      if (Math.abs(localY) < 0.5) return null;
      return Math.sign(localY);
    };
    for (const run of runs) {
      const fullLen = Math.hypot(run.x2 - run.x1, run.y2 - run.y1);
      const angle = Math.atan2(run.y2 - run.y1, run.x2 - run.x1);
      const ts = joinTurn(run, 0, angle), te = joinTurn(run, 1, angle);
      c.save();
      c.translate(run.x1, run.y1);
      c.rotate(angle);
      const sTopX = ts ? -ts * H2 : 0, sBotX = ts ? ts * H2 : 0;
      const eTopX = fullLen + (te ? te * H2 : 0), eBotX = fullLen - (te ? te * H2 : 0);
      c.beginPath();
      c.moveTo(sTopX, -H2); c.lineTo(eTopX, -H2); c.lineTo(eBotX, H2); c.lineTo(sBotX, H2); c.closePath();
      c.clip();
      let drawn = -H2; const limit = fullLen + H2;
      while (drawn < limit) {
        const w = Math.min(segW, limit - drawn);
        c.drawImage(strip, 0, 0, strip.width * (w / segW), strip.height, drawn, -H2, w, drawH);
        drawn += w;
      }
      c.restore();
    }
  } catch (e) {
    console.warn(`${MODULE_ID} | building wall render failed`, e);
  }

  const blob = await new Promise((r) => cnv.toBlob(r, "image/webp", 0.9));
  if (!blob) return null;
  const FP = getFilePicker();
  try {
    await FP.createDirectory("data", GENERATED_DIR);
  } catch (error) {
    if (!/EEXIST|already exists/i.test(String(error?.message ?? error))) throw error;
  }
  const tag = (preset.name || "house").replace(/[^\w-]+/g, "_");
  const file = new File([blob], `building-${tag}-${ctx.seedTag}.webp`, { type: "image/webp" });
  const uploaded = await FP.upload("data", GENERATED_DIR, file, {}, { notify: false });
  return uploaded?.path ?? null;
}

/**
 * Place a user-authored building preset. If it carries a `shell` spec, the
 * floor+walls are baked into one texture (monolithic, native-scale masonry —
 * same look as the dungeon); the preset's own tiles are then just furniture,
 * placed on top, with its Foundry walls and lights.
 */
async function placeBuilding(ctx, plan) {
  const { rect, preset } = plan;
  const grid = ctx.grid;
  if (preset.shell) {
    try {
      const src = await renderBuildingShell(ctx, preset, rect.x0, rect.y0);
      if (src) ctx.addRawTile(src, rect.x0 * grid, rect.y0 * grid, preset.cellsW * grid, preset.cellsH * grid, { sort: SORT_FEATURE_BG });
    } catch (e) {
      console.warn(`${MODULE_ID} | building shell failed`, e);
    }
  }
  ctx.placeProp(preset, rect.x0, rect.y0, 0);
  ctx.occ.mark(rect.x0, rect.y0, preset.cellsW, preset.cellsH, RESERVED | OBJ);
}

/* ------------------------------ Feature: tavern --------------------------- */

async function placeTavern(ctx, planRect) {
  const rng = ctx.rng;
  const grid = ctx.grid;
  const tavern = ctx.lib.tavern;

  // The footprint was planned (and reserved) before the road was routed
  const rect = {
    x: planRect.x0 * grid,
    y: planRect.y0 * grid,
    w: planRect.w * grid,
    h: planRect.h * grid
  };
  if (tavern.bg) {
    ctx.addRawTile(tavern.bg, rect.x, rect.y, rect.w, rect.h, { sort: SORT_FEATURE_BG });
    for (const src of tavern.lightsOn) ctx.addRawTile(src, rect.x, rect.y, rect.w, rect.h, { sort: SORT_OVERLAY });
    if (tavern.roof) ctx.addRawTile(tavern.roof, rect.x, rect.y, rect.w, rect.h, { sort: SORT_ROOF, hidden: true });
  }

  // Perimeter walls with a 2-cell door centered on the south side
  const doorW = 2 * grid;
  const doorX0 = rect.x + rect.w / 2 - doorW / 2;
  const bottom = rect.y + rect.h;
  ctx.addWall(rect.x, rect.y, rect.x + rect.w, rect.y);
  ctx.addWall(rect.x + rect.w, rect.y, rect.x + rect.w, bottom);
  ctx.addWall(rect.x, rect.y, rect.x, bottom);
  ctx.addWall(rect.x, bottom, doorX0, bottom);
  ctx.addWall(doorX0, bottom, doorX0 + doorW, bottom, { door: 1 });
  ctx.addWall(doorX0 + doorW, bottom, rect.x + rect.w, bottom);

  // Interior furnishing on a simple cell grid inside the walls
  const inset = 2;
  const ix0 = Math.ceil(rect.x / grid) + inset;
  const iy0 = Math.ceil(rect.y / grid) + inset;
  const ix1 = Math.floor((rect.x + rect.w) / grid) - inset;
  const iy1 = Math.floor((rect.y + rect.h) / grid) - inset;
  if (ix1 - ix0 < 6 || iy1 - iy0 < 5) return;

  // Bar counter along the north wall
  const counters = ctx.entries(["counters"], { maxCells: 8, minW: 3, tones: false });
  if (counters.length) {
    const entry = rng.pick(counters);
    const px = (ix0 + entry.w / 2 + rng.float(0, Math.max(0, ix1 - ix0 - entry.w))) * grid;
    const py = (iy0 + entry.h / 2) * grid;
    ctx.addTile(entry, px, py, { scale: 1, rotation: 0, sort: SORT_MID + iy0, shadow: "mid" });
    ctx.occ.mark(Math.round(px / grid - entry.w / 2), iy0, entry.w, entry.h, OBJ);
  }

  // Tables with chairs and candles
  const tables = ctx.entries(["tables"], { maxCells: 3, tones: false });
  const chairs = ctx.entries(["seating"], { maxCells: 1, tones: false });
  const candles = ctx.entries(["candles"], { maxCells: 1, tones: false });
  if (tables.length) {
    const cols = Math.max(2, Math.floor((ix1 - ix0) / 5));
    const rows = Math.max(1, Math.floor((iy1 - iy0 - 2) / 5));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!rng.chance(0.8)) continue;
        const entry = rng.pick(tables);
        const cellX = ix0 + 1 + Math.round((c + 0.5) * (ix1 - ix0 - 2) / cols);
        const cellY = iy0 + 2 + Math.round((r + 0.5) * (iy1 - iy0 - 3) / rows);
        if (ctx.occ.test(cellX - 1, cellY - 1, entry.w + 1, entry.h + 1, OBJ)) continue;
        const px = cellX * grid;
        const py = cellY * grid;
        ctx.addTile(entry, px, py, { scale: 1, rotation: rng.pick([0, 90]), sort: SORT_MID + cellY, shadow: "mid" });
        ctx.occ.mark(cellX - Math.floor(entry.w / 2), cellY - Math.floor(entry.h / 2), entry.w, entry.h, OBJ);

        // Chairs around the table, turned to face it
        if (chairs.length) {
          const reach = (Math.max(entry.w, entry.h) / 2 + 0.6) * grid;
          for (const [ox, oy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
            if (!rng.chance(0.7)) continue;
            const chairX = px + ox * reach;
            const chairY = py + oy * reach;
            const facing = Math.atan2(py - chairY, px - chairX) * 180 / Math.PI - 90;
            ctx.addTile(rng.pick(chairs), chairX, chairY, {
              scale: rng.float(0.9, 1.0),
              rotation: facing + rng.float(-8, 8),
              sort: SORT_MID + Math.round(chairY / grid),
              shadow: "mid"
            });
          }
        }

        // Candle + tiny light on some tables
        if (candles.length && rng.chance(0.6)) {
          ctx.addTile(rng.pick(candles), px, py, { scale: 0.5, rotation: rng.float(0, 360), sort: SORT_MID + cellY + 1 });
          ctx.addLight(px, py, {
            brightCells: 0.5, dimCells: 2, color: "#ffc87a", alpha: 0.4,
            animation: { type: "torch", speed: 2, intensity: 2 }
          });
        }
      }
    }
  }

  // Barrel corner
  const supplies = ctx.entries(["barrels", "crates"], { maxCells: 2, tones: false });
  if (supplies.length) {
    const cornerX = rng.chance(0.5) ? ix0 + 1 : ix1 - 1;
    const cornerY = iy1 - 1;
    for (let i = 0; i < rng.int(3, 5); i++) {
      const px = (cornerX + rng.float(-1.2, 1.2)) * grid;
      const py = (cornerY + rng.float(-1.2, 0.4)) * grid;
      ctx.addTile(rng.pick(supplies), px, py, { scale: rng.float(0.75, 0.95), rotation: rng.float(0, 360), sort: SORT_MID + Math.round(py / grid), shadow: "mid" });
    }
  }

  // Two hearth lights so the room is playable even without the overlay art
  ctx.addLight(rect.x + rect.w * 0.3, rect.y + rect.h * 0.45, { brightCells: 3, dimCells: 7, color: "#ffb45e", animation: { type: "torch", speed: 2, intensity: 2 } });
  ctx.addLight(rect.x + rect.w * 0.7, rect.y + rect.h * 0.55, { brightCells: 3, dimCells: 7, color: "#ffb45e", animation: { type: "torch", speed: 2, intensity: 2 } });
}

/* -------------------------------- Dungeon -------------------------------- */

/**
 * Room-and-corridor dungeon layout on a cell grid.
 * Returns { floor (Uint8Array: 0 void, 1 room, 2 corridor), rooms }.
 */
function layoutDungeon(ctx) {
  const W = ctx.cellsW;
  const H = ctx.cellsH;
  const floor = new Uint8Array(W * H);
  const at = (x, y) => floor[y * W + x];
  const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < W && y < H) floor[y * W + x] = v; };

  // Rooms: random rects with a 2-cell gap between them
  const target = Math.max(4, Math.min(12, Math.round((W * H) / 110)));
  const rooms = [];
  for (let attempt = 0; attempt < 300 && rooms.length < target; attempt++) {
    const w = ctx.rng.int(4, 9);
    const h = ctx.rng.int(4, 8);
    const x = ctx.rng.int(1, W - w - 1);
    const y = ctx.rng.int(1, H - h - 1);
    const clash = rooms.some((r) =>
      x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y);
    if (clash) continue;
    rooms.push({ x, y, w, h, cx: x + Math.floor(w / 2), cy: y + Math.floor(h / 2) });
  }
  for (const r of rooms) {
    for (let yy = r.y; yy < r.y + r.h; yy++) for (let xx = r.x; xx < r.x + r.w; xx++) set(xx, yy, 1);
  }

  // Corridors: connect each unconnected room to the closest connected one (MST-lite)
  const carveCorridor = (ax, ay, bx, by) => {
    const xDir = bx >= ax ? 1 : -1;
    for (let x = ax; x !== bx + xDir; x += xDir) {
      for (const yy of [ay, ay + 1]) if (!at(x, yy)) set(x, yy, 2);
    }
    const yDir = by >= ay ? 1 : -1;
    for (let y = ay; y !== by + yDir; y += yDir) {
      for (const xx of [bx, bx + 1]) if (!at(xx, y)) set(xx, y, 2);
    }
  };
  const connected = [rooms[0]];
  const remaining = rooms.slice(1);
  while (remaining.length) {
    let best = null;
    for (const q of remaining) {
      for (const r of connected) {
        const d = Math.hypot(q.cx - r.cx, q.cy - r.cy);
        if (!best || d < best.d) best = { q, r, d };
      }
    }
    carveCorridor(best.r.cx, best.r.cy, best.q.cx, best.q.cy);
    connected.push(best.q);
    remaining.splice(remaining.indexOf(best.q), 1);
  }

  // Fill small void pockets enclosed by floor (they render as odd walled
  // rectangles in the middle of corridors otherwise)
  const reached = new Uint8Array(W * H);
  const stack = [];
  for (let x = 0; x < W; x++) { stack.push([x, 0], [x, H - 1]); }
  for (let y = 0; y < H; y++) { stack.push([0, y], [W - 1, y]); }
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = y * W + x;
    if (reached[i] || floor[i]) continue;
    reached[i] = 1;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  // Every enclosed void becomes floor — walled-off phantom rectangles
  // in the middle of the dungeon confuse everyone
  for (let i = 0; i < W * H; i++) {
    if (!floor[i] && !reached[i]) floor[i] = 2;
  }

  return { floor, rooms };
}

/** Boundary walls between floor and void, merged into straight runs (px). */
function extractWallRuns(ctx, floor) {
  const W = ctx.cellsW;
  const H = ctx.cellsH;
  const isFloor = (x, y) => x >= 0 && y >= 0 && x < W && y < H && floor[y * W + x] > 0;
  const runs = [];

  // Horizontal wall lines (edges between vertically adjacent cells)
  for (let y = 0; y <= H; y++) {
    let start = -1;
    for (let x = 0; x <= W; x++) {
      const boundary = x < W && (isFloor(x, y - 1) !== isFloor(x, y));
      if (boundary && start < 0) start = x;
      if (!boundary && start >= 0) {
        runs.push({ x1: start * ctx.grid, y1: y * ctx.grid, x2: x * ctx.grid, y2: y * ctx.grid });
        start = -1;
      }
    }
  }
  // Vertical wall lines
  for (let x = 0; x <= W; x++) {
    let start = -1;
    for (let y = 0; y <= H; y++) {
      const boundary = y < H && (isFloor(x - 1, y) !== isFloor(x, y));
      if (boundary && start < 0) start = y;
      if (!boundary && start >= 0) {
        runs.push({ x1: x * ctx.grid, y1: start * ctx.grid, x2: x * ctx.grid, y2: y * ctx.grid });
        start = -1;
      }
    }
  }
  return runs;
}

/** Paint the whole dungeon (floor cells + wall strips) into one texture. */
async function renderDungeonTexture(ctx, floor, runs) {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  const floorList = ctx.lib.buckets.ruin_floor_tex ?? [];
  if (!floorList.length) return null;

  const W = ctx.cellsW;
  const H = ctx.cellsH;
  const scale = Math.min(1, 2200 / Math.max(ctx.pxW(), ctx.pxH()));
  const cnv = document.createElement("canvas");
  cnv.width = Math.round(ctx.pxW() * scale);
  cnv.height = Math.round(ctx.pxH() * scale);
  const c = cnv.getContext("2d");

  const floorEntry = ctx.rng.pick(floorList);
  ctx.dungeonFloorName = floorEntry.name.toLowerCase();
  const img = await loadImage(floorEntry.src);
  const pattern = c.createPattern(img, "repeat");
  const patScale = (7 * ctx.grid * scale) / img.width;
  if (pattern.setTransform && typeof DOMMatrix !== "undefined") {
    pattern.setTransform(new DOMMatrix().scale(patScale));
  }
  c.fillStyle = pattern;
  const cs = ctx.grid * scale;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (floor[y * W + x]) c.fillRect(x * cs - 0.5, y * cs - 0.5, cs + 1, cs + 1);
    }
  }

  // Dark mottling so the stone is not sterile
  c.globalCompositeOperation = "source-atop";
  c.filter = `blur(${Math.max(3, Math.round(9 * scale))}px)`;
  const blotches = Math.round((W * H) / 18);
  for (let k = 0; k < blotches; k++) {
    const x = ctx.rng.float(0, W) * cs;
    const y = ctx.rng.float(0, H) * cs;
    const r = ctx.rng.float(0.5, 1.6) * cs;
    c.fillStyle = `rgba(10, 10, 14, ${ctx.rng.float(0.05, 0.14).toFixed(3)})`;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }
  c.filter = "none";
  c.globalCompositeOperation = "source-over";

  // Wall strips along the boundary with 45° mitred corners: where two runs
  // share an endpoint, each strip extends past the corner and is clipped by
  // the diagonal through the corner point — the FA-style clean picture-frame
  // joint instead of chopped butt ends.
  const stripList = ctx.lib.buckets.ruin_wall_strip ?? [];
  if (stripList.length) {
    const tonePrefer = ctx.presetData?.wallTonePrefer;
    let pool = stripList;
    if (tonePrefer) {
      const matched = stripList.filter((e) => tonePrefer.test(e.name.toLowerCase()));
      if (matched.length) pool = matched;
    }
    const strip = await loadImage(ctx.rng.pick(pool).src);
    const drawH = 1.3 * cs;
    const H2 = drawH / 2;
    const segW = strip.width * (drawH / strip.height);

    const pointKey = (x, y) => `${Math.round(x)},${Math.round(y)}`;
    const endpoints = new Map();
    for (const run of runs) {
      for (const end of [0, 1]) {
        const k = pointKey(end ? run.x2 : run.x1, end ? run.y2 : run.y1);
        if (!endpoints.has(k)) endpoints.set(k, []);
        endpoints.get(k).push({ run, end });
      }
    }

    // Which side does the joining run leave toward, in this run's local frame?
    const joinTurn = (run, end, angle) => {
      const k = pointKey(end ? run.x2 : run.x1, end ? run.y2 : run.y1);
      const list = endpoints.get(k);
      if (list.length !== 2) return null; // opening or T-junction: flat end
      const other = list.find((e) => e.run !== run);
      if (!other) return null;
      const o = other.run;
      const olen = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
      let dx = (o.x2 - o.x1) / olen;
      let dy = (o.y2 - o.y1) / olen;
      if (other.end === 1) { dx = -dx; dy = -dy; } // away from the corner
      const localY = -dx * Math.sin(angle) + dy * Math.cos(angle);
      if (Math.abs(localY) < 0.5) return null; // collinear continuation
      return Math.sign(localY);
    };

    for (const run of runs) {
      const fullLen = Math.hypot(run.x2 - run.x1, run.y2 - run.y1) * scale;
      const angle = Math.atan2(run.y2 - run.y1, run.x2 - run.x1);
      const ts = joinTurn(run, 0, angle);
      const te = joinTurn(run, 1, angle);

      c.save();
      c.translate(run.x1 * scale, run.y1 * scale);
      c.rotate(angle);

      // Clip polygon: flat edges at openings, 45° diagonals through corners
      const sTopX = ts ? -ts * H2 : 0;
      const sBotX = ts ? ts * H2 : 0;
      const eTopX = fullLen + (te ? te * H2 : 0);
      const eBotX = fullLen - (te ? te * H2 : 0);
      c.beginPath();
      c.moveTo(sTopX, -H2);
      c.lineTo(eTopX, -H2);
      c.lineTo(eBotX, H2);
      c.lineTo(sBotX, H2);
      c.closePath();
      c.clip();

      // Tile the strip across the full extended span; the clip shapes the ends
      let drawn = -H2;
      const limit = fullLen + H2;
      while (drawn < limit) {
        const w = Math.min(segW, limit - drawn);
        c.drawImage(strip, 0, 0, strip.width * (w / segW), strip.height, drawn, -H2, w, drawH);
        drawn += w;
      }
      c.restore();
    }
  }

  const blob = await new Promise((resolve) => cnv.toBlob(resolve, "image/webp", 0.85));
  if (!blob) return null;
  const FP = getFilePicker();
  try {
    await FP.createDirectory("data", GENERATED_DIR);
  } catch (error) {
    if (!/EEXIST|already exists/i.test(String(error?.message ?? error))) throw error;
  }
  const file = new File([blob], `dungeon-${ctx.seedTag}.webp`, { type: "image/webp" });
  const uploaded = await FP.upload("data", GENERATED_DIR, file, {}, { notify: false });
  return uploaded?.path ?? null;
}

// The three chest states the user picked (Item Piles: closed / opened-with-loot
// / opened-empty). Chest SFX ship with the module.
const CHEST_CLOSED = "Treasure_Chest_Wood_Ashen_A1_1x1.webp";
const CHEST_OPENED = "Treasure_Chest_Wood_Ashen_A1_Coins_Mixed_1x1.webp";
const CHEST_EMPTY  = "Treasure_Chest_Wood_Ashen_A1_Rusty_Empty_A_1x1.webp";
const CHEST_SFX_OPEN = `modules/${MODULE_ID}/sounds/chest-open.mp3`;
const CHEST_SFX_CLOSE = `modules/${MODULE_ID}/sounds/chest-close.mp3`;

/**
 * Resolve the chosen closed / opened / empty chest art from the
 * `treasure_chests` bucket. Falls back to any closed + any empty-open if the
 * exact files aren't there.
 */
function pickChestImages(ctx) {
  const all = ctx.lib.buckets?.treasure_chests ?? [];
  if (all.length) {
    const byName = (n) => all.find((e) => e.name === n)?.src;
    const closed = byName(CHEST_CLOSED);
    const open = byName(CHEST_OPENED);
    const empty = byName(CHEST_EMPTY);
    if (closed && open && empty) return { closed, open, empty };
    // Partial: derive from whatever chests the bucket does have
    const isOpen = (e) => /_empty_|_coins_/i.test(e.name);
    const c = closed ?? all.find((e) => !isOpen(e) && !/false_bottom/i.test(e.name))?.src;
    const o = open ?? all.find((e) => /_coins_/i.test(e.name))?.src;
    const em = empty ?? all.find((e) => /_empty_/i.test(e.name))?.src;
    if (c && (o || em)) return { closed: c, open: o ?? em, empty: em ?? o };
  }
  // Bucket empty (assets not rescanned after the update?): build the standard
  // baileywiki chest paths straight from the library root so treasure still
  // works without a manual rescan.
  const root = ctx.lib.root;
  if (root) {
    const dir = `${root}/Decor/Storage/Chests/Treasure_Chests`;
    return { closed: `${dir}/${CHEST_CLOSED}`, open: `${dir}/${CHEST_OPENED}`, empty: `${dir}/${CHEST_EMPTY}` };
  }
  return null;
}

/**
 * Spawn the recorded treasure chest after the scene exists. With Item Piles it
 * becomes a clickable container (closed/open art + loot the DM can fill); without
 * it, a plain closed-chest tile plus a hint to install Item Piles.
 */
async function placeTreasureChest(ctx, scene, ox, oy) {
  const spot = ctx.treasureSpot;
  if (!spot) return;
  const grid = ctx.grid;
  const px = spot.x * grid + ox;
  const py = spot.y * grid + oy;
  const ipActive = game.modules.get("item-piles")?.active;
  const api = ipActive ? game.itempiles?.API : null;
  console.info(`${MODULE_ID} | Treasure chest @ cell (${spot.x},${spot.y}), Item Piles active=${!!ipActive}, API=${!!api?.createItemPile}`, spot);
  if (api?.createItemPile) {
    try {
      const containerFlags = {
        type: "container",
        closed: true,
        closedImage: spot.closed,   // lid down
        openedImage: spot.open,     // opened, still has loot
        emptyImage: spot.empty,     // opened, emptied out
        lockedImage: spot.closed,
        openSound: CHEST_SFX_OPEN,
        closeSound: CHEST_SFX_CLOSE
      };
      await api.createItemPile({
        sceneId: scene.id,
        position: { x: px, y: py },
        createActor: true,
        // No `type` override — Item Piles makes its own default pile actor, and
        // changing a document's type via update is rejected by Foundry. The
        // container behaviour comes from itemPileFlags, not the actor type.
        actorOverrides: { name: i18n("Treasure.Name") },
        // displayName OWNER (40): only owners (the GM) see the nameplate.
        tokenOverrides: {
          name: i18n("Treasure.Name"),
          displayName: CONST.TOKEN_DISPLAY_MODES.OWNER,
          width: 1, height: 1,
          rotation: spot.rotation ?? 0,
          texture: { src: spot.closed }
        },
        itemPileFlags: containerFlags
      });
      return;
    } catch (error) {
      console.error(`${MODULE_ID} | Item Piles chest failed, falling back to a plain tile`, error);
    }
  }
  await scene.createEmbeddedDocuments("Tile", [{
    texture: { src: spot.closed, anchorX: 0, anchorY: 0 },
    x: px, y: py, width: grid, height: grid, rotation: spot.rotation ?? 0, sort: SORT_MID,
    flags: { [MODULE_ID]: { generated: true } }
  }]);
  if (!ipActive) ui.notifications.info(i18n("Notifications.TreasureNeedsItemPiles"));
}

async function buildDungeon(ctx) {
  const rng = ctx.rng;
  const grid = ctx.grid;
  const W = ctx.cellsW;
  const H = ctx.cellsH;
  const { floor, rooms } = layoutDungeon(ctx);
  const isFloor = (x, y) => x >= 0 && y >= 0 && x < W && y < H && floor[y * W + x] > 0;

  // Floor cells are the "inside" for scatter defs; void stays empty
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (floor[y * W + x]) ctx.occ.mark(x, y, 1, 1, RESERVED);
    }
  }

  // Foundry walls along the floor boundary
  const runs = extractWallRuns(ctx, floor);
  for (const run of runs) ctx.addWall(run.x1, run.y1, run.x2, run.y2);

  // Doors where corridors enter rooms (opening width <= 3 cells)
  for (const r of rooms) {
    const edges = [
      { horizontal: true, line: r.y, ox: 0, oy: -1 },
      { horizontal: true, line: r.y + r.h, ox: 0, oy: 0 },
      { horizontal: false, line: r.x, ox: -1, oy: 0 },
      { horizontal: false, line: r.x + r.w, ox: 0, oy: 0 }
    ];
    for (const e of edges) {
      const length = e.horizontal ? r.w : r.h;
      const base = e.horizontal ? r.x : r.y;
      let start = -1;
      for (let i = 0; i <= length; i++) {
        const pos = base + i;
        const inside = i < length;
        const outX = e.horizontal ? pos : e.line + e.ox;
        const outY = e.horizontal ? e.line + e.oy : pos;
        const open = inside && isFloor(outX, outY);
        if (open && start < 0) start = pos;
        if (!open && start >= 0) {
          const width = pos - start;
          // A real doorway: narrow opening AND the corridor actually goes
          // deeper (2 cells out is still floor). Corridors merely running
          // alongside a room wall don't get pointless doors.
          const midPos = start + Math.floor(width / 2);
          const deepX = e.horizontal ? midPos : e.line + e.ox * 2 + (e.ox === 0 ? 1 : 0);
          const deepY = e.horizontal ? e.line + e.oy * 2 + (e.oy === 0 ? 1 : 0) : midPos;
          if (width <= 2 && isFloor(deepX, deepY)) {
            if (e.horizontal) ctx.addWall(start * grid, e.line * grid, pos * grid, e.line * grid, { door: 1 });
            else ctx.addWall(e.line * grid, start * grid, e.line * grid, pos * grid, { door: 1 });
          }
          start = -1;
        }
      }
    }
  }

  // Painted stone plate; fallback = raw underground tiles per floor cell block
  let painted = false;
  try {
    const src = await renderDungeonTexture(ctx, floor, runs);
    if (src) {
      ctx.addRawTile(src, 0, 0, ctx.pxW(), ctx.pxH(), { sort: SORT_FEATURE_BG });
      painted = true;
    }
  } catch (error) {
    console.warn(`${MODULE_ID} | Dungeon painting failed, falling back to plain floor`, error);
  }
  if (!painted) {
    const src = ctx.lib.ground.underground ?? Object.values(ctx.lib.ground)[0];
    if (src) {
      for (const r of rooms) {
        ctx.addRawTile(src, r.x * grid, r.y * grid, r.w * grid, r.h * grid, { sort: SORT_FEATURE_BG });
      }
    }
  }

  // Entrance: pick a random cardinal side of the map, take the room closest
  // to that edge and put the staircase flat against that wall, descending
  // into the room. Predictable ("the entrance is in the southern room"),
  // random between maps. Exit stairs go to the opposite side's room.
  // Stairs art (Stairs_Stone_A_1x3) is native 1 wide × N long, top = upper
  // floor; widened to 2 cells and flanked by burning torches with light.
  // User-authored full staircases (Data/paradigma-props/stairs) win outright —
  // they already include rails. Canon: art faces descent DOWN, landing at top.
  const custom = ctx.entries(["custom_stairs"], { maxCells: 8, tones: false });
  const useCustom = custom.length > 0;
  let stairs = useCustom ? custom : ctx.entries(["stairs"], { maxCells: 4, tones: false });

  // Match the staircase material to the floor tone so there's no colour clash.
  // Floor names rarely carry a material word, so fall back to grey stone
  // (slate/volcanic/earthy/gray/cobble) and prefer wide variants.
  if (!useCustom && stairs.length) {
    const floorName = ctx.dungeonFloorName ?? "";
    const floorMat = ["sandstone", "redrock", "volcanic", "slate", "earthy", "marble"]
      .find((m) => floorName.includes(m));
    const material = floorMat ?? "slate|volcanic|earthy|gray|cobble|stone";
    const matRe = new RegExp(material);
    const matched = stairs.filter((e) => matRe.test(e.name.toLowerCase()));
    if (matched.length) stairs = matched;
    const wide = stairs.filter((e) => /wide/i.test(e.name) || Math.min(e.w, e.h) >= 2);
    if (wide.length) stairs = wide;
  }
  // Wall torches flank the entrance stairs (not campfires on the floor)
  const flankFires = ctx.entries(["torches_lit"], { maxCells: 2, tones: false });

  // Saved JSON presets (a whole staircase with its walls/lights) beat
  // everything else. Two separate categories authored by the user in their
  // final orientation — the module does NOT rotate them:
  //   "stairs"      → entrance, placed flat against the top wall
  //   "stairs_down" → descent, placed flat against the bottom wall
  const stairPresets = ctx.stairPresets ?? [];
  const stairDownPresets = ctx.stairDownPresets ?? [];
  const hasStairContent = stairPresets.length || stairs.length;
  if (hasStairContent && rooms.length) {
    const edgeScore = {
      north: (r) => r.cy,
      south: (r) => H - r.cy,
      west: (r) => r.cx,
      east: (r) => W - r.cx
    };
    const byEdge = (dir) => [...rooms].sort((a, b) => edgeScore[dir](a) - edgeScore[dir](b))[0];

    // Pick a room near `edge` that actually fits the staircase (falls back to
    // the biggest available room), so the prefab isn't crammed into a tiny room.
    const roomForStairs = (preset, edge) => {
      const fits = rooms.filter((r) => r.w >= preset.cellsW && r.h >= preset.cellsH);
      const pool = fits.length ? fits : [...rooms].sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 1);
      return [...pool].sort((a, b) => edgeScore[edge](a) - edgeScore[edge](b))[0];
    };

    // Placed exactly as authored (no rotation). `atBottom` only chooses which
    // wall the prefab hugs — the user drew each preset facing the right way.
    const placePresetStairs = (preset, room, atBottom) => {
      const boxWc = preset.cellsW;
      const boxHc = preset.cellsH;
      const ox = Math.round(room.x + Math.max(0, (room.w - boxWc) / 2));
      const oy = atBottom ? (room.y + room.h - boxHc - 0.1) : (room.y + 0.1);
      ctx.placeProp(preset, ox, oy, 0);
      ctx.occ.mark(ox, Math.floor(oy), Math.ceil(boxWc), Math.ceil(boxHc), OBJ);
      // Flank torches: just inside the two long edges of the staircase, but
      // only if that cell is real floor (never out over the void — that leaks
      // light off the map). Clamp inside the room as a safety net.
      const wallYc = atBottom ? (room.y + room.h - 1) : room.y + 1;
      const leftC = Math.max(room.x, ox - 1);
      const rightC = Math.min(room.x + room.w - 1, ox + boxWc);
      for (const cxc of [leftC, rightC]) {
        if (!isFloor(cxc, wallYc)) continue;
        const fx = (cxc + 0.5) * grid;
        const fy = (wallYc + 0.5) * grid;
        if (flankFires.length) {
          ctx.addTile(rng.pick(flankFires), fx, fy, { scale: 0.85, rotation: rng.float(0, 360), sort: SORT_MID + Math.round(fy / grid), shadow: "mid" });
        }
        ctx.addLight(fx, fy, { brightCells: 1.5, dimCells: 4, color: "#ffb45e", animation: { type: "torch", speed: 4, intensity: 3 } });
        ctx.occ.mark(cxc, wallYc, 1, 1, OBJ);
      }
      // One torch crackle centered on the landing (not per-torch — avoids a
      // droning wall of overlapping loops at the entrance).
      ctx.addSound((ox + boxWc / 2) * grid, (wallYc + 0.5) * grid, 5, ctx.audioFor("torch"), { volume: 0.55, walls: true, easing: true });
    };

    let entranceRoomRef = null;
    if (stairPresets.length) {
      const entryPreset = rng.pick(stairPresets);
      const entryRoom = roomForStairs(entryPreset, "north");
      placePresetStairs(entryPreset, entryRoom, false);
      entranceRoomRef = entryRoom;
      if (ctx.presetData?.deeperStairs && rooms.length > 1) {
        // Descent uses a DEDICATED "stairs_down" preset (drawn facing down);
        // if none is saved, warn instead of rotating the entrance one.
        if (stairDownPresets.length) {
          const downPreset = rng.pick(stairDownPresets);
          const exitRoom = roomForStairs(downPreset, "south");
          if (exitRoom !== entryRoom) placePresetStairs(downPreset, exitRoom, true);
        } else {
          ui.notifications.warn(i18n("Notifications.NeedDownPreset"));
        }
      }
    } else {

    const placeStairs = (room, dir, descend = false) => {
      const entry = rng.pick(stairs);
      // Native footprint: entry.w across the steps, entry.h down the descent.
      // Kept at true proportions — no stretching, so it never looks like a plank.
      const across = entry.w || 2;
      const down = entry.h || 3;
      let px;
      let py;
      let rot;
      let boxW;
      let boxH;
      const flanks = [];
      const halfA = across / 2;
      if (dir === "north") {
        px = (room.x + room.w / 2) * grid; py = (room.y + down / 2 + 0.1) * grid; rot = 0;
        boxW = across; boxH = down;
        flanks.push([px - (halfA + 0.7) * grid, (room.y + 0.8) * grid], [px + (halfA + 0.7) * grid, (room.y + 0.8) * grid]);
      } else if (dir === "south") {
        px = (room.x + room.w / 2) * grid; py = (room.y + room.h - down / 2 - 0.1) * grid; rot = 180;
        boxW = across; boxH = down;
        flanks.push([px - (halfA + 0.7) * grid, (room.y + room.h - 0.8) * grid], [px + (halfA + 0.7) * grid, (room.y + room.h - 0.8) * grid]);
      } else if (dir === "west") {
        px = (room.x + down / 2 + 0.1) * grid; py = (room.y + room.h / 2) * grid; rot = 270;
        boxW = across; boxH = down;
        flanks.push([(room.x + 0.8) * grid, py - (halfA + 0.7) * grid], [(room.x + 0.8) * grid, py + (halfA + 0.7) * grid]);
      } else {
        px = (room.x + room.w - down / 2 - 0.1) * grid; py = (room.y + room.h / 2) * grid; rot = 90;
        boxW = across; boxH = down;
        flanks.push([(room.x + room.w - 0.8) * grid, py - (halfA + 0.7) * grid], [(room.x + room.w - 0.8) * grid, py + (halfA + 0.7) * grid]);
      }
      // The "down" staircase (deeper level) faces the opposite way, so the
      // steps read as descending rather than ascending like the entrance.
      // Rotating 180° swaps the art's faded (descending) end to the wall side,
      // which leaves a transparent gap — nudge back toward the wall so the
      // solid steps stay attached.
      if (descend) {
        rot = (rot + 180) % 360;
        // Bare steps fade at the descending end, so nudge them back to the
        // wall. A finished prefab is symmetric — rotating around its centre
        // keeps it attached, no nudge needed.
        if (!useCustom) {
          const toWall = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }[dir];
          const nudge = 0.32 * down * grid;
          px += toWall[0] * nudge;
          py += toWall[1] * nudge;
        }
      }
      // addSizedTile rotates around the anchor, so pass the native (pre-rotation) size
      ctx.addSizedTile(entry.src, px, py, boxW * grid, boxH * grid, {
        rotation: rot,
        sort: SORT_MID + Math.round(py / grid),
        shadow: "mid"
      });
      const occW = (dir === "north" || dir === "south") ? across : down;
      const occH = (dir === "north" || dir === "south") ? down : across;
      ctx.occ.mark(Math.floor(px / grid - occW / 2), Math.floor(py / grid - occH / 2), Math.ceil(occW), Math.ceil(occH), OBJ);

      for (const [fx, fy] of flanks) {
        // Only on real floor — a torch over the void spills light off the map
        if (!isFloor(Math.floor(fx / grid), Math.floor(fy / grid))) continue;
        if (flankFires.length) {
          ctx.addTile(rng.pick(flankFires), fx, fy, {
            scale: 0.85,
            rotation: rng.float(0, 360),
            sort: SORT_MID + Math.round(fy / grid),
            shadow: "mid"
          });
        }
        ctx.addLight(fx, fy, {
          brightCells: 1.5, dimCells: 4, color: "#ffb45e",
          animation: { type: "torch", speed: 4, intensity: 3 }
        });
        ctx.occ.mark(Math.floor(fx / grid), Math.floor(fy / grid), 1, 1, OBJ);
      }
    };

    const entranceDir = rng.pick(["north", "south", "west", "east"]);
    const entranceRoom = byEdge(entranceDir);
    placeStairs(entranceRoom, entranceDir);
    entranceRoomRef = entranceRoom;
    // A "down" staircase must come from a saved preset — the procedural
    // steps have no proper railing, so we don't fake it. Warn instead.
    if (ctx.presetData?.deeperStairs) {
      ui.notifications.warn(i18n("Notifications.NeedStairPreset"));
    }
    }

    // Treasure chest in the room FARTHEST from the entrance — runs whether the
    // stairs came from a saved preset or procedural art (both set
    // entranceRoomRef). Spot recorded now; the Item Piles container spawns after
    // the scene exists.
    if (ctx.presetData?.dungeonTreasure && entranceRoomRef) {
      const far = [...rooms].sort((a, b) =>
        Math.hypot(b.cx - entranceRoomRef.cx, b.cy - entranceRoomRef.cy) -
        Math.hypot(a.cx - entranceRoomRef.cx, a.cy - entranceRoomRef.cy))[0];
      const imgs = pickChestImages(ctx);
      console.info(`${MODULE_ID} | Treasure enabled: far=${!!far}, imgs=${!!imgs}`);
      if (far && imgs) {
        const tx = Math.round(far.x + far.w / 2);
        const ty = Math.round(far.y + far.h / 2);
        // Face the chest toward the room's doorway (a floor cell just outside a
        // wall = the corridor opening), nearest one to the chest, so it never
        // opens into a blank wall. Chest art faces south (down) at rotation 0.
        const openings = [];
        for (let x = far.x; x < far.x + far.w; x++) {
          if (isFloor(x, far.y - 1)) openings.push({ dir: "north", x, y: far.y - 1 });
          if (isFloor(x, far.y + far.h)) openings.push({ dir: "south", x, y: far.y + far.h });
        }
        for (let y = far.y; y < far.y + far.h; y++) {
          if (isFloor(far.x - 1, y)) openings.push({ dir: "west", x: far.x - 1, y });
          if (isFloor(far.x + far.w, y)) openings.push({ dir: "east", x: far.x + far.w, y });
        }
        let facing = "south";
        if (openings.length) {
          openings.sort((a, b) => Math.hypot(a.x - tx, a.y - ty) - Math.hypot(b.x - tx, b.y - ty));
          facing = openings[0].dir;
        }
        const rotation = { south: 0, west: 90, north: 180, east: 270 }[facing];
        ctx.treasureSpot = { x: tx, y: ty, rotation, ...imgs };
        ctx.occ.mark(tx, ty, 1, 1, OBJ);
      } else if (!imgs) {
        ctx.missingBuckets.add("treasure_chests");
      }
    }
  } else if (!hasStairContent) {
    ctx.missingBuckets.add("stairs");
  }

  // Optional underground lake, painted into the most central room and its
  // floor cells marked OBJ so nothing scatters onto the water.
  if (ctx.presetData?.dungeonLake && rooms.length) {
    const cxm = W / 2, cym = H / 2;
    const room = [...rooms].sort((a, b) =>
      (Math.abs(a.cx - cxm) + Math.abs(a.cy - cym)) - (Math.abs(b.cx - cxm) + Math.abs(b.cy - cym)))[0];
    const lw = Math.max(4, room.w - 2);
    const lh = Math.max(4, room.h - 2);
    const lx = room.x + Math.floor((room.w - lw) / 2);
    const ly = room.y + Math.floor((room.h - lh) / 2);
    try {
      const src = await renderLakeTexture(ctx, { x0: lx, y0: ly, w: lw, h: lh }, LAKE_STYLE.dungeon, "dungeon");
      if (src) ctx.addRawTile(src, lx * grid, ly * grid, lw * grid, lh * grid, { sort: SORT_FEATURE_BG + 5 });
      ctx.occ.mark(lx, ly, lw, lh, OBJ);
    } catch (error) {
      console.warn(`${MODULE_ID} | Dungeon lake failed`, error);
    }
  }

  // At most one cold/broken brazier as set dressing — no light, no scattered
  // campfires. Prefer an unlit/cold/broken variant; skip entirely if none.
  const braziers = ctx.entries(["braziers", "campfires_cold"], { maxCells: 2, tones: false });
  const dead = braziers.filter((e) => /cold|unlit|broken|ruined|out\b/i.test(e.name));
  const pool = dead.length ? dead : braziers.filter((e) => !/lit/i.test(e.name) || /unlit/i.test(e.name));
  if (pool.length) {
    const room = rng.pick(rooms);
    const px = (room.x + rng.float(0.3, 0.7) * room.w) * grid;
    const py = (room.y + rng.float(0.3, 0.7) * room.h) * grid;
    if (!ctx.occ.test(Math.floor(px / grid), Math.floor(py / grid), 1, 1, OBJ)) {
      ctx.addTile(rng.pick(pool), px, py, {
        scale: rng.float(0.9, 1.1),
        rotation: rng.float(0, 360),
        sort: SORT_MID + Math.round(py / grid),
        shadow: "mid"
      });
      ctx.occ.mark(Math.floor(px / grid), Math.floor(py / grid), 1, 1, OBJ);
    }
  }
}

/* --------------------------------- Arena ---------------------------------- */

/**
 * Paint the arena. Two layouts:
 *  - "pit":   one elliptical fighting pit with a stone ring
 *  - "roman": canonical amphitheatre — outer ring, cavea (tribunes with
 *             seat rows and radial aisles), podium wall, sand arena floor,
 *             two vomitoria corridors through the stands
 */
async function renderArenaTexture(ctx, g) {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  const brushList = ctx.lib.buckets.road_brush_desert ?? [];
  const sandSrc = brushList.length ? ctx.rng.pick(brushList).src : (ctx.lib.ground.underground ?? null);
  if (!sandSrc) return null;

  const scale = Math.min(1, 2200 / Math.max(ctx.pxW(), ctx.pxH()));
  const cnv = document.createElement("canvas");
  cnv.width = Math.round(ctx.pxW() * scale);
  cnv.height = Math.round(ctx.pxH() * scale);
  const c = cnv.getContext("2d");
  const gpx = ctx.grid * scale;
  const CX = g.cx * gpx;
  const CY = g.cy * gpx;

  const fillEllipse = (r, paint) => {
    c.save();
    c.beginPath();
    c.ellipse(CX, CY, r.rx * gpx, r.ry * gpx, 0, 0, Math.PI * 2);
    c.clip();
    paint();
    c.restore();
  };

  // --- tribunes (roman): flagstone annulus with seat rows and aisles ---
  if (g.mode === "roman") {
    const floorList = ctx.lib.buckets.ruin_floor_tex ?? [];
    const stoneSrc = floorList.length ? ctx.rng.pick(floorList).src : sandSrc;
    const stone = await loadImage(stoneSrc);
    const stonePattern = c.createPattern(stone, "repeat");
    const patScale = (7 * gpx) / stone.width;
    if (stonePattern.setTransform && typeof DOMMatrix !== "undefined") {
      stonePattern.setTransform(new DOMMatrix().scale(patScale));
    }
    fillEllipse(g.outer, () => {
      c.fillStyle = stonePattern;
      c.fillRect(0, 0, cnv.width, cnv.height);
      c.globalCompositeOperation = "multiply";
      c.fillStyle = "#c2bbac";
      c.fillRect(0, 0, cnv.width, cnv.height);
      c.globalCompositeOperation = "source-over";

      // Concentric seat rows between podium and outer wall
      const avgIn = (g.inner.rx + g.inner.ry) / 2;
      const avgOut = (g.outer.rx + g.outer.ry) / 2;
      const bandStart = 0.9;   // cells beyond the podium wall
      const bandEnd = 1.0;     // cells short of the outer wall
      const rows = Math.max(3, Math.floor((avgOut - avgIn - bandStart - bandEnd) / 0.55));
      c.strokeStyle = "rgba(25, 20, 14, 0.4)";
      c.lineWidth = Math.max(1.5, 0.05 * gpx);
      for (let k = 0; k <= rows; k++) {
        const s = (avgIn + bandStart + (k / rows) * (avgOut - avgIn - bandStart - bandEnd)) / avgOut;
        c.beginPath();
        c.ellipse(CX, CY, g.outer.rx * s * gpx, g.outer.ry * s * gpx, 0, 0, Math.PI * 2);
        c.stroke();
      }

      // Radial aisles dividing the cavea into cunei (wedges)
      c.strokeStyle = "rgba(15, 12, 8, 0.45)";
      c.lineWidth = Math.max(2, 0.12 * gpx);
      for (let k = 0; k < 12; k++) {
        const a = g.gatePhase + (k / 12) * Math.PI * 2;
        if (g.gates.some((ga) => g.angDiff(a, ga) < g.dOut * 2)) continue;
        c.beginPath();
        c.moveTo(CX + Math.cos(a) * g.inner.rx * 1.02 * gpx, CY + Math.sin(a) * g.inner.ry * 1.02 * gpx);
        c.lineTo(CX + Math.cos(a) * g.outer.rx * 0.98 * gpx, CY + Math.sin(a) * g.outer.ry * 0.98 * gpx);
        c.stroke();
      }
    });
  }

  // --- arena floor: packed sand, slightly darkened, mottled ---
  const sand = await loadImage(sandSrc);
  const sandPattern = c.createPattern(sand, "repeat");
  const pit = g.mode === "roman" ? g.inner : g.outer;
  fillEllipse(pit, () => {
    c.fillStyle = sandPattern;
    c.fillRect(0, 0, cnv.width, cnv.height);
    c.globalCompositeOperation = "multiply";
    c.fillStyle = "#b3a689";
    c.fillRect(0, 0, cnv.width, cnv.height);
    c.globalCompositeOperation = "source-over";
    c.filter = `blur(${Math.max(3, Math.round(9 * scale))}px)`;
    const blotches = Math.round((pit.rx * pit.ry) / 4);
    for (let k = 0; k < blotches; k++) {
      const a = ctx.rng.float(0, Math.PI * 2);
      const rr = Math.sqrt(ctx.rng.random());
      c.fillStyle = `rgba(60, 45, 30, ${ctx.rng.float(0.05, 0.13).toFixed(3)})`;
      c.beginPath();
      c.arc(CX + Math.cos(a) * pit.rx * rr * gpx, CY + Math.sin(a) * pit.ry * rr * gpx,
        ctx.rng.float(0.5, 1.6) * gpx, 0, Math.PI * 2);
      c.fill();
    }
    c.filter = "none";
  });

  // --- vomitoria corridors through the stands (roman) ---
  if (g.mode === "roman") {
    for (const ga of g.gates) {
      c.save();
      c.beginPath();
      const pIn1 = g.pt(g.inner, ga - g.dIn);
      const pIn2 = g.pt(g.inner, ga + g.dIn);
      const pOut1 = g.pt(g.outer, ga - g.dOut);
      const pOut2 = g.pt(g.outer, ga + g.dOut);
      c.moveTo(pIn1.x * scale, pIn1.y * scale);
      c.lineTo(pOut1.x * scale, pOut1.y * scale);
      c.lineTo(pOut2.x * scale, pOut2.y * scale);
      c.lineTo(pIn2.x * scale, pIn2.y * scale);
      c.closePath();
      c.clip();
      c.fillStyle = sandPattern;
      c.fillRect(0, 0, cnv.width, cnv.height);
      c.globalCompositeOperation = "multiply";
      c.fillStyle = "#a89b84";
      c.fillRect(0, 0, cnv.width, cnv.height);
      c.restore();
    }
  }

  // --- stone strips along every wall run (rings + corridor sides) ---
  const stripList = ctx.lib.buckets.ruin_wall_strip ?? [];
  if (stripList.length) {
    const tonePrefer = ctx.presetData?.wallTonePrefer;
    let pool = stripList;
    if (tonePrefer) {
      const matched = stripList.filter((e) => tonePrefer.test(e.name.toLowerCase()));
      if (matched.length) pool = matched;
    }
    const strip = await loadImage(ctx.rng.pick(pool).src);
    const drawH = 1.3 * gpx;
    const segW = strip.width * (drawH / strip.height);
    const extend = 0.25 * gpx; // shallow angles: overlap hides joints
    for (const ch of g.chords) {
      const fullLen = Math.hypot(ch.x2 - ch.x1, ch.y2 - ch.y1) * scale;
      const angle = Math.atan2(ch.y2 - ch.y1, ch.x2 - ch.x1);
      c.save();
      c.translate(ch.x1 * scale, ch.y1 * scale);
      c.rotate(angle);
      let drawn = -extend;
      const limit = fullLen + extend;
      while (drawn < limit) {
        const w = Math.min(segW, limit - drawn);
        c.drawImage(strip, 0, 0, strip.width * (w / segW), strip.height, drawn, -drawH / 2, w, drawH);
        drawn += w;
      }
      c.restore();
    }
  }

  const blob = await new Promise((resolve) => cnv.toBlob(resolve, "image/webp", 0.85));
  if (!blob) return null;
  const FP = getFilePicker();
  try {
    await FP.createDirectory("data", GENERATED_DIR);
  } catch (error) {
    if (!/EEXIST|already exists/i.test(String(error?.message ?? error))) throw error;
  }
  const file = new File([blob], `arena-${ctx.seedTag}.webp`, { type: "image/webp" });
  const uploaded = await FP.upload("data", GENERATED_DIR, file, {}, { notify: false });
  return uploaded?.path ?? null;
}

async function buildArena(ctx) {
  const rng = ctx.rng;
  const grid = ctx.grid;
  const W = ctx.cellsW;
  const H = ctx.cellsH;

  // A saved arena preset (category "arena") replaces the whole procedural
  // ring — the user's hand-built colosseum, centered, exactly as authored
  const arenaPresets = ctx.arenaPresets ?? [];
  if (arenaPresets.length) {
    const preset = rng.pick(arenaPresets);
    const ox = Math.max(0, Math.round((W - preset.cellsW) / 2));
    const oy = Math.max(0, Math.round((H - preset.cellsH) / 2));
    ctx.placeProp(preset, ox, oy, 0);
    ctx.occ.mark(ox, oy, Math.min(W, preset.cellsW), Math.min(H, preset.cellsH), RESERVED);
    return;
  }

  // Roman amphitheatre needs room for the stands; small maps get a plain pit
  const mode = Math.min(W, H) >= 22 ? "roman" : "pit";
  const cx = W / 2;
  const cy = H / 2;
  const outer = mode === "roman"
    ? { rx: W / 2 - 1.5, ry: H / 2 - 1.5 }
    : { rx: W / 2 - 3, ry: H / 2 - 3 };
  const inner = { rx: outer.rx * 0.6, ry: outer.ry * 0.6 };
  const pit = mode === "roman" ? inner : outer;

  const gatePhase = rng.float(0, Math.PI * 2);
  const gates = [gatePhase, gatePhase + Math.PI];
  const corridorHalf = 1.1; // cells
  const avg = (r) => (r.rx + r.ry) / 2;
  const dIn = corridorHalf / avg(inner);
  const dOut = corridorHalf / avg(outer);
  const pt = (r, a) => ({ x: (cx + Math.cos(a) * r.rx) * grid, y: (cy + Math.sin(a) * r.ry) * grid });
  const angDiff = (a, b) => {
    const d = Math.abs(a - b) % (Math.PI * 2);
    return Math.min(d, Math.PI * 2 - d);
  };

  // Fighting pit = scatter's "inside"; the tribune band is RESERVED+OBJ so
  // neither pit debris nor outside rocks/mounds ever land on the stands
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nIn = ((x + 0.5 - cx) / pit.rx) ** 2 + ((y + 0.5 - cy) / pit.ry) ** 2;
      if (nIn <= 0.92) {
        ctx.occ.mark(x, y, 1, 1, RESERVED);
      } else {
        const nOut = ((x + 0.5 - cx) / outer.rx) ** 2 + ((y + 0.5 - cy) / outer.ry) ** 2;
        if (nOut <= 1.05) ctx.occ.mark(x, y, 1, 1, RESERVED | OBJ);
      }
    }
  }

  // Walls: ring chords with gate gaps; art runs collected for the painter
  const chords = [];
  const N = 36;
  const ringWalls = (r, delta) => {
    const step = (Math.PI * 2) / N;
    for (let i = 0; i < N; i++) {
      const a1 = gatePhase + i * step;
      const a2 = a1 + step;
      const mid = a1 + step / 2;
      if (gates.some((ga) => angDiff(mid, ga) < delta + step / 2)) continue; // gate gap
      const p1 = pt(r, a1);
      const p2 = pt(r, a2);
      ctx.addWall(p1.x, p1.y, p2.x, p2.y);
      const run = { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
      chords.push(run);
      markRunCells(ctx, run, OBJ);
    }
  };
  ringWalls(outer, dOut);
  if (mode === "roman") ringWalls(inner, dIn);

  // Gates: door walls across the OUTER openings; corridor side walls (roman)
  for (const ga of gates) {
    const o1 = pt(outer, ga - dOut);
    const o2 = pt(outer, ga + dOut);
    ctx.addWall(o1.x, o1.y, o2.x, o2.y, { door: 1 });
    if (mode === "roman") {
      for (const s of [-1, 1]) {
        const pi = pt(inner, ga + s * dIn);
        const po = pt(outer, ga + s * dOut);
        ctx.addWall(pi.x, pi.y, po.x, po.y);
        const run = { x1: pi.x, y1: pi.y, x2: po.x, y2: po.y };
        chords.push(run);
        markRunCells(ctx, run, OBJ);
      }
    }
  }

  // Painted floors + wall art
  try {
    const src = await renderArenaTexture(ctx, {
      mode, cx, cy, outer, inner, chords, gates, gatePhase, dIn, dOut, pt, angDiff
    });
    if (src) ctx.addRawTile(src, 0, 0, ctx.pxW(), ctx.pxH(), { sort: SORT_FEATURE_BG });
  } catch (error) {
    console.warn(`${MODULE_ID} | Arena painting failed`, error);
  }

  // Columns on the outer ring (every 3rd vertex, skipping the gates)
  const pillars = ctx.entries(["pillars"], { maxCells: 2, tones: false });
  if (pillars.length) {
    const family = rng.pick([...new Set(pillars.map((e) => e.family))]);
    const pool = pillars.filter((e) => e.family === family);
    for (let i = 0; i < N; i += 3) {
      const a = gatePhase + (i / N) * Math.PI * 2;
      if (gates.some((ga) => angDiff(a, ga) < dOut + 0.25)) continue;
      const v = pt(outer, a);
      ctx.addTile(rng.pick(pool), v.x, v.y, {
        scale: 1.1,
        rotation: 0,
        sort: SORT_TALL + Math.round(v.y / grid),
        shadow: "mid"
      });
    }
  }

  // Torches with light at the pit-side mouths of both gates
  const torches = ctx.entries(["torches_lit"], { maxCells: 2, tones: false });
  for (const ga of gates) {
    for (const s of [-1, 1]) {
      const mouth = pt(pit, ga + s * (mode === "roman" ? dIn * 1.5 : dOut * 1.5));
      const ix = mouth.x + (cx * grid - mouth.x) * 0.05;
      const iy = mouth.y + (cy * grid - mouth.y) * 0.05;
      if (torches.length) {
        ctx.addTile(rng.pick(torches), ix, iy, { scale: 0.85, rotation: rng.float(0, 360), sort: SORT_MID + Math.round(iy / grid), shadow: "mid" });
      }
      ctx.addLight(ix, iy, {
        brightCells: 1.5, dimCells: 4, color: "#ffb45e",
        animation: { type: "torch", speed: 4, intensity: 3 }
      });
    }
  }

  // --- tribune dressing (roman): VIP box, statue, torch ring on the stands ---
  if (mode === "roman") {
    const mid = { rx: (inner.rx + outer.rx) / 2, ry: (inner.ry + outer.ry) / 2 };
    const faceCenter = (x, y) => Math.atan2(cy * grid - y, cx * grid - x) * 180 / Math.PI - 90;
    const vipAngle = gatePhase + Math.PI / 2;
    const statueAngle = gatePhase - Math.PI / 2;

    // Editor's box: a rug with a pair of seats facing the arena
    const rugs = ctx.entries(["rugs"], { maxCells: 4, tones: false });
    const chairs = ctx.entries(["seating"], { maxCells: 1, tones: false });
    const vip = pt(mid, vipAngle);
    if (rugs.length) {
      ctx.addTile(rng.pick(rugs), vip.x, vip.y, {
        scale: 1,
        rotation: faceCenter(vip.x, vip.y),
        sort: SORT_FLAT + 30
      });
    }
    if (chairs.length) {
      const aC = Math.atan2(cy * grid - vip.y, cx * grid - vip.x);
      for (const s of [-1, 1]) {
        const chx = vip.x + Math.cos(aC + Math.PI / 2) * s * 0.65 * grid;
        const chy = vip.y + Math.sin(aC + Math.PI / 2) * s * 0.65 * grid;
        ctx.addTile(rng.pick(chairs), chx, chy, {
          scale: 1,
          rotation: faceCenter(chx, chy),
          sort: SORT_MID + Math.round(chy / grid),
          shadow: "mid"
        });
      }
    }

    // A statue watches from the opposite side
    const statues = ctx.entries(["statues"], { maxCells: 2, tones: false });
    if (statues.length) {
      const sv = pt(mid, statueAngle);
      ctx.addTile(rng.pick(statues), sv.x, sv.y, {
        scale: 1,
        rotation: faceCenter(sv.x, sv.y),
        sort: SORT_TALL + Math.round(sv.y / grid),
        shadow: "mid"
      });
    }

    // Torch ring lighting the stands, keeping clear of gates, VIP and statue
    for (let i = 0; i < N; i += 5) {
      const a = gatePhase + (i / N) * Math.PI * 2;
      const nearSomething = [...gates, vipAngle, statueAngle]
        .some((sp) => angDiff(a, sp) < 0.4);
      if (nearSomething) continue;
      const v = pt(mid, a);
      if (torches.length) {
        ctx.addTile(rng.pick(torches), v.x, v.y, {
          scale: 0.8,
          rotation: rng.float(0, 360),
          sort: SORT_MID + Math.round(v.y / grid),
          shadow: "mid"
        });
      }
      ctx.addLight(v.x, v.y, {
        brightCells: 1, dimCells: 3, color: "#ffb45e",
        animation: { type: "torch", speed: 4, intensity: 3 }
      });
    }
  }
}

/* --------------------------------- Main ---------------------------------- */

export async function generateScene(options = {}) {
  if (!game.user?.isGM) {
    ui.notifications.warn(i18n("Notifications.OnlyGM"));
    return null;
  }

  // Tags (biome × season × features); legacy string presets map to tag combos
  const tags = options.tags ?? LEGACY_PRESETS[options.preset] ?? LEGACY_PRESETS.forestRoad;
  const preset = composeTags(tags);
  const tagKey = `${tags.biome}:${tags.season ?? "none"}:${(tags.features ?? []).join("+")}`;

  const cellsW = Math.max(12, Math.min(100, Math.round(options.width ?? 36)));
  const cellsH = Math.max(12, Math.min(100, Math.round(options.height ?? 28)));
  const grid = Math.max(50, Math.min(300, Math.round(options.gridSize ?? 100)));
  const density = Math.max(0.25, Math.min(3, Number(options.density) || 1));
  const seed = String(options.seed || "").trim() || makeSeed();
  const rng = new Rng(`${seed}:${tagKey}`);

  ui.notifications.info(i18n("Notifications.GenerateStarted"));

  const library = await buildLibrary(options.assetRoot, { notify: false });
  if (!library.total) {
    ui.notifications.error(i18n("Notifications.NoAssets"));
    return null;
  }

  const shadowsEnabled = game.settings.get(MODULE_ID, "faShadows") && !!game.modules.get("fa-nexus")?.active;
  const ctx = new GenerationContext({
    rng, library, cellsW, cellsH, grid,
    gridDistance: 5,
    shadowsEnabled
  });
  ctx.roadTint = preset.roadTint ?? null;
  ctx.presetData = preset;
  ctx.allowedTones = preset.allowedTones ?? null;
  ctx.excludeTones = preset.excludeTones ?? null;
  ctx.seedTag = `${tagKey.replace(/[^\w]+/g, "-")}-${seed}`.replace(/[^\w-]/g, "_");
  // Separate stream: audio choices must never perturb the layout RNG.
  ctx.audioRng = new Rng(`${seed}:${tagKey}:audio`);

  // Load JSON presets referenced by the library (fetched lazily by category)
  ctx.stairPresets = [];
  for (const path of library.presets?.stairs ?? []) {
    const p = await loadPreset(path);
    if (p) ctx.stairPresets.push(p);
  }
  ctx.stairDownPresets = [];
  for (const path of library.presets?.stairs_down ?? []) {
    const p = await loadPreset(path);
    if (p) ctx.stairDownPresets.push(p);
  }
  ctx.arenaPresets = [];
  for (const path of library.presets?.arena ?? []) {
    const p = await loadPreset(path);
    if (p) ctx.arenaPresets.push(p);
  }
  ctx.buildingPresets = [];
  for (const path of library.presets?.building ?? []) {
    const p = await loadPreset(path);
    if (p) ctx.buildingPresets.push(p);
  }

  // Layout passes: ground → road (simple shape) → feature footprints planned
  // strictly off-road (shrinking if needed) → build features → scatter.
  // Dungeons are their own world: rooms + corridors on the void.
  if (preset.special === "dungeon") {
    await buildDungeon(ctx);
  } else if (preset.special === "arena") {
    placeGround(ctx, preset.biome);
    await buildArena(ctx);
  } else {
    placeGround(ctx, preset.biome);
    if (preset.road) await buildRoad(ctx);
    const plans = await planFeatures(ctx, preset.features);
    for (const plan of plans) {
      if (plan.type === "camp") placeCamp(ctx, plan.rect);
      else if (plan.type === "ruins") await placeRuins(ctx, plan);
      else if (plan.type === "tavern") await placeTavern(ctx, plan.rect);
      else if (plan.type === "graveyard") placeGraveyard(ctx, plan.rect);
      else if (plan.type === "lake") await placeLake(ctx, plan);
      else if (plan.type === "building") await placeBuilding(ctx, plan);
    }
  }
  for (const def of preset.scatter) runScatter(ctx, def, density);

  // Whole-scene ambient bed, locked to the biome by its audio folder (dungeon
  // drone, forest birds, ...). Centered, radius covers the map from the middle;
  // walls/easing off so it's uniform everywhere. Positional emitters (campfire,
  // torch) were added during feature building.
  // tags.biome is the biome id (forest/winter/desert/arena/dungeon) = the audio
  // subfolder. NOT preset.biome, which is the ground texture key (grass/snow).
  const audioKey = preset.tags?.biome ?? preset.special ?? preset.biome;
  const bedRadius = Math.sqrt(ctx.cellsW ** 2 + ctx.cellsH ** 2) * 0.6;
  ctx.addSound(ctx.pxW() / 2, ctx.pxH() / 2, bedRadius, ctx.audioFor(audioKey), { volume: 0.5, walls: false, easing: false });

  // Plain wall around the map edge so tokens can't wander off (toggle setting)
  if (game.settings.get(MODULE_ID, "borderWalls")) {
    const pw = ctx.pxW(), ph = ctx.pxH();
    ctx.addWall(0, 0, pw, 0);
    ctx.addWall(pw, 0, pw, ph);
    ctx.addWall(pw, ph, 0, ph);
    ctx.addWall(0, ph, 0, 0);
  }

  if (ctx.missingBuckets.size) {
    console.warn(`${MODULE_ID} | Missing asset buckets:`, [...ctx.missingBuckets]);
  }

  // Create the scene and its contents
  const scene = await Scene.create({
    name: options.sceneName || i18n("App.Title"),
    width: cellsW * grid,
    height: cellsH * grid,
    grid: { type: CONST.GRID_TYPES.SQUARE, size: grid, distance: ctx.gridDistance, units: "ft" },
    padding: 0.25,
    backgroundColor: preset.special === "dungeon" ? "#0d0d10" : "#1a1a17",
    tokenVision: true,
    fog: { exploration: true },
    environment: {
      darknessLevel: preset.darkness,
      globalLight: { enabled: preset.globalLight }
    },
    flags: { [MODULE_ID]: { generated: true, seed, tags: preset.tags } }
  });

  // Canvas (0,0) is the padded border, the scene rect starts at sceneX/sceneY —
  // shift everything so the map lands inside the scene bounds
  const ox = scene.dimensions?.sceneX ?? 0;
  const oy = scene.dimensions?.sceneY ?? 0;
  for (const t of ctx.tiles) { t.x += ox; t.y += oy; }
  for (const w of ctx.walls) { w.c[0] += ox; w.c[1] += oy; w.c[2] += ox; w.c[3] += oy; }
  for (const l of ctx.lights) { l.x += ox; l.y += oy; }
  for (const s of ctx.sounds) { s.x += ox; s.y += oy; }

  const BATCH = 100;
  for (let i = 0; i < ctx.tiles.length; i += BATCH) {
    await scene.createEmbeddedDocuments("Tile", ctx.tiles.slice(i, i + BATCH));
  }
  if (ctx.walls.length) await scene.createEmbeddedDocuments("Wall", ctx.walls);
  if (ctx.lights.length) await scene.createEmbeddedDocuments("AmbientLight", ctx.lights);
  if (ctx.sounds.length) await scene.createEmbeddedDocuments("AmbientSound", ctx.sounds);

  // Clickable Item Piles loot chest (dungeon treasure), spawned now that the
  // scene exists. No-op unless the dungeon recorded a treasure spot.
  try {
    await placeTreasureChest(ctx, scene, ox, oy);
  } catch (error) {
    console.error(`${MODULE_ID} | Treasure chest placement failed`, error);
  }

  ui.notifications.info(i18n("Notifications.GenerateDone", {
    name: scene.name,
    tiles: ctx.tiles.length,
    walls: ctx.walls.length,
    lights: ctx.lights.length,
    seed
  }));

  if (options.activate) await scene.activate();
  else await scene.view();

  return scene;
}
