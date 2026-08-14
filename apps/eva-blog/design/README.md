# Public reader design source

The public runtime is intentionally smaller than the original MVP design
gallery. Its source of truth is `src/main.js` + `src/styles.css`, using the
Silverwing direction documented in `docs/design-handoff.md`: pale reader
surfaces, graphite shell, restrained cobalt actions, cyan signal, and no
author/login UI. Private editor and local status layouts live in sibling apps.
