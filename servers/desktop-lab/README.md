# desktop-lab

`desktop-lab` inspects explicitly configured desktop applications and offers capability-gated launch,
stop, and screenshot capture. It never sends keyboard or mouse input and never requests elevation.

Launch and stop use short-lived plans bound to the matching process set. Screenshots are stored below
the configured `stateDir` with a size limit and returned through a `desktop-lab://artifacts/...` resource.
Missing window, logging, crash, or screenshot backends return a structured capability error.
