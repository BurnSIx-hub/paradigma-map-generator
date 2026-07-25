/**
 * Asset scanner and classifier for Forgotten Adventures style libraries
 * (baileywiki-fa-assets layout: Flora/Trees, Natural_Decor/Rocks, Maps/grass, ...).
 *
 * Every classified entry: { src, name, w, h } where w/h is the grid footprint
 * parsed from the FA filename suffix `_WxH.webp`.
 */

const MODULE_ID = "paradigma-map-generator";
const IMAGE_EXTS = new Set([".webp", ".png", ".jpg", ".jpeg"]);
const AUDIO_EXTS = new Set([".ogg", ".mp3", ".wav", ".webm", ".flac", ".m4a", ".opus"]);
const FOOTPRINT_RE = /_(\d{1,2})x(\d{1,2})\.[a-z]+$/i;

let cache = null;
let cacheRoot = "";

export function getFilePicker() {
  return foundry.applications?.apps?.FilePicker?.implementation
    ?? foundry.applications?.apps?.FilePicker
    ?? globalThis.FilePicker;
}

function normalizePath(path) {
  return String(path || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Recursively collect image paths (plus any `extra` extensions) under root. */
async function collectFiles(root, { extra = [] } = {}) {
  const FP = getFilePicker();
  const allow = new Set([...IMAGE_EXTS, ...extra]);
  const files = [];
  const queue = [normalizePath(root)];
  const visited = new Set();

  while (queue.length) {
    const target = queue.shift();
    if (!target || visited.has(target)) continue;
    visited.add(target);

    let listing;
    try {
      listing = await FP.browse("data", target);
    } catch (error) {
      console.warn(`${MODULE_ID} | Failed to browse ${target}`, error);
      continue;
    }

    for (const file of listing.files || []) {
      const dot = file.lastIndexOf(".");
      if (dot < 0) continue;
      if (!allow.has(file.slice(dot).toLowerCase())) continue;
      files.push(normalizePath(file));
    }
    for (const dir of listing.dirs || []) queue.push(normalizePath(dir));

    if (files.length && files.length % 4000 === 0) await new Promise((r) => setTimeout(r, 1));
  }
  return files;
}

const FAMILY_RE = /^(.+?)_[A-Z]{1,2}\d{0,3}_\d{1,2}x\d{1,2}\.[a-z]+$/i;

/**
 * Tone classes parsed from FA color words in the filename. The generator
 * filters scatter by allowed tones per biome/season, so purple succulents
 * stay out of a plain forest and snowy assets stay out of summer.
 */
const TONE_MAP = [
  [/green/, "green"],
  [/red|orange|yellow|autumn/, "autumn"],
  [/purple|pink|teal|turquoise|cyan|magenta|blue|violet/, "exotic"],
  [/snowy|snow|frost|ice/, "winter"],
  [/white|gray|grey|black|brown|ashen|dark|earthy/, "neutral"]
];

function makeEntry(src) {
  const name = src.slice(src.lastIndexOf("/") + 1);
  const lowerName = name.toLowerCase();
  const match = name.match(FOOTPRINT_RE);
  // "Bush_Green_A4_2x2.webp" -> family "Bush_Green": lets the generator keep
  // one map to a few coherent asset families instead of rainbow confetti
  const family = name.match(FAMILY_RE)?.[1] ?? name.replace(/_\d{1,2}x\d{1,2}\.[a-z]+$/i, "");
  const tones = TONE_MAP.filter(([re]) => re.test(lowerName)).map(([, tone]) => tone);
  return {
    src,
    name,
    family,
    tones,
    w: match ? Number(match[1]) : null,
    h: match ? Number(match[2]) : null
  };
}

/**
 * Classification rules, first match wins. `test` gets the lowercased path.
 * Bucket names are what presets/generator refer to.
 */
const RULES = [
  { bucket: "trees_snow",   test: (p) => p.includes("/flora/trees/snow_trees/") },
  { bucket: "trees_pine",   test: (p) => p.includes("/flora/trees/pine_trees/") },
  { bucket: "trees_bare",   test: (p) => p.includes("/flora/trees/bare_trees/") },
  // Palm trunk cross-sections (the cut base) — a dedicated stump for palms.
  // Must precede trees_palm, else the /palm_trees/ rule swallows them as trees.
  { bucket: "stumps_palm",  test: (p) => p.includes("/flora/trees/palm_trees/palm_trunks/") },
  { bucket: "trees_palm",   test: (p) => p.includes("/flora/trees/palm_trees/") },
  { bucket: "stumps_snow",  test: (p) => p.includes("/flora/trees/stumps/") && p.includes("snow") },
  { bucket: "stumps",       test: (p) => p.includes("/flora/trees/stumps/") },
  { bucket: "_skip",        test: (p) => p.includes("/flora/trees/tree_shadows/") || p.includes("/flora/trees/tree_tops/") },
  { bucket: "trees",        test: (p) => p.includes("/flora/trees/") },
  { bucket: "bushes_snow",  test: (p) => p.includes("/flora/bushes/") && p.includes("snow") },
  { bucket: "bushes",       test: (p) => p.includes("/flora/bushes/") },
  { bucket: "cacti",        test: (p) => p.includes("/flora/cacti/") },
  { bucket: "sand_mounds",  test: (p) => p.includes("burrow_mound_sand") },
  { bucket: "flowers",      test: (p) => p.includes("/flora/flowers/") },
  { bucket: "mushrooms",    test: (p) => p.includes("/flora/mushrooms_and_fungi/") },
  // Lakeside flora — only wanted around a lake, never in dry scatter. Cattails
  // (Рогоз/камыш) stand at the shore; lilypads float on the water.
  { bucket: "cattails",     test: (p) => p.includes("/water_plants/cattails/") },
  { bucket: "lilypads",     test: (p) => p.includes("/water_plants/") && p.includes("lilypad") },
  { bucket: "water_plants", test: (p) => p.includes("/flora/plants/water_plants/") },
  // Plain plants only. The Plants folder secretly nests Cacti (243 files) and
  // Water_Plants (lilypads/cattails) — those would scatter into a dry forest,
  // so keep them out. Desert cacti come from the dedicated /flora/cacti/ rule.
  { bucket: "plants",       test: (p) => p.includes("/flora/plants/") && !p.includes("/water_plants/") && !p.includes("/plants/cacti/") },
  { bucket: "rocks_snow",   test: (p) => p.includes("/natural_decor/rocks/") && p.includes("snow") },
  { bucket: "rocks",        test: (p) => p.includes("/natural_decor/rocks/") },
  { bucket: "stalagmites",  test: (p) => p.includes("/natural_decor/stalagmites/") },
  { bucket: "logs_snow",    test: (p) => p.includes("/natural_decor/logs/") && p.includes("snow") },
  { bucket: "logs",         test: (p) => p.includes("/natural_decor/logs/") },
  { bucket: "sticks",       test: (p) => p.includes("/natural_decor/sticks_twigs_branches/") },
  { bucket: "leaves",       test: (p) => p.includes("/natural_decor/leaves/") },
  { bucket: "hay",          test: (p) => p.includes("/natural_decor/hay/") },
  { bucket: "tracks",       test: (p) => p.includes("/natural_decor/tracks/") },
  { bucket: "webs",         test: (p) => p.includes("/natural_decor/webs/") },
  { bucket: "campfires_lit",  test: (p) => p.includes("/lightsources/campfires_and_firepits/") && p.includes("_lit_") },
  { bucket: "campfires_cold", test: (p) => p.includes("/lightsources/campfires_and_firepits/") },
  { bucket: "braziers",     test: (p) => p.includes("/lightsources/braziers/") },
  { bucket: "candles",      test: (p) => p.includes("/lightsources/candles/") },
  { bucket: "lanterns",     test: (p) => p.includes("/lightsources/lanterns/") },
  { bucket: "torches_lit",  test: (p) => p.includes("/lightsources/outdoor_torch/") && p.includes("lit") && !p.includes("unlit") },
  { bucket: "torches_cold", test: (p) => p.includes("/lightsources/outdoor_torch/") },
  { bucket: "tents",        test: (p) => p.includes("/temporary_shelter/tents/") },
  { bucket: "carts",        test: (p) => p.includes("/vehicles/carts_and_wagons/") },
  { bucket: "barrels",      test: (p) => p.includes("/decor/storage/barrels/") },
  { bucket: "crates",       test: (p) => p.includes("/decor/storage/boxes_and_crates/") },
  // Treasure chests — matched closed/open (Empty/Coins) pairs for the loot chest
  { bucket: "treasure_chests", test: (p) => p.includes("/chests/treasure_chests/") },
  { bucket: "storage",      test: (p) => p.includes("/decor/storage/") },
  { bucket: "tables",       test: (p) => p.includes("/furniture/tables/") },
  { bucket: "seating",      test: (p) => p.includes("/furniture/seating/") },
  { bucket: "counters",     test: (p) => p.includes("/furniture/bars_and_counters/") },
  { bucket: "shelves",      test: (p) => p.includes("/furniture/shelves/") },
  { bucket: "bedding",      test: (p) => p.includes("/furniture/bedding/") },
  // Clutter, but only the muted "someone was here" debris (backpacks, bedrolls,
  // tools, traps, waterskins, journals, locks). The Arranged_Clutter piles are
  // colourful food/dishware spreads with neutral filenames the tone filter
  // can't catch — they read as random confetti dumped in a dungeon. Food and
  // anachronistic gadgets (binoculars/watches) are dropped too.
  { bucket: "clutter",      test: (p) => p.includes("/decor/clutter/")
      && !p.includes("/arranged_clutter/")
      && !p.includes("/adventuring_gear/food/")
      && !/\/(binoculars|watches)\//.test(p) },
  { bucket: "rugs",         test: (p) => p.includes("rug_") && !/edge|path|connector/.test(p) },
  { bucket: "statues",      test: (p) => p.includes("statue") && !/broken|fallen/.test(p) }
];

const BIOME_RE = /\/maps\/([^/]+)\/[^/]+$/;

/**
 * Rules for the extra root (Data/fa-nexus-assets — FA theme packs like Arctic).
 * Only a curated subset is picked up, so Horror/Volcanic themes don't pollute
 * the generic buckets.
 */
const EXTRA_RULES = [
  { bucket: "road_brush_snow", test: (p) => p.includes("/textures/snow/") && p.includes("disturbed") },
  { bucket: "road_brush_desert", test: (p) => p.includes("/textures/sand/") && p.includes("cracked") },
  // Dark-forest trail: Woodlands dirt (cracked / grassy) as the road brush
  { bucket: "road_brush_forest", test: (p) => p.includes("/woodlands/") && p.includes("/textures/dirt/") },
  { bucket: "tracks_sand",   test: (p) => p.includes("tracks_sand_") },
  { bucket: "snow_piles",    test: (p) => p.includes("snow_pile") },
  { bucket: "snow_overlays", test: (p) => p.includes("snow_patchy_overlay") },
  { bucket: "snow_edges",    test: (p) => p.includes("snow_edge") },
  { bucket: "tracks_snow",   test: (p) => p.includes("tracks") && p.includes("snow") },
  // Water / ice surface textures (tiling .jpg) used as the lake fill. Accessed
  // directly via lib.buckets (no _WxH footprint, so entries() would skip them).
  // Dark-forest floor texture (Woodlands pack): leafy forest floor / grassy dirt
  { bucket: "ground_darkforest", test: (p) => p.includes("/woodlands/") && (p.includes("/textures/forest/") || p.includes("/textures/dirt/grassy")) },
  // Woodlands trees add the variety baileywiki lacks (only 3 pines): red/autumn
  // and multicolor canopies, plus more bare trees / logs / stumps.
  { bucket: "trees_bare", test: (p) => p.includes("/woodlands/") && p.includes("/flora/trees/bare_trees/") },
  { bucket: "logs",       test: (p) => p.includes("/woodlands/") && p.includes("/flora/trees/logs/") },
  { bucket: "stumps",     test: (p) => p.includes("/woodlands/") && p.includes("/flora/trees/stumps/") },
  { bucket: "trees",      test: (p) => p.includes("/woodlands/") && p.includes("/flora/trees/") },
  { bucket: "water_forest",  test: (p) => p.includes("/aquatic/") && p.includes("/textures/water/") },
  { bucket: "water_desert",  test: (p) => p.includes("/desert/") && p.includes("/textures/water/") },
  { bucket: "water_ice",     test: (p) => p.includes("/arctic/") && p.includes("/textures/ice/") },
  // Palm trunk cross-sections from the FA Nexus desert pack (round cut bases),
  // not the 1x4 fallen Logs — those are a different thing.
  { bucket: "stumps_palm",   test: (p) => p.includes("/palm_trees/trunks/") && !p.includes("/logs/") },
  // Modular building parts (FA settlement packs) — the ruins builder
  { bucket: "ruin_wall_strip",  test: (p) => p.includes("/walls_and_curbs/") && p.includes("straight_path") && !/bloody|chains|ceremorph/.test(p) },
  { bucket: "ruin_wall_ending", test: (p) => p.includes("broken_ending") },
  { bucket: "ruin_floor_tex",   test: (p) => p.includes("/textures/stone_floors/") && p.endsWith(".jpg") },
  { bucket: "rubble",           test: (p) => p.includes("rubble_") },
  { bucket: "pillars_broken",   test: (p) => p.includes("/pillars/") && p.includes("broken") },
  { bucket: "pillars",          test: (p) => p.includes("/pillars/") && !p.includes("broken") },
  // Full staircase tiles (steps run across, descent along the long axis) —
  // "wide" variants preferred; skip modular corner/diagonal pieces
  { bucket: "stairs",       test: (p) => /\/stairs_(stone|metal|wood)\//.test(p) && /_\dx\d\.[a-z]+$/.test(p) && !/corner|diagonal|connector|ending|offset|turn|railing|pillar|spiral|path/.test(p) },
  // Tribune dressing
  { bucket: "rugs",         test: (p) => p.includes("/rugs_and_carpets/") && !/edge|path|connector/.test(p) },
  { bucket: "statues",      test: (p) => p.includes("statue") && !/broken|fallen/.test(p) },
  // Graveyard parts
  { bucket: "tombstones",   test: (p) => p.includes("tombstone") },
  { bucket: "dirt_piles",   test: (p) => p.includes("pile_dirt") },
  { bucket: "sarcophagi",   test: (p) => p.includes("sarcophagus") }
];

/**
 * Scan + classify the asset root. Returns the library:
 * {
 *   root, total,
 *   ground: { grass: src, snow: src, ... },
 *   buckets: { trees_pine: [entry...], rocks: [...], ... },
 *   tavern: { bg, lightsOn: [], lightsOff: [], roof }
 * }
 */
export async function buildLibrary(root, { force = false, notify = false, extraRoot, propsRoot, audioRoot } = {}) {
  const normalizedRoot = normalizePath(root);
  const normalizedExtra = normalizePath(
    extraRoot ?? (globalThis.game?.settings?.get?.(MODULE_ID, "extraAssetRoot") ?? "")
  );
  const normalizedProps = normalizePath(
    propsRoot ?? (globalThis.game?.settings?.get?.(MODULE_ID, "propsRoot") ?? "")
  );
  const normalizedAudio = normalizePath(
    audioRoot ?? (globalThis.game?.settings?.get?.(MODULE_ID, "audioRoot") ?? "")
  );
  const cacheKey = `${normalizedRoot}|${normalizedExtra}|${normalizedProps}|${normalizedAudio}`;
  if (!force && cache && cacheRoot === cacheKey) return cache;

  if (notify) ui.notifications.info(game.i18n.localize(`${MODULE_ID}.Notifications.ScanStarted`));

  const files = await collectFiles(normalizedRoot);
  const library = { root: normalizedRoot, total: files.length, ground: {}, buckets: {}, tavern: { bg: null, lightsOn: [], lightsOff: [], roof: null } };

  // Extra root: FA theme packs, curated buckets only
  if (normalizedExtra) {
    const extraFiles = await collectFiles(normalizedExtra);
    library.total += extraFiles.length;
    for (const src of extraFiles) {
      const lower = `/${src.toLowerCase()}`;
      const rule = EXTRA_RULES.find((r) => r.test(lower));
      if (!rule) continue;
      (library.buckets[rule.bucket] ??= []).push(makeEntry(src));
    }
  }

  // Props root: user-authored prefabs.
  //  - flat images with a _WxH suffix in a stairs/ folder -> custom_stairs
  //  - .json presets (saved from a selection) -> presets[category]
  library.presets = {};
  const disabledPresets = new Set(globalThis.game?.settings?.get?.(MODULE_ID, "disabledPresets") ?? []);
  if (normalizedProps) {
    const propFiles = await collectFiles(normalizedProps, { extra: [".json"] });
    for (const src of propFiles) {
      const lower = src.toLowerCase();
      if (lower.endsWith(".json")) {
        if (disabledPresets.has(normalizePath(src))) continue;
        // category = folder immediately under the props root
        const rel = normalizePath(src).slice(normalizedProps.length + 1);
        const category = rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : "misc";
        (library.presets[category] ??= []).push(src);
      } else if (lower.includes("/stairs/")) {
        const entry = makeEntry(src);
        if (entry.w && entry.h) (library.buckets.custom_stairs ??= []).push(entry);
      }
    }
  }

  // Audio root: user-dropped ambience, grouped by the folder right under the
  // root. So Data/paradigma-audio/forest/*.ogg -> audio.forest (a whole-scene
  // bed for the forest biome), .../campfire/*.ogg -> audio.campfire (positional
  // emitter at camp fires). Biome-locked by folder: no birdsong in a dungeon.
  library.audio = {};
  if (normalizedAudio) {
    const audioFiles = await collectFiles(normalizedAudio, { extra: [...AUDIO_EXTS] });
    for (const src of audioFiles) {
      const lower = src.toLowerCase();
      const dot = lower.lastIndexOf(".");
      if (dot < 0 || !AUDIO_EXTS.has(lower.slice(dot))) continue;
      const rel = normalizePath(src).slice(normalizedAudio.length + 1);
      const key = (rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : "misc").toLowerCase();
      (library.audio[key] ??= []).push(src);
    }
  }

  for (const src of files) {
    const lower = `/${src.toLowerCase()}`;

    // Standalone baked-shadow images (Pine_Shadow_*, Tree_Shadows/*) are not objects
    if (lower.includes("shadow")) continue;

    const biome = lower.match(BIOME_RE);
    if (biome) {
      library.ground[biome[1]] = src;
      continue;
    }

    if (lower.includes("/buildings/tavern/")) {
      const name = lower.slice(lower.lastIndexOf("/") + 1);
      if (name.startsWith("bg.")) library.tavern.bg = src;
      else if (name.includes("on.")) library.tavern.lightsOn.push(src);
      else if (name.includes("off.")) library.tavern.lightsOff.push(src);
      else if (name.startsWith("roof")) library.tavern.roof = src;
      continue;
    }

    const rule = RULES.find((r) => r.test(lower));
    if (!rule || rule.bucket === "_skip") continue;

    const entry = makeEntry(src);
    (library.buckets[rule.bucket] ??= []).push(entry);
  }

  cache = library;
  cacheRoot = cacheKey;

  if (notify) {
    ui.notifications.info(game.i18n.format(`${MODULE_ID}.Notifications.ScanDone`, {
      count: library.total,
      buckets: Object.keys(library.buckets).length
    }));
  }
  console.info(`${MODULE_ID} | Library built:`, {
    total: library.total,
    ground: Object.keys(library.ground),
    buckets: Object.fromEntries(Object.entries(library.buckets).map(([k, v]) => [k, v.length]))
  });
  return library;
}

export function clearLibraryCache() {
  cache = null;
  cacheRoot = "";
}
