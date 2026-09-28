import { cabinApi } from "./cabin.js";
import { init as initAvatar } from "./avatar.js";
import "./cognitive.js";
import { init as initUi } from "./ui.js";

/* The view must never die silently: a thrown module or a dead render loop
   leaves a frozen canvas that looks like "nothing is there". Surface any
   error ON the page (a coral strip at the top) so a broken view explains
   itself instead of looking like a missing seat. */
function showViewError(what, err) {
  try {
    var msg = what + "\n" + ((err && (err.stack || err.message)) || err);
    var box = document.getElementById("viewError");
    if (box) {                       /* one strip, never a flood: a dead
                                         render loop throws EVERY frame */
      box.__n = (box.__n || 1) + 1;
      box.textContent = msg + "\n(x" + box.__n + " - same error repeated)";
      return;
    }
    box = document.createElement("div");
    box.id = "viewError";
    box.__n = 1;
    box.setAttribute("role", "alert");
    box.style.cssText = [
      "position:fixed", "top:0", "left:0", "right:0", "z-index:9999",
      "background:#2a0d0e", "color:#FFC4C6", "border-bottom:1px solid #FF9398",
      "font:12px/1.5 Consolas,monospace", "padding:8px 14px",
      "white-space:pre-wrap", "max-height:34vh", "overflow:auto"
    ].join(";");
    box.textContent = msg;
    document.body.appendChild(box);
  } catch (e) { /* nothing left to do */ }
}

window.addEventListener("error", function (ev) {
  showViewError("uncaught", ev.error || ev.message);
});
window.addEventListener("unhandledrejection", function (ev) {
  showViewError("promise rejected", ev.reason);
});

/* the render loop is the other silent failure: if it throws after the first
   requestAnimationFrame, the canvas freezes on its last frame and every
   control looks dead. cabin.js counts its real frames in
   window.__CABIN_FRAMES__ — watch THAT (a separate rAF chain here would
   keep ticking even when cabin.js is dead, proving nothing). */
(function () {
  /* Two things look exactly like a frozen canvas and are not:

     1. a backgrounded tab — rAF is throttled to a stop by design;
     2. an automated headless capture, where the clock is virtual: timers
        fast-forward while rAF only advances on real compositor frames, so
        "three seconds with no frame" elapses in milliseconds.

     Both would paint a red "the canvas is frozen" banner over a cockpit
     that is working perfectly, which is worse than no watchdog at all. So
     measure once whether this page's clock is honest, and only judge the
     loop when it is. */
  var realClock = true;
  (function probe() {
    var t0 = performance.now();
    setTimeout(function () {
      /* asked for 1000ms, got back in under 400ms => the clock is virtual */
      if (performance.now() - t0 < 400) realClock = false;
    }, 1000);
  })();

  var lastCount = -1, lastChange = performance.now();
  (function watch() {
    var n = window.__CABIN_FRAMES__ || 0;
    if (n !== lastCount) { lastCount = n; lastChange = performance.now(); }
    else if (realClock && document.visibilityState === "visible" &&
             performance.now() - lastChange > 3000 && n > 0) {
      showViewError("render loop stopped for " +
        Math.round((performance.now() - lastChange) / 1000) + "s",
        "cabin.js stopped calling requestAnimationFrame — the canvas is frozen");
    } else if (n === lastCount) {
      lastChange = performance.now();   /* hidden or virtual clock: forgive */
    }
    setTimeout(watch, 1000);
  })();
})();

try {
  initAvatar(cabinApi);
  initUi();
  /* Tell the mind what the view actually looks like, so "the seat and the
     avatar are invisible" can be answered with numbers instead of guesses:
     loop alive? rig finite? camera inside? seat toggled off? */
  setTimeout(function () {
    try {
      fetch("/api/viewdiag", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cabinApi.viewDiag())
      }).catch(function () {});
    } catch (e) { /* diagnostics never break the view */ }
  }, 3000);
} catch (err) {
  showViewError("boot failed", err);
  throw err;
}
