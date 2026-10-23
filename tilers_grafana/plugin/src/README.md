# Tilers

Opens a Grafana dashboard at `/a/evmain-tilers-app/d/<uid>`, laid out by
[tilers](https://github.com/EV-Main/tilers): panels resize, join as tabs, maximize, and
each browser keeps its own arrangement (`Alt+S`). Panels render through Grafana's own `VizPanel`.

Rows, repeats, library panels, panel links and non-built-in annotations are refused with an error
naming the panel; open such a dashboard natively.
