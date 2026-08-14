# Local status publisher design source

The local status publisher uses `src/main.js` + `src/styles.css` as its design
source of truth. It is an author control room rather than a generic form: the
device snapshot, background agent heartbeat, safe setup flow, publish action,
and recent public pulses remain visible in one compact Silverwing operational
layout. The CLI itself stays headless and low-memory; the page is the setup and
inspection surface.
