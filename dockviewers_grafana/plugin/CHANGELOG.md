# Changelog

## 0.2.1

`precompile` compiles canvases whose buttons clip their own label (a placement shorter than Grafana's button):
only clipping beyond what the content does in an unbounded box counts as not fitting.

## 0.2.0

Panels keep their content as the window shrinks: a tile's floor follows the px its content needs at the live
row height, not the one it was placed at. A panel's `dock` key declares that need — `minW`/`minH` in CSS px for
growable panels (a table's header and first row), or `precompile: true` for content with a natural size (canvas
buttons, text), which the plugin measures once in its slot and caches per browser.

## 0.1.1

The release wasm loads: it is optimized by binaryen 132, where Ubuntu's binaryen broke wasm-bindgen's externref table.

## 0.1.0

First release: dashboards open at `/a/evmain-dockviewers-app/d/<uid>`, laid out by dockviewers.
