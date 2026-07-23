/** Generator window (ApplicationV2, Foundry v13+). */

import { BIOME_IDS, SEASON_IDS, TIME_IDS, FEATURE_IDS, BIOME_META } from "./presets.mjs";
import { buildLibrary, clearLibraryCache } from "./scanner.mjs";
import { generateScene } from "./generator.mjs";
import { makeSeed } from "./rng.mjs";
import { serializeSelection, savePreset, listPresets, deletePreset, PROP_CATEGORIES } from "./props.mjs";

const MODULE_ID = "paradigma-map-generator";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function i18n(key, data) {
  const full = `${MODULE_ID}.${key}`;
  return data ? game.i18n.format(full, data) : game.i18n.localize(full);
}

function cap(id) {
  return `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}

/** Friendly map sizes in cells; "custom" falls back to the advanced inputs */
const MAP_SIZES = {
  small: [24, 18],
  medium: [36, 28],
  large: [48, 36],
  huge: [64, 48]
};

/** Friendly clutter levels → density multiplier; "custom" uses the advanced input */
const FILLS = {
  sparse: 0.6,
  normal: 1,
  dense: 1.6
};

export class GeneratorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: MODULE_ID,
    tag: "form",
    classes: ["paradigma-map-generator"],
    window: {
      title: `${MODULE_ID}.App.Title`,
      icon: "fa-solid fa-wand-magic-sparkles",
      resizable: true
    },
    position: { width: 520 },
    form: {
      handler: GeneratorApp.#onGenerate,
      closeOnSubmit: false,
      submitOnChange: false
    },
    actions: {
      scan: GeneratorApp.#onScan,
      saveProp: GeneratorApp.#onSaveProp,
      managePresets: GeneratorApp.#onManagePresets
    }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/generator.hbs` }
  };

  #busy = false;

  /** Show only the axes that make sense for the chosen biome. */
  #syncBiomeControls() {
    const root = this.element;
    if (!root) return;
    const biome = root.querySelector("[name='biome']")?.value ?? "forest";
    const meta = BIOME_META[biome] ?? BIOME_META.forest;

    // Season: hidden unless the biome has more than one season
    const seasonGroup = root.querySelector("[name='season']")?.closest(".form-group");
    const hasSeason = (meta.seasons?.length ?? 1) > 1;
    if (seasonGroup) {
      seasonGroup.style.display = hasSeason ? "" : "none";
      if (!hasSeason) root.querySelector("[name='season']").value = "none";
    }

    // Time of day: hidden for biomes that ignore it (dungeon)
    const timeGroup = root.querySelector("[name='time']")?.closest(".form-group");
    if (timeGroup) {
      timeGroup.style.display = meta.time ? "" : "none";
      if (!meta.time) root.querySelector("[name='time']").value = "day";
    }

    // Features: show only those valid for the biome, uncheck the rest;
    // hide the whole group when the biome offers none (arena)
    const featGroup = root.querySelector(".pmg-features")?.closest(".form-group");
    if (featGroup) featGroup.style.display = meta.features.length ? "" : "none";
    for (const id of FEATURE_IDS) {
      const box = root.querySelector(`[name='feat-${id}']`);
      const label = box?.closest("label");
      if (!label) continue;
      const allowed = meta.features.includes(id);
      label.style.display = allowed ? "" : "none";
      if (!allowed) box.checked = false;
    }
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const biomeSelect = this.element?.querySelector("[name='biome']");
    biomeSelect?.addEventListener("change", () => this.#syncBiomeControls());
    this.#syncBiomeControls();
  }

  async _prepareContext(_options) {
    return {
      biomes: BIOME_IDS.map((id) => ({
        id,
        label: i18n(`Biome.${cap(id)}`),
        selected: id === "forest"
      })),
      seasons: SEASON_IDS.map((id) => ({
        id,
        label: i18n(`Season.${cap(id)}`),
        selected: id === "none"
      })),
      times: TIME_IDS.map((id) => ({
        id,
        label: i18n(`Time.${cap(id)}`),
        selected: id === "day"
      })),
      mapSizes: [...Object.keys(MAP_SIZES), "custom"].map((id) => ({
        id,
        label: i18n(`Size.${cap(id)}`),
        selected: id === "medium"
      })),
      fills: [...Object.keys(FILLS), "custom"].map((id) => ({
        id,
        label: i18n(`Fill.${cap(id)}`),
        selected: id === "normal"
      })),
      features: FEATURE_IDS.map((id) => ({
        id,
        label: i18n(`Feature.${cap(id)}`),
        checked: id === "road"
      })),
      sceneName: `${i18n("App.SceneNamePrefix")} ${new Date().toLocaleTimeString()}`,
      width: 36,
      height: 28,
      gridSize: Number(game.settings.get(MODULE_ID, "gridSize")) || 100,
      density: 1,
      seed: "",
      assetRoot: game.settings.get(MODULE_ID, "assetRoot"),
      activate: game.settings.get(MODULE_ID, "activateScene")
    };
  }

  #setBusy(busy) {
    this.#busy = busy;
    const button = this.element?.querySelector("button[type='submit']");
    if (button) button.disabled = busy;
  }

  static async #onSaveProp(_event, _target) {
    const preset = serializeSelection();
    if (!preset) {
      ui.notifications.warn(i18n("Notifications.NothingSelected"));
      return;
    }
    const catOptions = PROP_CATEGORIES
      .map((c) => `<option value="${c}">${i18n(`PropCat.${c.charAt(0).toUpperCase()}${c.slice(1)}`)}</option>`)
      .join("");
    const info = i18n("SaveProp.Info", {
      w: preset.cellsW, h: preset.cellsH, tiles: preset.tiles.length, walls: preset.walls.length
    });
    // Per-category note (only stairs need the orientation canon)
    const catHint = (cat) => (cat === "stairs" ? i18n("SaveProp.HintStairs") : "");
    const content = `
      <div class="form-group">
        <label>${i18n("SaveProp.Category")}</label>
        <select name="category">${catOptions}</select>
      </div>
      <div class="form-group">
        <label>${i18n("SaveProp.Name")}</label>
        <input type="text" name="name" value="preset_${Date.now().toString(36)}" />
      </div>
      <p class="notes">${info}</p>
      <p class="notes pmg-cat-hint">${catHint(PROP_CATEGORIES[0])}</p>`;

    const DialogV2 = foundry.applications.api.DialogV2;
    const result = await DialogV2.wait({
      window: { title: i18n("SaveProp.Title") },
      content,
      render: (_e, dialog) => {
        const root = dialog.element ?? dialog;
        const sel = root.querySelector?.("[name='category']");
        const hint = root.querySelector?.(".pmg-cat-hint");
        sel?.addEventListener("change", () => { if (hint) hint.textContent = catHint(sel.value); });
      },
      buttons: [
        { action: "save", label: i18n("SaveProp.Save"), icon: "fa-solid fa-floppy-disk", default: true,
          callback: (_e, button) => ({
            category: button.form.elements.category.value,
            name: button.form.elements.name.value
          }) },
        { action: "cancel", label: i18n("SaveProp.Cancel"), icon: "fa-solid fa-xmark" }
      ]
    }).catch(() => null);
    if (!result || result === "cancel") return;

    try {
      const path = await savePreset(preset, result.category, result.name);
      clearLibraryCache();
      ui.notifications.info(i18n("Notifications.PropSaved", { path }));
    } catch (error) {
      console.error(`${MODULE_ID} | Save preset failed`, error);
      ui.notifications.error(i18n("Notifications.PropSaveFailed"));
    }
  }

  static async #onManagePresets(_event, _target) {
    const render = async () => {
      const grouped = await listPresets();
      const cats = Object.keys(grouped);
      if (!cats.length) return `<p class="notes">${i18n("ManagePresets.Empty")}</p>`;
      return cats.map((cat) => {
        const rows = grouped[cat].map((p) => `
          <div class="pmg-preset-row" style="display:flex;align-items:center;gap:8px;margin:2px 0;">
            <span style="flex:1;">${p.name}</span>
            <button type="button" data-del="${p.path}" style="flex:0 0 auto;width:auto;">
              <i class="fa-solid fa-trash"></i> ${i18n("ManagePresets.Delete")}
            </button>
          </div>`).join("");
        return `<fieldset><legend>${i18n(`PropCat.${cat.charAt(0).toUpperCase()}${cat.slice(1)}`)}</legend>${rows}</fieldset>`;
      }).join("");
    };

    const DialogV2 = foundry.applications.api.DialogV2;
    const dialog = new DialogV2({
      window: { title: i18n("ManagePresets.Title") },
      content: await render(),
      buttons: [{ action: "close", label: i18n("ManagePresets.Close"), default: true }]
    });
    dialog.addEventListener("render", () => {
      const root = dialog.element;
      root.querySelectorAll("[data-del]").forEach((btn) => {
        btn.addEventListener("click", async (ev) => {
          ev.preventDefault();
          const path = btn.getAttribute("data-del");
          await deletePreset(path);
          clearLibraryCache();
          ev.target.closest(".pmg-preset-row")?.remove();
          ui.notifications.info(i18n("Notifications.PresetDeleted"));
        });
      });
    });
    dialog.render(true);
  }

  static async #onScan(_event, _target) {
    if (this.#busy) return;
    const root = String(this.element.querySelector("[name='assetRoot']")?.value || "").trim();
    if (!root) return;
    this.#setBusy(true);
    try {
      clearLibraryCache();
      await buildLibrary(root, { force: true, notify: true });
    } catch (error) {
      console.error(`${MODULE_ID} | Scan failed`, error);
      ui.notifications.error(i18n("Notifications.ScanFailed"));
    } finally {
      this.#setBusy(false);
    }
  }

  static async #onGenerate(_event, _form, formData) {
    if (this.#busy) return;
    const data = formData.object;

    const features = FEATURE_IDS.filter((id) => !!data[`feat-${id}`]);
    // Friendly selects win; "custom" defers to the advanced numeric inputs
    const sizePreset = MAP_SIZES[data.mapSize];
    const width = sizePreset ? sizePreset[0] : (Number(data.width) || 36);
    const height = sizePreset ? sizePreset[1] : (Number(data.height) || 28);
    const density = FILLS[data.fill] ?? (Number(data.density) || 1);

    const options = {
      sceneName: String(data.sceneName || "").trim() || i18n("App.Title"),
      tags: {
        biome: String(data.biome || "forest"),
        season: String(data.season || "none"),
        time: String(data.time || "day"),
        features
      },
      width,
      height,
      gridSize: Number(data.gridSize) || 100,
      density,
      seed: String(data.seed || "").trim() || makeSeed(),
      assetRoot: String(data.assetRoot || "").trim() || game.settings.get(MODULE_ID, "assetRoot"),
      activate: !!data.activate
    };

    await game.settings.set(MODULE_ID, "assetRoot", options.assetRoot);
    await game.settings.set(MODULE_ID, "gridSize", options.gridSize);

    this.#setBusy(true);
    try {
      await generateScene(options);
    } catch (error) {
      console.error(`${MODULE_ID} | Generation failed`, error);
      ui.notifications.error(i18n("Notifications.GenerateFailed", { message: error.message }));
    } finally {
      this.#setBusy(false);
    }
  }
}

let app = null;

export function openGenerator() {
  app ??= new GeneratorApp();
  app.render({ force: true });
  return app;
}
