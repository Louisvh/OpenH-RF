// B-mode collage
(() => {
  "use strict";
  const SLOTS = 4, FADE = 500, MIN_HOLD = 1000, MAX_HOLD = 3500;
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const banner = document.querySelector(".hero-examples"), track = banner.querySelector(".hero-track");

  // First load the small RF version, then the big one after everything has loaded.
  const fullRf = () => {
    const full = new Image();
    full.src = "assets/img/examples-rf@2x.webp";
    full.decode().then(() => banner.classList.add("rf-full"), () => {});
  };
  if (document.readyState === "complete") fullRf();
  else addEventListener("load", fullRf, { once: true });

  const twins = new Map();
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const slots = Array.from({ length: SLOTS }, () => ({ shown: null, fading: null, timer: 0 }));
  let held = null, hovering = false, touching = false;

  fetch("assets/img/examples.json")
    .then((resp) => resp.json())
    .then(({ size: [W, H], tiles }) => {
      const sets = $$(".hero-set", track).map((set) =>
        tiles.map(([, x, y, w, h]) => {
          const tile = document.createElement("div");
          tile.className = "hero-tile";
          tile.setAttribute("aria-hidden", "true");
          tile.style.cssText = `left: ${(100 * x) / W}%; top: ${(100 * y) / H}%; width: ${(100 * w) / W}%; height: ${(100 * h) / H}%;` +
            ` background-size: ${(100 * W) / w}% ${(100 * H) / h}%; background-position: ${(100 * x) / (W - w)}% ${(100 * y) / (H - h)}%`;
          return set.appendChild(tile);
        }),
      );
      for (let i = 0; i < tiles.length; i++) {
        const pair = [sets[0][i], sets[1][i]];
        for (const t of pair) twins.set(t, pair);
      }
      // The page opens with the tiles already shown, skip fade in.
      for (const slot of slots) next(slot, 0);
      for (const a of track.getAnimations({ subtree: true })) if (a instanceof CSSTransition) a.finish();
    });

  const setClass = (tile, cls, on) => {
    if (tile) for (const t of twins.get(tile)) t.classList.toggle(cls, on);
  };
  const primary = (tile) => (tile ? twins.get(tile)[0] : null);
  const idle = () => !reduce.matches && !hovering && !touching;
  const randomHold = () => MIN_HOLD + Math.random() * (MAX_HOLD - MIN_HOLD);
  const visible = (ms) => {
    const box = banner.getBoundingClientRect();
    const { animationName, animationDuration } = getComputedStyle(track);
    const pxPerSec = animationName === "none" ? 0 : track.offsetWidth / 2 / parseFloat(animationDuration);
    return $$(".hero-tile", track).filter((t) => {
      const r = t.getBoundingClientRect();
      return r.width && r.left >= box.left + (pxPerSec * ms) / 1000 && r.right <= box.right;
    });
  };
  function next(slot, fadeIn = FADE) {
    clearTimeout(slot.timer);
    setClass(slot.fading, "auto", false);
    setClass(slot.shown, "on", false);
    slot.fading = slot.shown;
    slot.shown = null;
    if (!idle()) return;
    const hold = randomHold();
    const taken = slots.flatMap((s) => [s.shown, s.fading]);
    const pool = visible(fadeIn + hold + FADE).map(primary).filter((t) => !taken.includes(t));
    if (pool.length === 0) {
      slot.timer = setTimeout(() => next(slot), 500);
      return;
    }
    slot.shown = pool[Math.floor(Math.random() * pool.length)];
    setClass(slot.shown, "auto", true);
    setClass(slot.shown, "on", true);
    slot.timer = setTimeout(() => next(slot), fadeIn + hold);
  }
  reduce.addEventListener("change", () => {
    for (const slot of slots) next(slot);
  });
  const pause = () => {
    for (const slot of slots) clearTimeout(slot.timer);
  };
  const resume = () => {
    if (!idle()) return;
    for (const slot of slots) {
      if (slot.shown) {
        setClass(slot.shown, "auto", true);
        slot.timer = setTimeout(() => next(slot), randomHold());
      } else {
        next(slot);
      }
    }
  };
  const pointAt = (tile) => {
    tile = primary(tile);
    if (!tile) return null;
    for (const slot of slots) {
      for (const t of [slot.shown, slot.fading]) {
        if (t && t !== tile) {
          setClass(t, "auto", false);
          setClass(t, "on", false);
        }
      }
      if (slot.shown !== tile) slot.shown = null;
      slot.fading = null;
    }
    setClass(tile, "auto", false);
    return tile;
  };

  track.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "mouse") return;
    hovering = true;
    pause();
  });
  track.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    hovering = false;
    resume();
  });
  track.addEventListener("pointerover", (e) => {
    if (e.pointerType === "mouse") pointAt(e.target.closest(".hero-tile"));
  });

  const touch = (e) => {
    touching = e.touches.length > 0;
    banner.classList.toggle("touching", touching);
    if (e.type === "touchstart" && e.touches.length === 1) pause();
    const p = e.touches[0], box = banner.getBoundingClientRect();
    const inside = p && p.clientX >= box.left && p.clientX < box.right && p.clientY >= box.top && p.clientY < box.bottom;
    const tile = inside ? pointAt(document.elementFromPoint(p.clientX, p.clientY)?.closest(".hero-tile")) : null;
    if (tile !== held) {
      setClass(held, "held", false);
      held = tile;
      setClass(held, "held", true);
    }
    if (!touching) resume();
  };
  for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) document.addEventListener(type, touch, { passive: true });
  banner.addEventListener("contextmenu", (e) => {
    if (held) e.preventDefault();
  });
})();
