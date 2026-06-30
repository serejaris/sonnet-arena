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

## Updates

- **2026-06-30:** репозиторий сделан публичным (по запросу), файл правил создан, M0–M7 разбиты на sub-issues issue #1.
