// Counts down to the launch: 4 October 2026, 10:00 EDT (=14:00 UTC).
(() => {
  "use strict";
  const LAUNCH = Date.UTC(2026, 9, 4, 14, 0, 0);
  const root = document.querySelector(".countdown");
  const fields = ["days", "hours", "minutes", "seconds"].map((k) => root.querySelector(`[data-unit="${k}"]`));
  const pad = (n) => String(n).padStart(2, "0");

  function tick() {
    const left = Math.max(0, Math.floor((LAUNCH - Date.now()) / 1000));
    const values = [Math.floor(left / 86400), Math.floor(left / 3600) % 24, Math.floor(left / 60) % 60, left % 60];
    fields.forEach((f, i) => (f.textContent = pad(values[i])));
    if (left === 0) {
      root.hidden = true;
      document.querySelector(".countdown-done").hidden = false;
      return;
    }
    // Wake on the next whole second.
    setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
  }
  tick();
})();
