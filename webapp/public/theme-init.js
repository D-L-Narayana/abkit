// Applies the persisted or system colour scheme before the first paint so the page never flashes the wrong theme.
// Served as a static file (see vercel.json) because the production Content-Security-Policy allows only `script-src 'self'`.
(function () {
  try {
    var stored = localStorage.getItem("abkit-theme");
    var dark = stored === "dark" || (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? "#17171c" : "#f7f7f9";
  } catch (e) {
    /* storage unavailable (private mode): fall back to the light theme already in the markup */
  }
})();
