# sonnet-arena — agent rules

Архитектура, контракты и риски — единый источник в [`PLAN.md`](./PLAN.md). Не дублировать сюда.

## Модель для агентов

**Ultracode/workflow-агенты в этом репо работают только на Sonnet.** При каждом запуске:
- `Agent` tool → параметр `model: "sonnet"` явно
- `Workflow` script → `agent(prompt, { model: "sonnet", ... })` явно на каждом вызове

Никогда не наследовать модель сессии по умолчанию, никогда не Fable/Opus/Haiku для кода в этом репо — даже для «мелких» механических шагов.

## Трекинг milestone'ов

- Issue [#1](https://github.com/serejaris/sonnet-arena/issues/1) — эпик плана, единственный родитель.
- Каждый milestone (M0–M7 из `PLAN.md`) — отдельный sub-issue, привязанный к #1 через `sub_issues` API (не markdown).
- Коммит на milestone: `feat: <milestone> — <что сделано> (refs #N)`; коммит, закрывающий sub-issue: `closes #N` в сообщении.
- При завершении milestone — отметить чеклист в его sub-issue (read-modify-write body, не комментарием) и обновить "Next:" в issue #1.

## Процесс

- Перед началом работы над milestone — проверить открытые sub-issues, не дублировать.
- Коммитить и пушить по ходу — не копить один большой diff на весь milestone.
- Этот файл обновляется по ходу разработки: решения, отклонения от `PLAN.md`, новые конвенции — фиксировать здесь, не только в commit message.

## Известные отклонения от `PLAN.md`

- **Colyseus резолвится в 0.17.x, не 0.14/0.16** — `"colyseus": "*"` в `server/package.json` подтянул `colyseus@0.17.10`. Это меняет два места из контракта в `PLAN.md`:
  - `Room<ArenaState>` не компилируется — generic `Room<T>` в 0.17 принимает options-форму (`{state, metadata, client}`), не голый класс состояния. Используем `Room<{ state: ArenaState }>`.
  - Ручной `http.createServer(app) → httpServer.listen()` молча ломает matchmaking: `WebSocketTransport` вешает свой internal Express app вторым `"request"`-листенером на тот же `http.Server`, и если передать готовый `app` напрямую в `http.createServer`, он 404-ит все `/matchmake/...` маршруты раньше, чем до них доходит Colyseus. Рабочий паттерн: `new Server({ express: (app) => {...} })` (получаем тот же internal app, на который Colyseus сам вешает свои маршруты) + `gameServer.listen(port)` (не `httpServer.listen()` — именно `listen()`/`serverless()` биндит роуты).
- **Клиентский SDK — `@colyseus/sdk`, не `colyseus.js`.** `colyseus.js` заморожен на `0.16.22` и протокол-несовместим с сервером 0.17.x (тихо ломает join). `@colyseus/sdk` — актуальный пакет под тот же протокол, API (`Client`, `joinOrCreate`) идентичен.
- **Версии зависимостей запинены, не `"*"`** — во всех `package.json` (root/client/server) версии зафиксированы на то, что реально резолвнулось при первом `npm install` (см. `package-lock.json`). Решение принято после того, как `"*"` чуть не протащил несовместимый клиентский пакет в M0 незаметно для тайпчекера и сборки — `tsc`/`vite build` не ловят protocol-mismatch, только реальный e2e join.
- **`three-mesh-bvh@0.9.x` — современный API, не `computeBoundsTree()`-на-прототипе из старых туториалов.** `playerController.ts` использует `new MeshBVH(mergedGeometry)` + `shapecast({ intersectsBounds, intersectsTriangle })` напрямую, без monkey-patch `THREE.BufferGeometry.prototype`.
- **`input` message расширен полем `rotY`** (camera yaw, радианы) сверх таблицы `{seq,dx,dz,jump,dt}` из `PLAN.md` — единственный канал, которым клиент сообщает ориентацию (`Player.rotY` в схеме существует именно для этого). `dx`/`dz` — camera-relative скаляры намерения (-1/0/+1, как `moveForward`/`moveRight` в `playerController.ts`), **не** мировые векторы; сервер сам поворачивает их на `rotY`.
- **`Player.lastProcessedInputSeq`** — поле сверх схемы из `PLAN.md`, нужно клиенту для reconciliation (после какого seq можно выкидывать буфер локальных инпутов и реплеить остальные поверх authoritative-позиции).
- **Серверная физика/коллизии — буквальный mirror клиента.** `server/src/physics.ts` (`stepPlayerPhysics`) и `server/src/level.ts` дублируют константы и геометрию `client/src/playerController.ts`/`client/src/level.ts` один в один (включая `THREE.PerspectiveCamera` как scratch-объект для yaw — обычный `THREE.Object3D.getWorldDirection()` не инвертирует знак так, как `THREE.Camera.getWorldDirection()`, и это незаметно ломает direction только в рантайме, не в `tsc`). Геометрия уровня **не** вынесена в shared-пакет — два файла с комментарием «держать в синхроне», осознанный компромисс для one-off демки.
- **Colyseus state-callback API на клиенте — `getStateCallbacks(room)` + `$(...).onAdd/.onRemove/.onChange`** (legacy-callbacks слой `@colyseus/schema`, реэкспортирован из `@colyseus/sdk@0.17.43`), не прямые `.onChange`/`.onAdd` на `MapSchema`.
- **Урон фиксирован в 25/выстрел** (4 попадания = килл при 100hp) — не зафиксировано явно в `PLAN.md`, выбрано как разумный дефолт для казуального arena-шутера; независимо совпало с прецедентом CT242 (`corp-server` ops-заметка про тот демо-шутер тоже использует 25).
- **Серверный cooldown на выстрел — 250ms, по серверному времени** (`Date.now()` на сервере), не по клиентскому `ts` из payload — иначе клиент мог бы соврать про тайминг и обойти rate-limit.
- **`server/src/combat.ts` — closest-point-between-ray-and-capsule-segment**, не точная capsule-ray intersection — для шутера такого темпа достаточно (Ericson's closest-point algorithm), сначала level-obstruction raycast той же `MeshBVH`, что и для коллизий движения, затем тест по каждому живому игроку.
- **`shared-dev environment caveat`:** в этой песочнице локальный Cursor IDE preview-pane сам коннектится к `localhost:2567`/`:5173` и заходит в ту же комнату `"arena"` как третий, неконтролируемый игрок на спавне `(0,0,0)`. При headless-верификации combat/networking — уводить тестовых игроков от дефолтного спавна перед стрельбой, иначе можно перепутать цель (как и произошло один раз при верификации M3, не баг приложения).
- **KayKit Adventurer — native forward = +Z**, не -Z как в конвенции `PLAN.md` § Asset contract. Не меняли глобальную конвенцию — зафиксировали фиксированный 180°-разворот внутри `character.ts`'s network-driven wrapper, конвенция для будущих ассетов (M5+) остаётся -Z.
- **`CHARACTER_SCALE` посчитан по posed bbox (Idle-клип), не по bind-pose T-pose** — T-pose даёт неверную ширину (руки раскинуты, ~1.94m), а не высоту в стойке (2.453m), которая реально нужна для скейла под `CAPSULE_HEIGHT`.
- **Анимация `shoot` для remote-игроков триггерится только на подтверждённый hit** (`hit` broadcast), не на каждый выстрел — miss не транслируется другим клиентам вообще (см. M3), так что бой без подтверждённого попадания визуально не анимируется как выстрел у стороннего наблюдателя. Осознанный пробел, не баг.
- **Level collision geometry не менялась при asset swap** — `client/src/level.ts`/`server/src/level.ts` остаются источником истины для физики; загруженные glTF-пропы — чисто визуальные siblings поверх тех же invisible collision boxes, отмасштабированные под их footprint.

## Headless-верификация клиента

Playwright + закэшированный Chromium доступны на машине (`npx playwright`). Для M1+ клиентских фич верифицировать через headless-браузер (console errors, скриншот рендера, симуляция инпута), не только `tsc`/`vite build` — сборка не ловит runtime-баги (PointerLockControls, BVH-коллизии и т.п.).

**Pointer Lock API не работает под CDP-автоматизацией Chromium** (известное ограничение headless/automation, не баг приложения) — `document.pointerLockElement` остаётся `null` после синтетического клика. Чтобы проверить логику движения, которая гейтится на `controls.isLocked`, нужно симулировать состояние lock вручную: override read-only `document.pointerLockElement` getter + dispatch реального `pointerlockchange` event — это тот же сигнал, на который подписан `PointerLockControls`.

## Updates

- **2026-06-30:** репозиторий сделан публичным (по запросу), файл правил создан, M0–M7 разбиты на sub-issues issue #1.
- **2026-06-30:** M0 реализован и проверен end-to-end (реальный join клиент↔сервер, не только сборка) — client/server скелеты, `closes #2`. Отклонения от `PLAN.md` зафиксированы выше.
- **2026-06-30:** M1 реализован и проверен headless Playwright (рендер уровня, WASD/mouse-look/jump, коллизии со стенами без туннелирования) — `closes #3`. Pointer-lock-в-headless ограничение и приём верификации зафиксированы выше.
- **2026-06-30:** M2 реализован и проверен двумя реальными Playwright-вкладками против реального сервера — `closes #4`. Server-authoritative позиция, client prediction+reconciliation, remote-интерполяция совпадают на всех четырёх измеренных точках (authoritative/predicted/remote-state/remote-render), без рубербендинга. Расширения протокола (`rotY` в input, `lastProcessedInputSeq` в схеме) и mirror-физика зафиксированы выше.
- **2026-06-30:** M3 реализован и проверен двумя реальными Playwright-вкладками — `closes #5`. 4-выстрельный килл (100→75→50→25→0) совпадает на обеих сторонах, kills/deaths кросс-проверены с обеих точек зрения (true server authority), respawn на правильную round-robin точку, miss и obstruction-блокировка через стену подтверждены. По пути починили необработанный `welcome` message (SDK warning на каждом коннекте). Урон/cooldown/closest-point-алгоритм и dev-environment caveat (Cursor preview-pane как третий игрок) зафиксированы выше.
- **2026-06-30:** M6 подготовлен заранее — `corp-server#30` заведён с конкретным live-change планом (CT244, по прецеденту CT242), ждёт явного подтверждения owner перед выполнением live-изменений (provisioning + открытие публичного порта) per corp-server `AGENTS.md` Live Change Policy.
- **2026-07-01:** owner подтвердил M6 — CT244 развёрнут на corp-server, `closes #8`. Node апгрейднут до 22.x (резолвнутый Colyseus требует >=22, шаблон даёт 20.19.2). WS-through-DNAT путь и 35-bot load test подтверждены. Evidence — `corp-server` `ops/2026-07-01-ct244-sonnet-arena-public-preview.md` (закрыт `corp-server#30`).
- **2026-07-01:** M7 — GO, `closes #9`. Полный чеклист (join/движение/4-выстрельный килл/kill-feed/respawn) пройден на живой публичной ссылке двумя реальными Playwright-контекстами через настоящий публичный интернет-путь. **Игра работает по ссылке: `http://51.178.66.9:24480/`.**
- **2026-07-01:** M4 реализован и проверен двумя реальными Playwright-вкладками — `closes #6`. Реальные KayKit/Kenney CC0-модели (Adventurer-персонаж, dungeon-пропы, blaster-оружие) вместо blockout/капсул; коллизии не тронуты (визуальный swap поверх тех же invisible collision boxes). idle/run/death-анимации подтверждены, shoot — best-effort (только на подтверждённый hit). Отклонения зафиксированы выше. Передеплоено на CT244 после коммита.
