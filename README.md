# Paradigma Map Generator

Procedural Foundry VTT (v13/v14) scene generator for local Forgotten Adventures /
FA Nexus compatible asset libraries (baileywiki-fa-assets layout).

## ⚠️ Requirements / Требуется

**EN:** This module is **code only** — it does **not** bundle or distribute any
art. It composes maps from asset packs you must own and install yourself:
**Forgotten Adventures** assets in the `baileywiki-fa-assets` layout and/or the
**FA Nexus** offline cache. Without those installed, the generator has nothing to
place. This module ships no third-party art; you are responsible for owning the
asset packs you use.

**RU:** Это модуль **только с кодом** — он **не** содержит и не распространяет
никаких артов. Карты собираются из ассет-паков, которые вы устанавливаете сами:
ассеты **Forgotten Adventures** в раскладке `baileywiki-fa-assets` и/или
офлайн-кэш **FA Nexus**. Без них генератору нечего расставлять. Чужие арты в
модуль не входят — за наличие лицензий на ассеты отвечаете вы.

## What it does

One click creates a ready-to-play scene:

- **Ground** — seamless FA ground textures (grass / snow / desert / underground)
- **Road** — smooth procedural road with cart tracks (forest / snow presets)
- **Features** — camp (campfire, tents, supplies, torches), ruins (broken boulder
  walls with real Foundry walls), tavern (prefab interior, furniture, door, lights)
- **Scatter** — trees, bushes, rocks, flowers and debris with collision avoidance
- **Walls & lights** — Foundry `Wall` and `AmbientLight` documents where the preset
  calls for them (campfire glow, table candles, ruin cover)

Same seed + same settings = the same map. The seed used is shown in the
"done" notification so any result can be reproduced.

## FA Nexus integration

Placed object tiles carry `flags.fa-nexus` shadow settings (FA Nexus defaults),
so FA Nexus renders its elevation-based drop shadows for generated trees and
furniture, and every tile shows up in the FA Nexus Layer Manager for further
editing. Can be turned off via the "FA Nexus shadows" module setting.

The module does not modify FA Nexus and works without it (shadows are simply skipped).

## Usage

1. Enable the module (recommends `fa-nexus` and `baileywiki-fa-assets`).
2. Open the **Tiles** scene controls — click the wand button.
3. Pick a preset, size and density, optionally a seed, press **Generate scene**.

API: `game.modules.get("paradigma-map-generator").api` → `open()`,
`generateScene(options)`, `buildLibrary(root)`, `clearLibraryCache()`.

All generated documents are tagged with `flags["paradigma-map-generator"].generated`
for easy bulk cleanup.

## Presets

| Preset | Ground | Extras |
|---|---|---|
| Forest road | grass | road + tracks, dense pines |
| Snow road | snow | road + tracks, snow trees |
| Camp | grass | campfire + light, tents, logs, supplies, torches |
| Ruins | grass | broken boulder perimeter + Foundry walls, overgrowth |
| Tavern | underground | Tavern1 prefab, furniture, candles, walls + door, hidden roof tile |
