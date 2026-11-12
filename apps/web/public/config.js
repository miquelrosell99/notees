// Runtime configuration, overwritten by the web container entrypoint from
// NOTEES_SERVER_URL before nginx starts. Ships empty so /config.js resolves
// in every environment; App treats an absent serverUrl as "no prefill".
window.NOTEES_CONFIG = {};
