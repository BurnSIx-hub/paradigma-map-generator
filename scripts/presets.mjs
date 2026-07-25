/**
 * Tag constructor: biome × season × features compose the generation plan.
 *
 * scatter item fields:
 *   buckets    — library bucket names, merged and picked from at random
 *   per100     — placements per 100 grid cells (scaled by the density slider)
 *   layer      — "flat" | "mid" | "tall" (render sort band + occupancy blocking)
 *   avoid      — occupancy masks the placement must not touch
 *   maxCells / minCells — footprint size range filter
 *   scale      — [min, max] size jitter
 *   inside     — placement must overlap this mask (ruins overgrowth etc.)
 *   families   — use at most N asset families per map
 *   cluster    — place in patches around cluster centers
 *   tonePrefer — soft preference for a tone class ("green", "autumn")
 */

export const BIOMES = {
  forest: {
    ground: "grass",
    darkness: 0,
    globalLight: true,
    allowedTones: ["green", "neutral", "autumn"],
    wallTonePrefer: /earthy|volcanic|orange|brick/,
    road: {
      tint: "#a3966e",
      halfWidth: [1.3, 1.7],
      verge: ["plants", "bushes"],
      debris: ["sticks", "rocks"],
      tracks: ["tracks"]
    },
    scatter: [
      { buckets: ["trees_pine", "trees"], per100: 4.2, layer: "tall", overhead: true, avoid: ["road", "reserved", "object"], maxCells: 6, scale: [0.9, 1.15], families: 3, cluster: true, tonePrefer: "green" },
      { buckets: ["bushes"], per100: 2.2, layer: "mid", avoid: ["road", "reserved", "object"], maxCells: 3, scale: [0.85, 1.2], families: 2, cluster: true, tonePrefer: "green" },
      { buckets: ["rocks"], per100: 1.0, layer: "mid", avoid: ["road", "reserved", "object"], maxCells: 4, scale: [0.7, 1.1], families: 2 },
      { buckets: ["flowers"], per100: 1.2, layer: "flat", avoid: ["road", "reserved"], maxCells: 2, scale: [0.8, 1.2], families: 2, cluster: true },
      { buckets: ["plants"], per100: 1.0, layer: "flat", avoid: ["road", "reserved"], maxCells: 2, scale: [0.8, 1.2], families: 2, cluster: true },
      { buckets: ["mushrooms"], per100: 0.4, layer: "flat", avoid: ["road", "reserved"], maxCells: 2, scale: [0.7, 1.1], families: 1, cluster: true },
      { buckets: ["logs", "stumps"], per100: 0.5, layer: "mid", avoid: ["road", "reserved", "object"], maxCells: 4, scale: [0.85, 1.1], families: 2 },
      { buckets: ["sticks"], per100: 0.8, layer: "flat", avoid: ["reserved"], maxCells: 3, scale: [0.8, 1.2], families: 2 },
      { buckets: ["leaves"], per100: 0.9, layer: "flat", avoid: ["reserved"], maxCells: 4, scale: [0.9, 1.3], families: 2, cluster: true, tonePrefer: "green" }
    ]
  },

  darkforest: {
    ground: "grass",                 // fallback if the Woodlands pack isn't installed
    groundBucket: "ground_darkforest",
    groundTint: "#949a7a",           // deepen the floor to a mossy, gloomy green
    darkness: 0.35,                  // dim but playable; dusk/night add more
    globalLight: true,
    allowedTones: ["green", "neutral", "autumn"],
    wallTonePrefer: /slate|gray|stone|volcanic|earthy/,
    road: {
      brush: "road_brush_forest",     // textured muddy trail, not a flat brown band
      brushTint: "#7a6850",           // muddy, gloom-matched
      tint: "#544a3a",                // fallback if the Woodlands pack isn't installed
      halfWidth: [1.2, 1.6],
      verge: ["bushes", "mushrooms"],
      debris: ["sticks", "logs", "rocks"],
      tracks: ["tracks"]
    },
    scatter: [
      // Dead bare trees claim space FIRST — they're huge (8-12 cells), so if
      // placed after the dense pines they never find clearance and vanish. This
      // asset set has no autumn-canopy trees (only pines + bare), so a gloomy /
      // autumn forest reads through bare dead trees + fallen leaves.
      { buckets: ["trees_bare"], per100: 1.9, layer: "tall", elevation: 20, avoid: ["road", "reserved", "object"], minCells: 6, maxCells: 12, scale: [0.7, 1.0], families: 3, cluster: true },
      { buckets: ["trees_pine", "trees"], per100: 2.2, layer: "tall", overhead: true, avoid: ["road", "reserved", "object"], maxCells: 6, scale: [0.9, 1.15], families: 2, cluster: true },
      { buckets: ["bushes"], per100: 1.6, layer: "mid", avoid: ["road", "reserved", "object"], maxCells: 3, scale: [0.85, 1.2], families: 2, cluster: true, tonePrefer: "green" },
      { buckets: ["logs", "stumps"], per100: 1.1, layer: "mid", avoid: ["road", "reserved", "object"], maxCells: 4, scale: [0.85, 1.15], families: 2 },
      { buckets: ["rocks"], per100: 1.0, layer: "mid", avoid: ["road", "reserved", "object"], maxCells: 4, scale: [0.7, 1.1], families: 2 },
      { buckets: ["mushrooms"], per100: 0.7, layer: "flat", avoid: ["road", "reserved"], maxCells: 2, scale: [0.7, 1.15], families: 1, cluster: true },
      { buckets: ["leaves"], per100: 1.6, layer: "flat", avoid: ["reserved"], maxCells: 4, scale: [0.9, 1.3], families: 2, cluster: true, tonePrefer: "autumn" },
      { buckets: ["sticks"], per100: 1.0, layer: "flat", avoid: ["reserved"], maxCells: 3, scale: [0.8, 1.2], families: 2 }
    ]
  },

  winter: {
    ground: "snow",
    darkness: 0,
    globalLight: true,
    allowedTones: ["winter", "neutral"],
    wallTonePrefer: /slate|gray|stone/,
    road: {
      brush: "road_brush_snow",
      brushTint: "#dfe2e6",
      tint: "#7d7f82",
      halfWidth: [1.2, 1.55],
      verge: ["snow_piles", "bushes_snow"],
      debris: ["sticks", "rocks_snow"],
      tracks: []
    },
    scatter: [
      { buckets: ["trees_snow"], per100: 1.6, layer: "tall", overhead: true, avoid: ["road", "reserved", "object"], minCells: 6, maxCells: 12, scale: [0.65, 0.85], families: 3, cluster: true },
      { buckets: ["trees_bare"], per100: 0.5, layer: "tall", elevation: 20, avoid: ["road", "reserved", "object"], minCells: 6, maxCells: 12, scale: [0.6, 0.8], families: 2, cluster: true },
      { buckets: ["trees_snow"], per100: 0.7, layer: "mid", avoid: ["road", "reserved", "object"], maxCells: 5, scale: [0.8, 1.0], families: 2, cluster: true },
      { buckets: ["bushes_snow"], per100: 1.8, layer: "mid", avoid: ["road", "reserved", "object"], maxCells: 3, scale: [0.85, 1.2], families: 2, cluster: true },
      { buckets: ["rocks_snow", "rocks"], per100: 1.0, layer: "mid", avoid: ["road", "reserved", "object"], maxCells: 4, scale: [0.7, 1.1], families: 2 },
      { buckets: ["logs_snow", "stumps_snow"], per100: 0.4, layer: "mid", avoid: ["road", "reserved", "object"], maxCells: 6, scale: [0.8, 1.0], families: 2 },
      { buckets: ["sticks"], per100: 0.3, layer: "flat", avoid: ["reserved"], maxCells: 3, scale: [0.8, 1.2], families: 1 },
      { buckets: ["snow_piles"], per100: 0.9, layer: "flat", avoid: ["road", "reserved"], maxCells: 4, scale: [0.8, 1.2], families: 2, cluster: true },
      // Snow drifting over the trail
      { buckets: ["snow_piles"], per100: 1.2, layer: "flat", avoid: [], inside: "road", insideLoose: true, maxCells: 3, scale: [0.6, 1.0], families: 2 },
      { buckets: ["snow_overlays"], per100: 0.8, layer: "flat", avoid: [], inside: "road", insideLoose: true, maxCells: 2, scale: [0.9, 1.4], families: 1 },
      { buckets: ["rocks_snow"], per100: 0.3, layer: "flat", avoid: [], inside: "road", insideLoose: true, maxCells: 2, scale: [0.5, 0.75], families: 2 }
    ]
  },

  desert: {
    ground: "desert",
    darkness: 0,
    globalLight: true,
    allowedTones: ["green", "neutral", "autumn"],
    wallTonePrefer: /sandstone|adobe|orange|earthy/,
    road: {
      brush: "road_brush_desert",
      brushTint: "#a3937a",
      tint: "#96876a",
      groundKey: "underground",
      halfWidth: [1.3, 1.7],
      verge: ["cacti", "rocks"],
      debris: ["sticks", "rocks"],
      tracks: ["tracks_sand"]
    },
    scatter: [
      { buckets: ["trees_palm"], per100: 1.3, layer: "tall", overhead: true, avoid: ["road", "reserved", "object"], maxCells: 6, scale: [0.85, 1.1], families: 2, cluster: true },
      { buckets: ["cacti"], per100: 2.2, layer: "mid", avoid: ["road", "reserved", "object"], maxCells: 3, scale: [0.85, 1.25], families: 3, cluster: true },
      { buckets: ["rocks"], per100: 1.6, layer: "mid", avoid: ["road", "reserved", "object"], maxCells: 4, scale: [0.7, 1.1], families: 2 },
      { buckets: ["sand_mounds"], per100: 1.0, layer: "flat", avoid: ["road", "reserved"], maxCells: 2, scale: [0.8, 1.2], families: 2, cluster: true },
      { buckets: ["stalagmites"], per100: 0.4, layer: "mid", avoid: ["road", "reserved", "object"], maxCells: 3, scale: [0.7, 1.0], families: 2 },
      { buckets: ["sticks"], per100: 0.4, layer: "flat", avoid: ["reserved"], maxCells: 3, scale: [0.8, 1.2], families: 1 }
    ]
  },

  arena: {
    special: "arena",
    ground: "desert",
    darkness: 0,
    globalLight: true,
    allowedTones: ["green", "neutral", "autumn"],
    wallTonePrefer: /sandstone|earthy|orange|brick/,
    road: {},
    scatter: [
      // Fighting pit floor: sparse debris of past battles
      { buckets: ["rubble"], per100: 0.5, layer: "flat", avoid: ["object"], inside: "reserved", maxCells: 2, scale: [0.6, 0.9], families: 2 },
      { buckets: ["clutter"], per100: 0.5, layer: "flat", avoid: ["object"], inside: "reserved", maxCells: 2, scale: [0.7, 1.0], families: 2 },
      { buckets: ["rocks"], per100: 0.3, layer: "flat", avoid: ["object"], inside: "reserved", maxCells: 2, scale: [0.5, 0.8], families: 1 },
      // Outside the ring: plain desert with a few rocks and mounds
      { buckets: ["rocks"], per100: 0.6, layer: "mid", avoid: ["reserved", "object"], maxCells: 3, scale: [0.7, 1.0], families: 2 },
      { buckets: ["sand_mounds"], per100: 0.6, layer: "flat", avoid: ["reserved"], maxCells: 2, scale: [0.8, 1.2], families: 2 }
    ]
  },

  dungeon: {
    special: "dungeon",
    ground: "underground",
    darkness: 0.95,
    globalLight: false,
    allowedTones: ["neutral", "green"],
    wallTonePrefer: /stone|slate|brick/,
    road: {},
    scatter: [
      // Everything spawns on the floor cells only ("reserved" = carved floor)
      { buckets: ["webs"], per100: 1.0, layer: "flat", avoid: ["object"], inside: "reserved", maxCells: 2, scale: [0.7, 1.0], families: 1 },
      { buckets: ["rubble"], per100: 1.2, layer: "flat", avoid: ["object"], inside: "reserved", maxCells: 2, scale: [0.7, 1.0], families: 2 },
      { buckets: ["crates", "barrels"], per100: 0.7, layer: "mid", avoid: ["object"], inside: "reserved", exclude: "/filled/|insert|/box_sprays/|/box_stickers/", maxCells: 2, scale: [0.8, 1.0], families: 0 },
      { buckets: ["stalagmites"], per100: 0.8, layer: "mid", avoid: ["object"], inside: "reserved", maxCells: 3, scale: [0.7, 1.1], families: 2 },
      { buckets: ["clutter"], per100: 0.8, layer: "flat", avoid: ["object"], inside: "reserved", maxCells: 2, scale: [0.8, 1.1], families: 3 }
    ]
  }
};

/** Time of day → minimum darkness level */
export const TIMES = { day: 0, dusk: 0.45, night: 0.8 };

export const SEASONS = {
  none: {},
  autumn: {
    // Warm palette: bushes, leaves, flowers AND tree canopies turn autumn
    // (the Woodlands Tree_Red/Multicolor give red crowns to prefer).
    tonePreferOverride: { bushes: "autumn", leaves: "autumn", flowers: "autumn", trees: "autumn" },
    extraScatter: [
      { buckets: ["leaves"], per100: 1.8, layer: "flat", avoid: ["reserved"], maxCells: 4, scale: [0.9, 1.3], families: 2, cluster: true, tonePrefer: "autumn" },
      { buckets: ["trees_bare"], per100: 0.5, layer: "tall", elevation: 20, avoid: ["road", "reserved", "object"], minCells: 6, maxCells: 12, scale: [0.6, 0.8], families: 2, cluster: true }
    ]
  }
};

/** Extra overgrowth inside the ruins footprint */
const RUINS_SCATTER = [
  { buckets: ["plants", "mushrooms"], per100: 1.4, layer: "flat", avoid: [], inside: "reserved", maxCells: 2, scale: [0.8, 1.2], families: 2 },
  { buckets: ["webs"], per100: 0.5, layer: "flat", avoid: [], inside: "reserved", maxCells: 3, scale: [0.9, 1.2], families: 1 },
  { buckets: ["rubble"], per100: 1.0, layer: "flat", avoid: ["object"], inside: "reserved", maxCells: 2, scale: [0.7, 1.0], families: 2 },
  { buckets: ["clutter"], per100: 0.8, layer: "flat", avoid: ["object"], inside: "reserved", maxCells: 2, scale: [0.8, 1.1], families: 3 }
];

/** Extra mood inside the graveyard footprint */
const GRAVEYARD_SCATTER = [
  { buckets: ["webs"], per100: 0.4, layer: "flat", avoid: ["object"], inside: "reserved", maxCells: 3, scale: [0.9, 1.2], families: 1 },
  { buckets: ["mushrooms"], per100: 0.5, layer: "flat", avoid: ["object"], inside: "reserved", maxCells: 2, scale: [0.7, 1.0], families: 1 }
];

export const FEATURE_IDS = ["road", "camp", "ruins", "tavern", "graveyard", "deeper", "lake", "building", "treasure"];
export const BIOME_IDS = Object.keys(BIOMES);
export const SEASON_IDS = Object.keys(SEASONS);
export const TIME_IDS = Object.keys(TIMES);

/**
 * Which controls make sense per biome. The UI hides axes that don't apply
 * (winter has no autumn, a dungeon has no time of day or outdoor features).
 */
export const BIOME_META = {
  forest: { seasons: ["none", "autumn"], time: true, features: ["road", "camp", "ruins", "tavern", "graveyard", "lake", "building"] },
  darkforest: { seasons: ["none", "autumn"], time: true, features: ["road", "camp", "ruins", "tavern", "graveyard", "lake", "building"] },
  winter: { seasons: ["none"], time: true, features: ["road", "camp", "ruins", "tavern", "graveyard", "lake", "building"] },
  desert: { seasons: ["none"], time: true, features: ["road", "camp", "ruins", "tavern", "graveyard", "lake", "building"] },
  arena: { seasons: ["none"], time: true, features: [] },
  dungeon: { seasons: ["none"], time: false, features: ["deeper", "lake", "treasure"] }
};

/** Compose the generation plan from tags. */
export function composeTags({ biome = "forest", season = "none", time = "day", features = [] } = {}) {
  const b = BIOMES[biome] ?? BIOMES.forest;
  const chosen = FEATURE_IDS.filter((f) => features.includes(f));

  const plan = {
    tags: { biome, season, time, features: chosen },
    special: b.special ?? null,
    biome: b.ground,
    groundBucket: b.groundBucket ?? null,
    groundTint: b.groundTint ?? null,
    darkness: Math.max(b.darkness, TIMES[time] ?? 0),
    globalLight: b.globalLight,
    allowedTones: b.allowedTones,
    excludeTones: biome === "winter" ? [] : ["winter"],
    wallTonePrefer: b.wallTonePrefer ?? null,
    road: chosen.includes("road"),
    roadTint: b.road.tint ?? null,
    roadBrush: b.road.brush ?? null,
    roadBrushTint: b.road.brushTint ?? null,
    roadGroundKey: b.road.groundKey ?? null,
    roadHalfWidth: b.road.halfWidth,
    roadVerge: b.road.verge,
    roadDebris: b.road.debris,
    roadTracks: b.road.tracks,
    features: chosen.filter((f) => f !== "road"),
    scatter: b.scatter.map((d) => ({ ...d }))
  };

  const s = SEASONS[season] ?? {};
  if (biome === "forest" || biome === "darkforest") {
    if (s.tonePreferOverride) {
      for (const def of plan.scatter) {
        for (const [bucket, tone] of Object.entries(s.tonePreferOverride)) {
          if (def.buckets.includes(bucket)) def.tonePrefer = tone;
        }
      }
    }
    if (s.extraScatter) plan.scatter.push(...s.extraScatter.map((d) => ({ ...d })));
  }

  if (plan.features.includes("ruins")) plan.scatter.push(...RUINS_SCATTER.map((d) => ({ ...d })));
  if (plan.features.includes("graveyard")) plan.scatter.push(...GRAVEYARD_SCATTER.map((d) => ({ ...d })));
  if (plan.features.includes("camp")) plan.darkness = Math.max(plan.darkness, 0.35);
  if (plan.features.includes("tavern")) plan.darkness = Math.max(plan.darkness, 0.4);

  // Dungeons live underground: no road, no outdoor features. Only the
  // "deeper" flag (a second staircase down to the next level) survives.
  if (plan.special === "dungeon") {
    plan.road = false;
    plan.deeperStairs = plan.features.includes("deeper");
    plan.dungeonLake = plan.features.includes("lake");
    plan.dungeonTreasure = plan.features.includes("treasure");
    plan.features = [];
  }
  // The arena is its own centerpiece: no road, no outdoor features
  if (plan.special === "arena") {
    plan.road = false;
    plan.features = [];
  }

  return plan;
}

/** Old preset ids → tag combos (API backwards compatibility) */
export const LEGACY_PRESETS = {
  forestRoad: { biome: "forest", season: "none", features: ["road"] },
  snowRoad: { biome: "winter", season: "none", features: ["road"] },
  camp: { biome: "forest", season: "none", features: ["camp"] },
  ruins: { biome: "forest", season: "none", features: ["ruins"] },
  tavern: { biome: "forest", season: "none", features: ["tavern"] }
};
