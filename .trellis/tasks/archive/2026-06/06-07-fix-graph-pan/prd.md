# Fix graph pan: infinite boundary + correct fit centering

## Bug
After the 06-06 fit-to-view, panning the 關聯圖 broke — once it framed the graph
you couldn't drag (e.g. to the right). Cause: `InteractiveViewer.boundaryMargin`
was a finite `EdgeInsets.all(200)`, which clamps panning right after the initial
centered transform. Also the fit clamped dx/dy to ≥0, mis-centering large graphs.

## Fix
* `boundaryMargin: EdgeInsets.all(double.infinity)` → free panning (graphview's
  own default).
* Remove the dx/dy ≥0 clamp in the fit transform (allow negative = true center).

## Acceptance Criteria
* [ ] Graph opens centered AND pans freely in every direction afterward.
* [ ] analyze + board tests green.
