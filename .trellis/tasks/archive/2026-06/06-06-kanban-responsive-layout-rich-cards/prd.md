# Kanban: responsive layout + rich cards

## User feedback (regression from the prototype-faithful restyle)

1. 排版壞了 — the prototype is a mobile-width mock; its fixed ~150dp columns
   leave a desktop window mostly empty. Layout must be responsive.
2. Cards lost their work details — the old cards showed title + description;
   the user wants: 工作摘要 (description), 負責人 (assignee), plus indicators
   for 交接文件 (handoffDoc) and 依賴關係 (dependsOn).

## Requirements

1. **Responsive columns** (LayoutBuilder): when the viewport fits
   3 × minColumnWidth (~260dp) + gaps → three Expanded columns filling the
   width (desktop/tablet); otherwise fixed-width horizontally scrolling
   columns (~150-260dp, phone). Keep the new tonal headers / count chips /
   CJK labels / empty state / FAB / DnD behavior in BOTH modes.
2. **Rich cards** (both modes): title (w600, up to 2 lines); description
   snippet (2 lines, omitted when empty); bottom row: left = small badges —
   link icon + count when dependsOn.isNotEmpty, description/article icon
   when handoffDoc != null; right = assignee chip (initial circle as today;
   show it with a short label when resolvable cheaply). Keep tap → details
   and LongPressDraggable (feedback card must render the rich card too,
   constrained to column width).
3. Tests: existing tasks_board_test.dart adapted; add: description renders
   on a card; deps/handoff badges appear for a fake task that has them; wide
   layout uses fill mode (pump with a wide surface and assert no horizontal
   scrollable / columns present), narrow shows the scroll mode.

## Acceptance Criteria

* [ ] Desktop-width window: three columns fill the page; no broken/cramped
  left-hugging layout. Narrow window still scrolls horizontally.
* [ ] Cards show 摘要/負責人/交接/依賴 indicators as specified.
* [ ] DnD still updates status in both modes.
* [ ] flutter analyze (known info only) + flutter test green.
