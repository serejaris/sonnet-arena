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

## Headless-верификация клиента

Playwright + закэшированный Chromium доступны на машине (`npx playwright`). Для M1+ клиентских фич верифицировать через headless-браузер (console errors, скриншот рендера, симуляция инпута), не только `tsc`/`vite build` — сборка не ловит runtime-баги (PointerLockControls, BVH-коллизии и т.п.).

**Pointer Lock API не работает под CDP-автоматизацией Chromium** (известное ограничение headless/automation, не баг приложения) — `document.pointerLockElement` остаётся `null` после синтетического клика. Чтобы проверить логику движения, которая гейтится на `controls.isLocked`, нужно симулировать состояние lock вручную: override read-only `document.pointerLockElement` getter + dispatch реального `pointerlockchange` event — это тот же сигнал, на который подписан `PointerLockControls`.

## Updates

- **2026-06-30:** репозиторий сделан публичным (по запросу), файл правил создан, M0–M7 разбиты на sub-issues issue #1.
- **2026-06-30:** M0 реализован и проверен end-to-end (реальный join клиент↔сервер, не только сборка) — client/server скелеты, `closes #2`. Отклонения от `PLAN.md` зафиксированы выше.
- **2026-06-30:** M1 реализован и проверен headless Playwright (рендер уровня, WASD/mouse-look/jump, коллизии со стенами без туннелирования) — `closes #3`. Pointer-lock-в-headless ограничение и приём верификации зафиксированы выше.
- **2026-06-30:** M2 реализован и проверен двумя реальными Playwright-вкладками против реального сервера — `closes #4`. Server-authoritative позиция, client prediction+reconciliation, remote-интерполяция совпадают на всех четырёх измеренных точках (authoritative/predicted/remote-state/remote-render), без рубербендинга. Расширения протокола (`rotY` в input, `lastProcessedInputSeq` в схеме) и mirror-физика зафиксированы выше.
