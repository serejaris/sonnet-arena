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

## Updates

- **2026-06-30:** репозиторий сделан публичным (по запросу), файл правил создан, M0–M7 разбиты на sub-issues issue #1.
- **2026-06-30:** M0 реализован и проверен end-to-end (реальный join клиент↔сервер, не только сборка) — client/server скелеты, `closes #2`. Отклонения от `PLAN.md` зафиксированы выше.
