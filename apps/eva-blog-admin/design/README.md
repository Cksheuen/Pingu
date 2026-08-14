# Private author workspace design source

The private author workspace uses `src/main.js` + `src/styles.css` as its
design source of truth. It is a desktop-first article-writing instrument with a
graphite private archive, ice-white writing desk, pale-blue publication ledger,
cobalt publish action, cyan focus signal, and a GitHub authorization gate.
`src/authorController.js` is the interaction source of truth; it keeps session
and article flows out of the view, while `src/services/authorApi.js` owns the
private API boundary. Status publishing is intentionally designed in the
sibling local app.
