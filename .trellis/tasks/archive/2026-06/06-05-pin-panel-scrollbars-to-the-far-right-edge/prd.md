# Pin panel scrollbars to the far right edge

## Goal
Long day reports scroll via the reports panel ListView whose scrollbar tracks the padded content area (not flush right). User wants the scrollbar at the far right edge.

## Requirements
1. _ReportsPanel and _DigestPanel internal ListViews get an explicit Scrollbar pinned flush to the panel right edge: attach a ScrollController, wrap with Scrollbar(thumbVisibility: true on desktop/web), move the horizontal content padding INTO the children (or keep left padding on ListView and only right padding inside children) so the scrollbar gutter sits at the outermost right.
2. Behavior unchanged otherwise; analyze+test green.
