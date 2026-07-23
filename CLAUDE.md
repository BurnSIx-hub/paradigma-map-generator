# Paradigma Map Generator — ход работы и контекст проекта

Файл-передача контекста между чатами. Проект: модуль Foundry VTT **paradigma-map-generator**
(`E:\FoundryVTT\Data\modules\paradigma-map-generator`), автор Vyazn + Claude.
Текущая версия: **0.19.0**. Система игры пользователя: **dnd5e**. Item Piles v3.3.2.
Сундук-контейнер РАБОТАЕТ (картинка/звук/лут). Сундук повёрнут лицом к двери:
арт смотрит на юг при rotation 0, направление проёма комнаты (floor-клетка снаружи
стены, ближайшая к сундуку) → `{south:0,west:90,north:180,east:270}` в token.rotation. Foundry **v14** (14.364), данные в `E:\FoundryVTT\Data`,
приложение в `E:\Foundry VTT\Foundry Virtual Tabletop\`.

## Что это

Процедурный генератор играбельных сцен из локальных ассетов Forgotten Adventures,
работает в тандеме с модулем **FA Nexus**. Один клик — готовая сцена: земля, дорога,
строения, стены (Foundry Walls), свет (AmbientLight), декорации. Детерминирован по сиду.

## Структура модуля

- `scripts/main.mjs` — регистрация настроек (в хуке `i18nInit`!), кнопка в тулбаре
  Tiles (v13+: `controls.tiles.tools[name] = tool`), API `game.modules.get(id).api`.
- `scripts/app.mjs` — окно генератора (ApplicationV2 + HandlebarsApplicationMixin).
  Динамический UI: `#syncBiomeControls()` скрывает сезон/время/фичи по `BIOME_META`.
  Простые настройки (размер карты/насыщенность селектами) + `<details>` «Расширенные».
  Кнопки: «Сохранить выделение как пресет», «Мои пресеты» (список/удаление).
- `scripts/presets.mjs` — конструктор тегов: `BIOMES` (forest/winter/desert/arena/dungeon),
  `SEASONS` (none/autumn), `TIMES` (day/dusk/night → darkness), `FEATURE_IDS`
  (road/camp/ruins/tavern/graveyard/deeper/lake/building/treasure), `BIOME_META` (оси биома),
  `composeTags()` собирает план генерации. `LEGACY_PRESETS` — совместимость API.
- `scripts/scanner.mjs` — сканер библиотеки: `buildLibrary(root, {extraRoot, propsRoot})`.
  Классификация по правилам путей (`RULES` для baileywiki, `EXTRA_RULES` для fa-nexus-assets).
  Из имени файла: footprint `_ШxВ.webp` → клетки; `family` (для когерентности карты);
  `tones` (цветовые слова → green/autumn/exotic/winter/neutral). Файлы со словом
  "shadow" в имени пропускаются (это отдельные тени FA). Кэш на сессию,
  `clearLibraryCache()` сбрасывает.
  **Бакеты должны быть тематически чистыми** (иначе скаттер сыплет мусор): `clutter`
  исключает `arranged_clutter` (пёстрые кучи еды/посуды с нейтральными именами —
  тон-фильтр их НЕ ловит), food, бинокли/часы; `plants` исключает `water_plants`
  и `/plants/cacti/` (кактусы/кувшинки не должны лезть в лес). Точечная фильтрация
  по контексту — опция `exclude` (regex по `src`) в `ctx.entries()` и в scatter-дефе
  (данж гонит `/filled/|insert` — наполненные яркими товарами бочки/ящики только
  для лагеря/таверны).
- `scripts/generator.mjs` — ядро (~2400 строк). GenerationContext (occupancy-сетка
  OBJ/ROAD/RESERVED, addTile/addSizedTile/addRawTile/addWall/addLight/placeProp),
  канвас-отрисовка (дороги/руины/данж/арена → webp в `Data/paradigma-generated/`
  через FilePicker.upload), фичи, скаттер, generateScene.
- `scripts/props.mjs` — система пользовательских пресетов (см. ниже).
- `scripts/rng.mjs` — mulberry32, сид → детерминизм. `shuffle` (bag-пикер скаттера).
- Звук: `ctx.addSound(x,y,radiusCells,path,{volume,walls,easing})` + `ctx.audioFor(key)`
  (детерминированный выбор через ОТДЕЛЬНЫЙ `ctx.audioRng`, чтобы наличие файла не
  сдвигало раскладку). Бэд биома ставится в конце generateScene (walls/easing off,
  радиус на всю карту), костёр — в placeCamp, факел — на площадке лестницы данжа.
  `createEmbeddedDocuments("AmbientSound", ctx.sounds)` со сценовым оффсетом.
- `templates/generator.hbs` — ЕДИНСТВЕННЫЙ корневой элемент обязателен (AppV2).
- `lang/ru.json`, `lang/en.json` — ключи с префиксом `paradigma-map-generator.`.

## Источники ассетов

1. `modules/baileywiki-fa-assets/assets` — 32k файлов (основной, настройка assetRoot).
2. `Data/fa-nexus-assets` — offline-кэш FA Nexus (~18.5k, настройка extraAssetRoot).
   FA Nexus качает премиум туда (НЕ в папку модуля). Тематические паки: Arctic
   (Snow_Pile, Snow_Disturbed для зимней дороги), Desert (Cracked_Sand — кисть
   пустынной дороги, Tracks_Sand), !Core_Settlements (ленты стен `*_Straight_Path`,
   торцы `*Broken_Ending*`, Rubble, Pillars, Stone_Floors, лестницы Stairs_Stone Wide),
   Mountain и др.
3. `Data/paradigma-props` — пользовательские пресеты (настройка propsRoot).
4. `Data/paradigma-audio` — эмбиент-звуки (настройка audioRoot). Подпапки-биомы
   (forest/winter/desert/dungeon/arena) → фоновый бэд на всю сцену; точечные
   (campfire/torch/water) → позиционные `AmbientSound`. Сканер: `library.audio`
   = {папка: [src...]}. Форматы: ogg/mp3/wav/webm/flac/m4a/opus. Юзер кладёт
   файлы сам (лицензия!), модуль ничего не качает. См. `_HOWTO.md` в папке.

После докачки ассетов нужен рескан («Сканировать ассеты» или F5).

## Система пресетов пользователя (ключевая фича)

Пользователь выделяет на канвасе тайлы (+стены, +свет) → кнопка «Сохранить выделение
как пресет» → категория (stairs / stairs_down / arena / building / decor / trap / misc)
и имя → JSON в `Data/paradigma-props/<категория>/<имя>.json`.

- Сериализация: `serializeSelection()` в props.mjs — координаты относительные,
  gridSize автора; сохраняется elevation тайлов (FA Nexus Alt+scroll) — это порядок слоёв.
- Вставка: `ctx.placeProp(preset, cellX, cellY, deg)` — пересчёт под сетку сцены,
  поворот 0/90/180/270, sort перевыдаётся по (elevation, затем «shadow в имени» сверху,
  затем sort) поверх пола, точность 0.01px (округление до целых даёт щели между частями).
- **Лестницы данжа: пресеты НЕ поворачиваются** (по решению пользователя): категория
  `stairs` = вход, ставится вплотную к ВЕРХНЕЙ стене комнаты; `stairs_down` = спуск,
  рисуется пользователем уже развёрнутым, ставится к НИЖНЕЙ стене. Если stairs_down
  пуст, а тег «Спуск» включён — предупреждение, спуск не ставится.
- Категория `arena` — целый колизей пресетом: ставится по центру карты вместо
  процедурного кольца.
- Удаление: Foundry не умеет удалять файлы через API → «Мои пресеты» ведёт список
  отключённых путей в world-настройке `disabledPresets` (файл остаётся на диске).

## Технические грабли Foundry v14 (важно!)

- **Тайл: x/y = позиция ЯКОРЯ текстуры**, дефолтный якорь 0.5 (центр). Для top-left
  семантики явно ставить anchorX/Y: 0. Ленты земли: зеркальный тайлинг
  (scaleX/scaleY = -1 шахматкой) убирает швы повторов.
- **Padding сцены**: координаты (0,0) — угол внешнего холста; сцена начинается с
  `scene.dimensions.sceneX/sceneY` — все документы смещаются на этот офсет.
- **Кроны деревьев = «верхние» тайлы**: `elevation: 20` (футы) поднимает их над
  токенами → foreground, `occlusion: { mode: FADE }` (CONST.TILE_OCCLUSION_MODES.FADE)
  = затухание всего тайла под токеном. Под каждой кроной на elevation 0 ставится
  пенёк — виден когда крона гаснет. Флаг дефа скаттера: `overhead: true`
  (см. addTile params elevation/occlusion). Бакет пня по типу дерева: пальма →
  `stumps_palm` (Palm_Trunks / fa-nexus /palm_trees/trunks/), биом winter →
  `stumps_snow` (даже голые деревья, иначе коричневый пень на снегу), иначе
  `stumps`. Бакет пня выбирается ЭКСКЛЮЗИВНО (первый непустой, НЕ склеивать —
  иначе коричневый пень в зиме / обычный у пальм). Пни фильтруются на квадратность
  (max/min ≤1.4): вытянутые 1x2/1x4 пальмовые стволы = вид сбоку («лежащая пальма»),
  не срез. Размер ~0.28 кроны, кэп 1.8 клетки. Пень БЕЗ случайного поворота
  (rotation 0): у части срезов кругляш нарисован не по центру спрайта, и поворот
  «выкидывал» его вбок (~15% «уехал влево»). **Голые деревья (`trees_bare`) НЕ
  overhead** — листвы нет, прятать нечего, пень посреди веток смотрится дико.
  (Пробовал в 0.15.5 дробить `Snow_Trees` по подпапкам — юзер откатил, вернул
  единое правило `trees_snow` = вся папка snow_trees overhead+пень.)
- AppV2 части шаблона — один корневой элемент.
- Настройки регистрировать в `i18nInit` (в `init` переводы ещё не загружены).
- FilePicker: `foundry.applications.apps.FilePicker.implementation`.
- FA Nexus тени: `flags["fa-nexus"]` = {shadow:true, shadowAlpha:.55, shadowDilation:1.6,
  shadowBlur:2.2, shadowOffsetDistance:PX(!), shadowOffsetAngle:135, offsetX/Y=cos/sin*dist}.
  **offsetDistance в пикселях, при 0 тень не видна** (прячется под ассетом).
  В коде: "tall" = 0.22*grid, "mid" = 0.11*grid.

## Как устроена генерация (порядок)

Обычные биомы: земля (равные чанки, зеркальный тайлинг) → дорога (прямая или C-дуга,
канвас-кисть: скруглённые стыки, дышащая ширина ±22%, растушёванные края, тёмная колея
+ тёмное mottling — светлые пятна НЕЛЬЗЯ, выглядят артефактом) → планирование фич
(planRect: 60 попыток строго без пересечений, усадка до 60% если не влезает) →
постройка фич → скаттер (кластеры, семейства ≤2-3 на бакет, фильтр тонов).
Скаттер тянет варианты из перемешанного «мешка» (`rng.shuffle`) — каждый ассет
показывается раньше повтора, нет спама одного ящика на макс-насыщенности. Флаг
`inside` = ПОЛНОЕ вхождение футпринта в регион (`occ.contains`, не любая клетка) —
ящики/мусор не свисают на стены; `insideLoose:true` возвращает старое «любая клетка»
(зимние наносы на дороге).

Тона: exotic (purple/teal/blue...) запрещён везде; winter жёстко забанен вне зимы
(`excludeTones`, действует даже при tones:false нельзя — только через toneBanned);
осень переключает кусты/листья на red/orange/yellow. Фичи (мебель, палатки) зовут
entries с `tones: false`.

Фичи: camp (костёр+свет только если "Lit" в имени, палатки кольцом, припасы),
ruins (плита пола канвасом с объеденными краями + ленты стен с обломанными торцами,
митра 45° на углах данжа; режимы "rooms"/"compound"), tavern (префаб Tavern1),
graveyard (ряды надгробий + холмики + саркофаг),
lake (озеро, `placeLake`/`renderLakeTexture` — канвас-блоб воды с вариантом по
`tags.biome`: forest=пруд+кувшинки из `water_plants`, desert=оазis+кольцо пальм,
winter=замёрзшее (лёд+трещины), dungeon=подземное в центральной комнате;
`LAKE_STYLE` (tex-бакет FA Nexus + tint + fallback-палитра), футпринт RESERVED|OBJ
чтоб скаттер не лез; арене недоступно). Заливка — тайлинг-текстуры FA Nexus
(`water_forest`=Aquatic/Textures/Water, `water_desert`=Desert oasis, `water_ice`=
Arctic/Textures/Ice, предпочтение `crack` для зимы; данж=water_forest+тёмный tint).
Текстуры .jpg без footprint → берутся напрямую из `lib.buckets`, НЕ через entries().
**Данж-озеро: флаг `plan.dungeonLake`** (composeTags обнуляет `plan.features=[]` для
данжа, поэтому по features проверять нельзя — был баг, озеро не появлялось).
Форма озера — гладкая кривая (`lakeBlobPath`: точки на эллипсе + quadraticCurveTo
через середины, БЕЗ острых углов; параметр `irregularity` в `LAKE_STYLE`). Данж =
бассейн: `irregularity` 0.05 (почти эллипс) + `rim` (каменный бортик, рисуется до
воды) + тёмный `shore`-ободок + `shape:"rect"` (`lakeRectPath` — скруглённый
прямоугольник). Лес/пустыня: `shore` = тёмная кромка внутри воды + `mud` = тёмное
грязевое кольцо НА ЗЕМЛЕ (blurred stroke до заливки → внешняя половина на грунте).
Декор: `lilypads` на воде, `cattails` (рогоз/камыш) кустами по кромке (лес+оазис),
пальмы у оазиса.

Dungeon (special): комнаты + коридоры (MST), заливка ВСЕХ замкнутых пустот (иначе
фантомные стены), стены из границы пола (митра 45°), двери только на настоящих входах
(ширина ≤2 + проверка глубины коридора), лестницы из пресетов (см. выше), макс. одна
потухшая жаровня, свет только у входа (факелы, только на клетках пола!), темнота 0.95. Тег «Сокровище»
(`plan.dungeonTreasure`): сундук в комнате ДАЛЬШЕ ВСЕГО от входа (по `entranceRoomRef`
— выставляется в ОБЕИХ ветках лестниц: и JSON-пресет, и процедурная. ВАЖНО: блок
должен быть ВНЕ веток if(stairPresets)/else, иначе при наличии пресетов лестниц
сокровище пропускалось — был баг). `pickChestImages` — ТРИ состояния (жёстко Ashen A1, с fallback): closed `..._A1_1x1`,
opened `..._Coins_Mixed`, empty `..._Rusty_Empty_A` из бакета `treasure_chests`.
`buildDungeon` пишет `ctx.treasureSpot`, а `placeTreasureChest` ставит ПОСЛЕ создания
сцены: если активен **Item Piles** — кликабельный контейнер (`game.itempiles.API.
createItemPile`, type "container", closedImage/openedImage/emptyImage + openSound/
closeSound; ДМ кладёт лут). **НЕ передавать `type` в actorOverrides** — Item Piles
создаёт свой актёр, а смена типа документа через update запрещена Foundry (была
ошибка "type of a Document may only be changed..."). Флаги контейнера (верхний
уровень itemPileFlags): `closedImage/openedImage/emptyImage/lockedImage`,
`openSound/closeSound` (singular; подтверждено в item-piles.js). `createItemPile` сам применяет флаги
(видно по `_preloadItemPileFiles` — Item Piles предзагружает closed/open/empty).
НЕ звать `updateItemPile(actor,...)` после — актёр ищется на активной сцене, а
генерённая сцена неактивна → падение `Cannot read ... '_id'`. Рефреш убран. Имя только ГМ:
`tokenOverrides.displayName = TOKEN_DISPLAY_MODES.OWNER`. Иначе — статичный тайл + подсказка
поставить Item Piles. Всё в try/catch с fallback. Звуки сундука: `sounds/chest-open.mp3`,
`sounds/chest-close.mp3` (лежат в модуле).

Arena (special): режимы "pit" (маленькие карты <22) и "roman" (эллипс внешней стены,
трибуны с рядами сидений и 12 клиньями-кунеями на канвасе, подиум-стена, песчаная яма
с mottling, 2 вомитория-коридора с Foundry-дверями на внешних воротах, колонны, статуя,
VIP-ложа: ковёр+кресла, кольцо факелов по трибунам). Вся площадь колизея RESERVED|OBJ —
внешний скаттер не заходит.

## Тестирование (без запуска Foundry)

Нет системного node! Использовать Electron Foundry как node **через Git Bash**
(PowerShell теряет stdout/exit code):
```bash
ELECTRON_RUN_AS_NODE=1 "/e/Foundry VTT/Foundry Virtual Tabletop/Foundry Virtual Tabletop.exe" --check file.mjs
```
Полный стенд со стабами (game/ui/canvas/Scene/FilePicker/fetch, фикстура файловой
системы): `C:\Users\dzonl\AppData\Local\Temp\claude\E--\...\scratchpad\pmg-full-test.mjs`
(путь сессионный — пересоздать при необходимости, структура: стаб FS-дерева ассетов →
import generator/scanner → прогоны всех биомов/тегов + проверки: тон-баны, детерминизм,
лестницы, арена). JSON проверять `JSON.parse(readFileSync...)` тем же способом.

## Рабочий цикл с пользователем

Пользователь тестирует в живом Foundry, кидает скриншоты, говорит по-русски.
После каждой правки: bump версии в module.json + сказать «F5 и перегенерируй»
(шаблоны и библиотека кэшируются). Итерации мелкие и быстрые.

## Известные хвосты / бэклог

- Экзотические листья/цветы без цветового слова в имени (арт цветной, имя нейтральное) —
  тон-фильтр их не ловит; в руинах встречаются розовые/бирюзовые листья.
- Категория `building` ТЕПЕРЬ подставляется: тег «Постройка» (feature "building",
  forest/winter/desert) → `placeBuilding` ставит случайный `building`-пресет юзера
  (planRect minScale:1). Загрузка — `ctx.buildingPresets`. Нет пресетов → warn.
  **Оболочка дома (пол+стены) НЕ тайлами**, а `preset.shell` = {floorSrc, wallSrc,
  runs:[[x1,y1,x2,y2]], floorRect, wallThick}: `renderBuildingShell` ЗАПЕКАЕТ её на
  канвасе тем же кодом, что данж (лента стены тайлится вдоль runs с НАТУРАЛЬНЫМ
  аспектом segW=strip.w*(drawH/strip.h) + митра 45° углов) → монолитная стена
  правильного масштаба. **Ключевой урок: Foundry Tile РАСТЯГИВАЕТ текстуру — стены
  лентами-тайлами всегда кривые/швы; только canvas-bake даёт данж-качество.**
  `preset.tiles` = только мебель (кладётся поверх оболочки placeProp'ом). decor/trap/misc
  всё ещё задел. Скрипт-автор дома: scratchpad/make-house.mjs.
- Идеи пользователя: биомы Горы и Подземелье-пещеры (петлистые дороги — там),
  болото/фейвайлд (паки Swamp/Feywilds стоят), «Привал» (лагерь внутри данжа),
  озеро/пруд, тематические комнаты данжа (сокровищница, тюрьма — ассеты Cells есть).
- Пресет мог бы хранить свой «канон-поворот» (вопрос про поворот лестниц закрыт
  отдельными категориями, но для building-пресетов может всплыть снова).
- Density слайдер не влияет на данж/арену (только scatter) — возможно, стоит расширить.
