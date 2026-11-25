/*
 * Single place to point the client at a backend.
 *
 * Same-origin (default): keep "". The backend serves the client locally.
 * Separate hosting: replace "" with your backend origin, e.g.
 *   window.TF_API_BASE = "https://timsfood-api.up.railway.app";
 *
 * All API requests and MySQL image URLs use this base automatically.
 */
window.TF_API_BASE = window.TF_API_BASE || "";
