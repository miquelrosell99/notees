// Dev placeholder for /config.js.
//
// Production static images (Dockerfile.web) generate this file at container
// start to inject window.__NOTEES_SERVER_URL__ ("" = local-only mode, a URL =
// preconfigured sync server). In dev the file intentionally leaves the
// property undefined so the client keeps its same-origin default. Without
// this file, the dev server's SPA fallback serves index.html for /config.js
// and the browser logs a MIME warning plus "Uncaught SyntaxError: expected
// expression, got '<'".
