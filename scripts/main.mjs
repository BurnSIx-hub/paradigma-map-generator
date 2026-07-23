/** Module entry: settings, scene controls, public API. */

import { openGenerator } from "./app.mjs";
import { buildLibrary, clearLibraryCache } from "./scanner.mjs";
import { generateScene } from "./generator.mjs";

const MODULE_ID = "paradigma-map-generator";
const DEFAULT_ASSET_ROOT = "modules/baileywiki-fa-assets/assets";

function i18n(key) {
  return game.i18n.localize(`${MODULE_ID}.${key}`);
}

// i18nInit (not init): translations are loaded here, so setting labels resolve
Hooks.once("i18nInit", () => {
  game.settings.register(MODULE_ID, "assetRoot", {
    name: i18n("Settings.AssetRoot.Name"),
    hint: i18n("Settings.AssetRoot.Hint"),
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_ASSET_ROOT
  });

  game.settings.register(MODULE_ID, "extraAssetRoot", {
    name: i18n("Settings.ExtraAssetRoot.Name"),
    hint: i18n("Settings.ExtraAssetRoot.Hint"),
    scope: "world",
    config: true,
    type: String,
    default: "fa-nexus-assets"
  });

  game.settings.register(MODULE_ID, "propsRoot", {
    name: i18n("Settings.PropsRoot.Name"),
    hint: i18n("Settings.PropsRoot.Hint"),
    scope: "world",
    config: true,
    type: String,
    default: "paradigma-props"
  });

  game.settings.register(MODULE_ID, "audioRoot", {
    name: i18n("Settings.AudioRoot.Name"),
    hint: i18n("Settings.AudioRoot.Hint"),
    scope: "world",
    config: true,
    type: String,
    default: "paradigma-audio"
  });

  game.settings.register(MODULE_ID, "disabledPresets", {
    scope: "world",
    config: false,
    type: Array,
    default: []
  });

  game.settings.register(MODULE_ID, "gridSize", {
    name: i18n("Settings.GridSize.Name"),
    hint: i18n("Settings.GridSize.Hint"),
    scope: "world",
    config: true,
    type: Number,
    default: 100
  });

  game.settings.register(MODULE_ID, "activateScene", {
    name: i18n("Settings.Activate.Name"),
    hint: i18n("Settings.Activate.Hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "faShadows", {
    name: i18n("Settings.FaShadows.Name"),
    hint: i18n("Settings.FaShadows.Hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
});

Hooks.on("getSceneControlButtons", (controls) => {
  if (game.modules.get("burnhub")?.active) return; // с BurnHub кнопка в папке 🔥 Burn
  if (!game.user?.isGM) return; // без BurnHub — своя кнопка (как раньше, только ГМ)

  const tool = {
    name: MODULE_ID,
    title: `${MODULE_ID}.Controls.Open`,
    icon: "fa-solid fa-wand-magic-sparkles",
    button: true,
    order: 100,
    onChange: () => openGenerator(), // v13+
    onClick: () => openGenerator()   // v12
  };

  if (Array.isArray(controls)) {
    // Foundry v12: array of controls, array of tools
    const control = controls.find((c) => c.name === "tiles" || c.name === "scenes");
    control?.tools?.push(tool);
  } else {
    // Foundry v13+: record keyed by name
    const control = controls.tiles ?? controls.scenes ?? Object.values(controls)[0];
    if (control?.tools) control.tools[tool.name] = tool;
  }
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      open: openGenerator,
      generateScene,
      buildLibrary,
      clearLibraryCache
    };
  }
  console.info(`${MODULE_ID} | Ready (v${mod?.version ?? "?"})`);
});

// ─── BurnHub tile (необязательная интеграция: без хаба вызов уходит в никуда) ───
Hooks.once("ready", () => {
  Hooks.callAll("hubRegisterTile", {
    moduleId: "paradigma-map-generator",
    title: "Генератор карт",
    icon: "fa-solid fa-wand-magic-sparkles",
    order: 100,
    gmOnly: true,
    onClick: () => openGenerator()
  });
});
