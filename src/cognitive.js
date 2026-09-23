/* ========================================================================= *
 * cognitive.js — VIEW ADAPTER (the mind lives in Python now)
 *
 * The BDI mind, ride script, memory, mood/trust dynamics and experimenter
 * chat were ported to Python (cabin_sim/cognition.py) and are authoritative
 * there. This file is now a *thin view*: it draws and reports, it does not
 * reason.
 *
 *   poll  GET  /api/snapshot   ->  V (view mirror)  ->  render + __COG_LIVE__
 *   input POST /api/seat       ->  clamped by world.Seat, marks user_hands
 *   chat  POST /api/chat       ->  mind.chat_send (legacy hook shape kept)
 *   ctrl  POST /api/control    ->  play / pause / skip-setup / reset
 *
 * Everything below either (a) renders V, (b) forwards user input, or
 * (c) publishes the live store other modules read (__COG_LIVE__ etc.).
 * No formulas here decide anything — display-only lookups (rate tables,
 * timeline markers, gauge fit text) are marked as such.
 *
 * The pre-port mind is preserved next door in cognitive.legacy.js.
 * ========================================================================= */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  /* ===== display-only reference data (gauges / rail / timeline dots) ===== */
  var ROT = [[0,1.0],[30,0.5],[60,0.1429],[90,0.4286],[120,0.2143],[150,0.4286],[180,0.6071],[210,0.4286],[240,0.5333],[270,0.6],[300,0.2857],[330,0.8462],[360,1.0]];
  var HGT = [[38,0.4545],[40,0.2955],[42,0.1818],[44,0.04545],[46,0.02273]];
  function rate(tbl, x) {                 /* clamped piecewise-linear lookup */
    var f = tbl[0], l = tbl[tbl.length - 1];
    if (x <= f[0]) return f[1];
    if (x >= l[0]) return l[1];
    for (var i = 0; i < tbl.length - 1; i++) {
      var a = tbl[i], b = tbl[i + 1];
      if (x >= a[0] && x <= b[0]) return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
    }
    return f[1];
  }
  var RIDE_START = 120, RIDE_END = 600;   /* ride script length (timeline) */
  var EVENTS = [                          /* markers only — fired server-side */
    { t: 121, kind: "depart" }, { t: 158, kind: "merge" }, { t: 200, kind: "curve" },
    { t: 258, kind: "bump" }, { t: 292, kind: "overtake" }, { t: 340, kind: "smooth" },
    { t: 386, kind: "curve" }, { t: 425, kind: "brake" }, { t: 470, kind: "workzone" },
    { t: 520, kind: "smooth" }, { t: 550, kind: "rain" }, { t: 575, kind: "brake" },
    { t: 590, kind: "arrive" }
  ];
  var THOUGHTS = {                        /* end-of-ride remarks (display) */
    endGood: ["I'd take another ride.", "That's a keeper, honestly."],
    endMid: ["Mostly fine. A few minutes were iffy.", "Decent enough ride."],
    endBad: ["I'd rather drive myself next time.", "Got out a little wary."]
  };
  var INTENT_LABELS = {
    settle: "settle the seat",
    attend: "attend to the road",
    calibrate: "calibrate trust in the cabin"
  };

  /* ===== view state: a mirror of the last snapshot (never reasoned about) */
  var V = {
    rot: 90, hgt: 38, sl: 3, t: 0, running: true, phase: "setup", done: false,
    speed: 0, g: 0, jolt: 0, rain: 0, kind: "",
    traits: [],
    mood: { comfort: 0.4, energy: 0.6, suspicion: 0.5 },
    trust: { score: null, live: null },
    prefs: { rot: 0, hgt: 44, tolRot: 20, tolHgt: 2 },
    bdi: { intention: null, since: 0 },
    memory: [], forgot: [], forgotCount: 0,
    thoughts: [], speech: "", module: "", log: [], chat: [],
    samples: [], trail: [], priors: null
  };
  var anim = 0;                            /* local animation clock (camera sway) */
  var online = false;
  var lastEvtKey = "";                     /* event banner trigger */
  var finishedShown = false;

  function fmtTime(t) {
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return (m < 10 ? "0" + m : m) + ":" + (s < 10 ? "0" + s : s);
  }

  /* ===== snapshot -> V : the ONLY input path of this file ================ */
  function applySnapshot(s) {
    online = true;
    var seat = (s.world && s.world.seat) || {};
    V.rot = ((seat.rotation_deg == null ? 90 : seat.rotation_deg) % 360 + 360) % 360;
    V.hgt = seat.height_mm != null ? seat.height_mm / 10 : 38;
    V.sl = seat.slider_mm != null ? (seat.slider_mm - 360) / 10 : 3;
    V.t = s.t || 0;
    V.phase = s.phase || "setup";
    V.done = !!s.done;
    V.running = !!s.running;
    var ride = s.ride || {};
    V.speed = ride.speed || 0; V.g = ride.g || 0;
    V.jolt = ride.jolt || 0; V.rain = ride.rain || 0;
    V.kind = (ride.kind && typeof ride.kind === "string") ? ride.kind : "";
    var ag = s.agent || {};
    if (ag.mood) {
      V.mood.comfort = ag.mood.comfort != null ? ag.mood.comfort : V.mood.comfort;
      V.mood.energy = ag.mood.energy != null ? ag.mood.energy : V.mood.energy;
      V.mood.suspicion = ag.mood.suspicion != null ? ag.mood.suspicion : V.mood.suspicion;
    }
    if (ag.trust) {
      V.trust.live = ag.trust.live != null ? ag.trust.live : V.trust.live;
      V.trust.score = ag.trust.score != null ? ag.trust.score : V.trust.score;
    }
    if (ag.prefs && ag.prefs.rot != null) V.prefs = ag.prefs;
    if (ag.traits instanceof Array) V.traits = ag.traits.slice();
    V.bdi.intention = ag.intention || null;
    V.bdi.since = ag.intentionSince || 0;
    if (ag.speech) V.speech = ag.speech;   /* keep last spoken line on empty */
    V.thoughts = ag.thoughts || V.thoughts;
    V.memory = ag.memory || V.memory;
    V.forgot = ag.forgot || V.forgot;
    V.forgotCount = ag.forgotCount != null ? ag.forgotCount : V.forgotCount;
    V.module = ag.module || "";
    V.log = ag.log || V.log;
    V.chat = ag.chat || V.chat;
    V.samples = ag.samples || V.samples;
    V.trail = ag.trail || V.trail;
    V.priors = s.priors && s.priors.rides ? s.priors : V.priors;
    detectEvent();
    updateTransportNote();
  }

  /* display-only fit figures for the gauge panel (the mind has its own) */
  function seatFit() {
    var dr = Math.min(1, Math.abs(V.rot - V.prefs.rot) / 180);
    var dh = Math.min(1, Math.abs(V.hgt - V.prefs.hgt) / 8);
    return { rot: 1 - dr, hgt: 1 - dh, overall: 1 - (dr + dh) / 2 };
  }
  function viewSector() {
    var r = ((V.rot % 360) + 360) % 360;
    if (r < 30 || r >= 330) return "FORWARD";
    if (r >= 150 && r < 210) return "CABIN";
    if (r < 150) return "LEFT";
    return "RIGHT";
  }
  function setModule(m) {
    document.querySelectorAll(".mod").forEach(function (el) {
      el.classList.toggle("on", el.getAttribute("data-m") === m);
    });
  }
  function banner(text, cls) {
    var b = $("eventBanner");
    if (!b) return;
    b.textContent = text;
    b.className = "event-banner show" + (cls ? " " + cls : "");
    clearTimeout(banner._t);
    banner._t = setTimeout(function () { b.className = "event-banner"; }, 2200);
  }
  function shakeScene() {
    var w = $("sceneWrap");
    if (!w) return;
    w.classList.remove("jolt-shake"); void w.offsetWidth; w.classList.add("jolt-shake");
  }
  /* newest event line in the mind log -> banner + jolt shake */
  function detectEvent() {
    for (var i = 0; i < V.log.length; i++) {
      var e = V.log[i];
      if (e.kind === "evt") {
        var key = e.t + "|" + e.text;
        if (key !== lastEvtKey) {
          if (lastEvtKey) {                 /* not the initial catch-up */
            banner(e.text, V.jolt > 0.3 ? "jolt" : "");
            if (V.jolt > 0.3) shakeScene();
          }
          lastEvtKey = key;
        }
        return;
      }
    }
  }

  /* ===== speech panel (display only; lines come from the mind) ========== */
  function paintSpeech() {
    var sp = $("speech"), tx = $("speechTxt");
    if (!sp || !tx) return;
    if (tx.textContent === V.speech) return;
    tx.textContent = V.speech || "…";
    sp.classList.remove("pulse"); void sp.offsetWidth; sp.classList.add("pulse");
  }

  /* ================= 3D cabin renderer (canvas) ================= */
  var CVF_BASE = 690, CVW = 1600, CVH = 900, CVF = CVF_BASE, CVN = 16;
  var GLIGHT = { x: 0.35, y: 0.78, z: 0.52 };
  var SEATX = -20;
  var CAM_P = { x: 92, y: 45, z: 28 }, CAM_T = { x: -20, y: 44, z: 28 };
  var CamBase = lookAt({ x: CAM_P.x, y: CAM_P.y, z: CAM_P.z }, { x: CAM_T.x, y: CAM_T.y, z: CAM_T.z });
  var CamB = CamBase;
  var DLS = [];
  var GX = null;
  function sizeCanvas() {
    var cv = $("sceneCv"), st = $("sceneWrap");
    if (!cv || !cv.getContext) return;
    var w = st ? st.clientWidth : 0;
    if (!w) w = 420;
    var h = Math.max(120, Math.round(w * 9 / 16));
    var dpr = window.devicePixelRatio || 1;
    var bw = Math.max(64, Math.floor(w * dpr)), bh = Math.max(36, Math.floor(h * dpr));
    if (cv.width !== bw) cv.width = bw;
    if (cv.height !== bh) cv.height = bh;
    CVW = cv.width; CVH = cv.height;
    CVF = CVF_BASE * (CVW / 1600);
  }
  (function () {
    var cv = document.getElementById("sceneCv");
    if (cv && cv.getContext) GX = cv.getContext("2d");
  })();

  function v3(x, y, z) { return { x: x, y: y, z: z }; }
  function sub3(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function n3(a) { var l = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; }
  function d3(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function cr3(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
  function lookAt(pos, tgt) {
    var f = n3(sub3(tgt, pos)), r = n3(cr3(f, { x: 0, y: 1, z: 0 })), u = cr3(r, f);
    return { p: pos, f: f, r: r, u: u };
  }
  function camAt(t, swayK) {
    /* ride inertia from the SNAPSHOT's dynamics; sway uses the local anim
       clock so motion stays smooth between polls */
    var l = ((V.rot % 360) + 360) % 360;
    var side = Math.sin((l - 20) * Math.PI / 180);
    var sK = swayK || 0;
    var crv = Math.max(0, V.g - 0.22) * 8.5 * (side >= 0 ? 1 : -1) * sK;
    var dv = (V.speed < 55 && V.jolt < 0.02 && V.phase === "ride") ? 1.4 * sK : 0;
    var base = lookAt(
      { x: CAM_P.x + Math.sin(t * 1.1) * 0.5, y: CAM_P.y + Math.sin(t * 1.6) * 0.4, z: CAM_P.z + Math.sin(t * 0.9) * 0.3 },
      { x: CAM_T.x, y: CAM_T.y, z: CAM_T.z });
    if (!sK) return base;
    var swT = { x: base.r.x * crv, y: Math.max(0, crv) * 0.22, z: base.r.z * crv + dv };
    return {
      p: { x: base.p.x + swT.x, y: base.p.y + swT.y, z: base.p.z + swT.z },
      f: base.f, r: base.r, u: base.u
    };
  }
  function proj(p) {
    var d = sub3(p, CamB.p), D = d3(d, CamB.f);
    if (D < CVN) return null;
    return { x: CVW / 2 + d3(d, CamB.r) * CVF / D, y: CVH / 2 - d3(d, CamB.u) * CVF / D, z: D };
  }
  function faceN(a, b, c) { return cr3(sub3(b, a), sub3(c, a)); }
  function rotY(p, deg, axX, axZ) {
    var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    var x = p.x - axX, z = p.z - axZ;
    return { x: axX + x * c + z * s, y: p.y, z: axZ - x * s + z * c };
  }
  function col(hex) {
    var h = hex.replace("#", "");
    return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)];
  }
  function rgb(c, f) {
    var r = Math.round(c[0] * f), g = Math.round(c[1] * f), b = Math.round(c[2] * f);
    return "rgb(" + r + "," + g + "," + b + ")";
  }
  function shade(hex, n, k) {
    var f = 0.42 + 0.58 * Math.max(0, d3(n3(n), n3(GLIGHT))) + (k || 0);
    if (f > 1.06) f = 1.06; if (f < 0.28) f = 0.28;
    return rgb(col(hex), f);
  }

  function pushP(pts, color, o) {
    if (!GX) return;
    o = o || {};
    var sp = [], z = 0;
    for (var i = 0; i < pts.length; i++) {
      var q = proj(pts[i]);
      if (!q) return;
      sp.push(q); z += q.z;
    }
    z /= pts.length;
    var c = color, a = o.alpha != null ? o.alpha : 1, st = o.stroke || null, lw = o.lw || 1;
    DLS.push({ z: z, d: function () {
      GX.beginPath(); GX.moveTo(sp[0].x, sp[0].y);
      for (var i = 1; i < sp.length; i++) GX.lineTo(sp[i].x, sp[i].y);
      GX.closePath();
      GX.globalAlpha = a; GX.fillStyle = c; GX.fill();
      if (st) { GX.strokeStyle = st; GX.lineWidth = lw; GX.stroke(); }
      GX.globalAlpha = 1;
    } });
  }
  function pushCap(a, b, rw, color, o) {
    if (!GX) return;
    var A = proj(a), B = proj(b);
    if (!A || !B) return;
    var cz = (A.z + B.z) / 2, r = rw * CVF / cz;
    o = o || {};
    var sh = o.shadow || null, al = o.alpha != null ? o.alpha : 1;
    DLS.push({ z: cz, d: function () {
      GX.lineCap = "round";
      if (sh) { GX.strokeStyle = sh; GX.lineWidth = r * 2 + 4.5;
        GX.beginPath(); GX.moveTo(A.x, A.y); GX.lineTo(B.x, B.y); GX.stroke(); }
      GX.globalAlpha = al; GX.strokeStyle = color; GX.lineWidth = r * 2;
      GX.beginPath(); GX.moveTo(A.x, A.y); GX.lineTo(B.x, B.y); GX.stroke();
      GX.globalAlpha = 1;
    } });
  }
  function pushSph(p, r, color, o) {
    if (!GX) return;
    var q = proj(p);
    if (!q) return;
    var rr = r * CVF / q.z;
    o = o || {};
    var st = o.stroke || null, lw = o.lw || 1, al = o.alpha != null ? o.alpha : 1;
    DLS.push({ z: q.z, d: function () {
      GX.globalAlpha = al; GX.fillStyle = color;
      GX.beginPath(); GX.arc(q.x, q.y, rr, 0, 6.2832); GX.fill();
      if (st) { GX.strokeStyle = st; GX.lineWidth = lw; GX.stroke(); }
      GX.globalAlpha = 1;
    } });
  }
  function box(cx, yTop, yBot, hx, zF, zB, topC, sideC, yaw) {
    var yawDeg = yaw ? yaw : 0;
    function L(x, y, z) { return rotY(v3(x, y, z), yawDeg, 0, -6); }
    var F = [
      [L(-hx, yTop, zB), L(hx, yTop, zB), L(hx, yBot, zB), L(-hx, yBot, zB)],
      [L(-hx, yTop, zF), L(hx, yTop, zF), L(hx, yBot, zF), L(-hx, yBot, zF)],
      [L(hx, yTop, zF), L(hx, yTop, zB), L(hx, yBot, zB), L(hx, yBot, zF)],
      [L(-hx, yTop, zF), L(-hx, yTop, zB), L(-hx, yBot, zB), L(-hx, yBot, zF)],
      [L(-hx, yTop, zB), L(hx, yTop, zB), L(hx, yTop, zF), L(-hx, yTop, zF)]
    ];
    pushP(F[0], shade(sideC, faceN(F[0][0], F[0][1], F[0][2])), null);
    pushP(F[1], shade(sideC, faceN(F[1][0], F[1][1], F[1][2])), null);
    pushP(F[2], shade(sideC, faceN(F[2][0], F[2][1], F[2][2])), null);
    pushP(F[3], shade(sideC, faceN(F[3][0], F[3][1], F[3][2])), null);
    pushP(F[4], shade(topC, faceN(F[4][0], F[4][1], F[4][2]), 0.06), null);
  }

  function addFloor() {
    pushP([v3(-60, 0, -60), v3(60, 0, -60), v3(60, 0, 110), v3(-60, 0, 110)], "rgb(9,10,13)", null);
    pushP([v3(-60, 0.4, 60), v3(60, 0.4, 60), v3(60, 0.4, 110), v3(-60, 0.4, 110)], "rgba(0,0,0,.40)", { alpha: 0.5 });
    pushP([v3(-44, 0.3, 18), v3(-6, 0.3, 18), v3(-6, 0.3, 64), v3(-44, 0.3, 64)], "rgba(14,16,22,.95)", null);
    pushP([v3(-44, 0.5, 18), v3(-6, 0.5, 18), v3(-6, 0.5, 23), v3(-44, 0.5, 23)], "rgba(201,162,39,.13)", null);
    pushP([v3(-44, 0.5, 58), v3(-6, 0.5, 58), v3(-6, 0.5, 64), v3(-44, 0.5, 64)], "rgba(201,162,39,.13)", null);
    pushP([v3(-30, 0.22, -45), v3(-6, 0.22, -45), v3(-6, 0.22, 30), v3(-30, 0.22, 30)], "rgba(30,34,44,.5)", null);
    pushSph(v3(SEATX, 0.8, 0), 30, "rgba(0,0,0,.5)", { alpha: 0.55 });
    pushP([v3(-46, 0.35, 2), v3(20, 0.35, 2), v3(20, 0.35, 24), v3(-46, 0.35, 24)], "rgba(230,200,90,.03)", { alpha: 0.6 });
  }

  function seatSlide() { return V.sl; }
  function addSeat() {
    var H = V.hgt, cb = H - 11, yaw = ((V.rot % 360) + 360) % 360;
    var sl = V.sl, SX = SEATX;
    pushP([v3(SX - 10, 0.6, -30), v3(SX - 6, 0.6, -30), v3(SX - 6, 0.6, 30), v3(SX - 10, 0.6, 30)], "rgba(201,162,39,.5)", null);
    pushP([v3(SX + 6, 0.6, -30), v3(SX + 10, 0.6, -30), v3(SX + 10, 0.6, 30), v3(SX + 6, 0.6, 30)], "rgba(201,162,39,.5)", null);
    pushP([v3(SX - 9, 0.9, -28), v3(SX + 9, 0.9, -28), v3(SX + 9, 0.9, -12), v3(SX - 9, 0.9, -12)], "rgba(10,12,16,.92)", null);
    pushP([v3(SX - 9, 0.9, 12), v3(SX + 9, 0.9, 12), v3(SX + 9, 0.9, 28), v3(SX - 9, 0.9, 28)], "rgba(10,12,16,.92)", null);
    box(SX, 3.2, 0.6, 12, sl + 15, sl - 15, "#181e2c", "#12161f", 0);
    var topY = cb;
    var linkA = [v3(SX - 6, 3.4, sl + 8), v3(SX + 6, 3.4, sl + 8), v3(SX + 5, topY - 0.6, sl + 10), v3(SX - 5, topY - 0.6, sl + 10)];
    var linkB = [v3(SX - 6, 3.4, sl - 8), v3(SX + 6, 3.4, sl - 8), v3(SX + 5, topY - 1, sl - 10), v3(SX - 5, topY - 1, sl - 10)];
    pushP(linkA, shade("#202838", faceN(linkA[0], linkA[1], linkA[2])), null);
    pushP(linkB, shade("#151b28", faceN(linkB[0], linkB[1], linkB[2])), null);
    pushCap(v3(SX, 3.6, sl), v3(SX, topY - 1.6, sl), 3.2, "#28324a", { shadow: "rgba(0,0,0,.55)" });
    pushCap(v3(SX, 3.6, sl - 7), v3(SX, topY - 2, sl - 5), 1.4, "#3a455f", null);
    pushCap(v3(SX, 3.6, sl + 7), v3(SX, topY - 2, sl + 5), 1.4, "#3a455f", null);
    box(SX, topY, topY - 1.4, 15, sl + 12, sl - 12, "#1a2130", "#141a26", 0);
    function L(x, y, z) { return rotY(v3(x, y, z), yaw, SX, sl); }
    var disc = [];
    for (var a = 0; a < 16; a++) {
      var an = a / 16 * 6.2832;
      disc.push(L(SX + Math.sin(an) * 15, topY - 0.5, sl + Math.cos(an) * 15));
    }
    pushP(disc, "#0f1320", null);
    var nAng = yaw * Math.PI / 180;
    pushP([v3(SX, topY - 0.2, sl),
      L(SX + Math.sin(nAng) * 12, topY - 0.2, sl + Math.cos(nAng) * 12),
      L(SX + Math.sin(nAng + 0.18) * 12, topY - 0.2, sl + Math.cos(nAng + 0.18) * 12)], "rgba(230,200,90,.9)", null);
    pushSph(v3(SX, topY - 0.5, sl), 3.4, "#1a2130", { stroke: "rgba(230,200,90,.7)", lw: 1 });
    var cTop = [L(SX - 17, H, sl - 12), L(SX + 17, H, sl - 12), L(SX + 17, H, sl + 10), L(SX - 17, H, sl + 10)];
    var cBot = [L(SX - 17, cb, sl - 12), L(SX + 17, cb, sl - 12), L(SX + 17, cb, sl + 10), L(SX - 17, cb, sl + 10)];
    pushP(cTop, shade("#35405a", faceN(cTop[0], cTop[1], cTop[2]), 0.07), null);
    pushP(cTop, "rgba(60,70,100,.20)", null);
    pushP(cBot, shade("#1a2130", faceN(cBot[1], cBot[0], cBot[2])), null);
    var cF = [L(SX - 17, cb, sl + 10), L(SX + 17, cb, sl + 10), L(SX + 17, H, sl + 10), L(SX - 17, H, sl + 10)];
    var cR = [L(SX + 17, cb, sl - 12), L(SX + 17, cb, sl + 10), L(SX + 17, H, sl + 10), L(SX + 17, H, sl - 12)];
    var cL = [L(SX - 17, cb, sl - 12), L(SX - 17, cb, sl + 10), L(SX - 17, H, sl + 10), L(SX - 17, H, sl - 12)];
    var cRig = [L(SX + 17, cb, sl - 12), L(SX + 17, cb, sl + 10), L(SX + 17, H, sl + 10), L(SX + 17, H, sl - 12)];
    pushP(cF, shade("#2a3248", faceN(cF[0], cF[1], cF[2])), null);
    pushP(cR, shade("#161b28", faceN(cR[0], cR[1], cR[2])), null);
    pushP(cL, shade("#1c2334", faceN(cL[0], cL[1], cL[2])), null);
    pushP(cRig, shade("#232b40", faceN(cRig[0], cRig[1], cRig[2])), null);
    var bolL = [L(SX - 17, H, sl - 13), L(SX - 14, H + 1.6, sl - 13), L(SX - 14, H + 1.6, sl + 11), L(SX - 17, H, sl + 11)];
    var bolR = [L(SX + 17, H, sl - 13), L(SX + 14, H + 1.6, sl - 13), L(SX + 14, H + 1.6, sl + 11), L(SX + 17, H, sl + 11)];
    pushP(bolL, shade("#3a4662", faceN(bolL[0], bolL[1], bolL[2])), null);
    pushP(bolR, shade("#3a4662", faceN(bolR[0], bolR[1], bolR[2])), null);
    pushCap(L(SX - 15, H + 0.4, sl + 9.5), L(SX + 15, H + 0.4, sl + 9.5), 0.8, "rgba(230,200,90,.55)", null);
    pushCap(L(SX - 15, H + 0.4, sl - 11.5), L(SX + 15, H + 0.4, sl - 11.5), 0.8, "rgba(230,200,90,.4)", null);
    var bkZ = Math.sin(22 * Math.PI / 180) * 50, bkY = Math.cos(22 * Math.PI / 180) * 50;
    var bF0 = [L(SX - 15, H, sl - 12), L(SX + 15, H, sl - 12), L(SX + 15, H + bkY, sl - 12 - bkZ), L(SX - 15, H + bkY, sl - 12 - bkZ)];
    var bB0 = [L(SX - 15, H, sl - 21), L(SX + 15, H, sl - 21), L(SX + 15, H + bkY, sl - 21 - bkZ), L(SX - 15, H + bkY, sl - 21 - bkZ)];
    var bT = [L(SX - 15, H + bkY, sl - 12 - bkZ), L(SX + 15, H + bkY, sl - 12 - bkZ), L(SX + 15, H + bkY, sl - 21 - bkZ), L(SX - 15, H + bkY, sl - 21 - bkZ)];
    pushP(bF0, shade("#2b3348", faceN(bF0[0], bF0[1], bF0[2]), 0.05), null);
    pushP(bF0, "rgba(70,80,110,.14)", null);
    pushP(bB0, shade("#131927", faceN(bB0[0], bB0[1], bB0[2])), null);
    pushP(bT, shade("#35405a", faceN(bT[0], bT[1], bT[2])), null);
    var bLS = [L(SX - 15, H, sl - 12), L(SX - 15, H, sl - 21), L(SX - 15, H + bkY, sl - 12 - bkZ), L(SX - 15, H + bkY, sl - 21 - bkZ)];
    var bRS = [L(SX + 15, H, sl - 12), L(SX + 15, H, sl - 21), L(SX + 15, H + bkY, sl - 12 - bkZ), L(SX + 15, H + bkY, sl - 21 - bkZ)];
    pushP(bLS, shade("#1a2030", faceN(bLS[0], bLS[1], bLS[2])), null);
    pushP(bRS, shade("#202738", faceN(bRS[0], bRS[1], bRS[2])), null);
    pushCap(L(SX - 14, H + bkY - 6, sl - 12 - bkZ), L(SX + 14, H + bkY - 6, sl - 12 - bkZ), 0.8, "rgba(230,200,90,.4)", null);
    var hrF = [L(SX - 9, H + bkY, sl - 33), L(SX + 9, H + bkY, sl - 33), L(SX + 9, H + bkY + 13, sl - 26), L(SX - 9, H + bkY + 13, sl - 26)];
    var hrT = [L(SX - 9, H + bkY + 13, sl - 26), L(SX + 9, H + bkY + 13, sl - 26), L(SX + 9, H + bkY + 16, sl - 28), L(SX - 9, H + bkY + 16, sl - 28)];
    pushP(hrF, shade("#2b3348", faceN(hrF[0], hrF[1], hrF[2])), null);
    pushP(hrT, shade("#35405a", faceN(hrT[0], hrT[1], hrT[2])), null);
    var hrL = [L(SX - 9, H + bkY, sl - 33), L(SX - 9, H + bkY, sl - 30), L(SX - 9, H + bkY + 16, sl - 30), L(SX - 9, H + bkY + 16, sl - 33)];
    pushP(hrL, shade("#1a2030", faceN(hrL[0], hrL[1], hrL[2])), null);
  }

  function drawFigure() {
    var H = V.hgt;
    var hipY = H + 2;
    var yawDeg = ((V.rot % 360) + 360) % 360;
    var sl = seatSlide(), SX = SEATX;
    function L(x, y, z) {
      var q = rotY(v3(x, y, z), yawDeg, SX, sl);
      return { x: q.x, y: q.y, z: q.z };
    }
    function fwd() { return rotY(v3(0, 0, 1), yawDeg, SX, sl); }
    var FV = fwd();
    var hipT = L(0, hipY, sl), sL = L(SX - 18, 47, sl + 1), sR = L(SX + 18, 47, sl + 1);
    /* torso */
    var bk = L(0, hipY, sl - 2.2);
    var hipF = L(0, hipY - 3, sl);
    pushCap(bk, hipF, 13.5, "rgba(20,22,30,.85)", null);
    var torsoA = L(0, hipY - 2, sl);
    var torsoB = L(SX, 47, sl - 1);
    pushCap(torsoA, torsoB, 12.5, "#3b4356", null);
    var sLw = L(SX - 18, 48, sl), sRw = L(SX + 18, 48, sl);
    pushCap(sLw, sRw, 9, "#414a60", null);
    /* belt buckled strap — anchors to the door pillar zone when facing forward */
    var nrm = ((V.rot % 360) + 360) % 360;
    if (nrm < 14 || nrm > 346) {
      var beltA = v3(SX - 12, 58, sl + 4);
      var beltB = v3(SX + 2, hipY - 5, sl - 4);
      pushCap(beltA, beltB, 2.3, "#C9A227", null);
      pushCap(L(0, 40, sl + 6), beltB, 1.7, "rgba(230,200,90,.85)", null);
      pushSph(beltB, 2.1, "#E6C85A", null);
      pushSph(beltA, 2.6, "#1b2334", { stroke: "rgba(230,200,90,.6)", lw: 1 });
    }
    /* neck + head */
    var neckB = L(0, 52, sl), headC = L(0, 60, sl);
    pushCap(neckB, headC, 4.6, "#d9c7a2", null);
    /* arms */
    var elL = L(SX - 16, 30, sl + 7), haL = L(SX - 11, 20, sl + 15);
    var elR = L(SX + 16, 30, sl + 7), haR = L(SX + 11, 20, sl + 15);
    pushCap(sL, elL, 5.6, "#4a5470", { shadow: "rgba(0,0,0,.5)" });
    pushCap(elL, haL, 4.4, "#3f4860", { shadow: "rgba(0,0,0,.5)" });
    pushCap(sR, elR, 5.6, "#4a5470", { shadow: "rgba(0,0,0,.5)" });
    pushCap(elR, haR, 4.4, "#3f4860", { shadow: "rgba(0,0,0,.5)" });
    pushSph(haL, 3.3, "#d9c7a2", null);
    pushSph(haR, 3.3, "#d9c7a2", null);
    /* legs */
    var L1 = 52, th = (40 + (H - 38) * 1.8) * Math.PI / 180;
    var legLat = [[-7.5, -5], [7.5, 5]];
    for (var li = 0; li < 2; li++) {
      var lat = legLat[li][0], toe = legLat[li][1];
      var kneel = { x: lat, y: -Math.sin(th) * L1, z: Math.cos(th) * L1 };
      var footT = { x: lat + toe, y: 3 - hipY, z: 40 };
      var kv = L(kneel.x, hipY + kneel.y, sl + kneel.z);
      var fv3 = L(footT.x, hipY + footT.y, sl + footT.z);
      var ddx = fv3.x - kv.x, ddy = fv3.y - kv.y, ddz = fv3.z - kv.z;
      var dl = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) || 1;
      var L2 = 50, cl = Math.min(dl, L2) / dl;
      pushCap(L(0, hipY, sl), kv, 7.6, "#333c4f", { shadow: "rgba(0,0,0,.5)" });
      var footW = v3(kv.x + ddx * cl, kv.y + ddy * cl, kv.z + ddz * cl);
      pushCap(kv, footW, 5.6, "#2b3344", { shadow: "rgba(0,0,0,.5)" });
      pushSph(v3(footW.x + FV.x * 4, footW.y + 2.5, footW.z + FV.z * 4), 4.4, "#14192a", null);
    }
    pushSph(L(0, 3.5, sl + 40), 13, "rgba(0,0,0,.35)", { alpha: 0.5 });
    /* head + face/hair */
    var headW = L(0, 60, sl);
    pushSph(headW, 9, "#d9c7a2", null);
    var hn = n3(sub3(CamB.p, headW));
    var face = d3(hn, FV);
    var hairC = v3(headW.x - FV.x * 3.4, headW.y + 0.6, headW.z - FV.z * 3.4);
    pushSph(hairC, 9.6, "#1c1710", null);
    pushSph(v3(headW.x + FV.x * 2, headW.y + 7.3, headW.z + FV.z * 2), 9.2, "#221b12", null);
    if (face > 0.5) {
      var eyeOf = v3(headW.x + FV.x * 5.5, headW.y + 2.4, headW.z + FV.z * 5.5);
      var ri = n3(cr3(FV, v3(0, 1, 0)));
      pushSph(v3(eyeOf.x + ri.x * 3.2, eyeOf.y, eyeOf.z + ri.z * 3.2), 1.2, "#10130e", null);
      pushSph(v3(eyeOf.x - ri.x * 3.2, eyeOf.y, eyeOf.z - ri.z * 3.2), 1.2, "#10130e", null);
      pushSph(v3(headW.x + FV.x * 7, headW.y - 1.4, headW.z + FV.z * 7), 2.4, "rgba(210,180,150,.6)", null);
    }
    pushCap(L(0, 32, sl + 10), L(0, 26, sl + 16), 2.2, "#0c121f", null);
    pushSph(L(0, 26, sl + 18), 3.2, "rgba(9,13,24,.9)", { stroke: "rgba(120,130,160,.5)", lw: 1 });
  }

  function overlays() {
    var headDeg = ((V.rot % 360) + 360) % 360;
    GX.fillStyle = "rgba(11,10,7,.72)";
    GX.fillRect(14, 14, 148, 24);
    GX.strokeStyle = "rgba(201,162,39,.55)"; GX.lineWidth = 1;
    GX.strokeRect(14, 14, 148, 24);
    GX.fillStyle = "#E6C85A";
    GX.font = "10px Consolas, monospace";
    GX.textAlign = "left";
    GX.fillText("SEAT FWD · " + (Math.round(headDeg) < 100 ? "0" : "") + (Math.round(headDeg) < 10 ? "0" : "") + Math.round(headDeg) + "°", 24, 30);
    GX.strokeStyle = "rgba(230,200,90,.5)";
    GX.beginPath(); GX.moveTo(150, 30); GX.lineTo(150 - Math.sin(headDeg * Math.PI / 180) * 6, 30 - Math.cos(headDeg * Math.PI / 180) * 6);
    GX.stroke();
    var vr = Math.max(CVW, CVH) * 0.6;
    var vg = GX.createRadialGradient(CVW / 2, CVH / 2, 90, CVW / 2, CVH / 2, vr);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,.5)");
    GX.fillStyle = vg;
    GX.fillRect(0, 0, CVW, CVH);
  }

  function addDockBackdrop() {
    var cx = CVW / 2, cy = CVH * 0.5;
    var g = GX.createRadialGradient(cx, cy, 50, cx, cy, Math.max(CVW, CVH) * 0.72);
    g.addColorStop(0, "#1a1d28");
    g.addColorStop(0.62, "#101219");
    g.addColorStop(1, "#07080c");
    GX.fillStyle = g;
    GX.fillRect(0, 0, CVW, CVH);
    GX.strokeStyle = "rgba(201,162,39,.16)"; GX.lineWidth = 1;
    GX.beginPath(); GX.arc(cx, cy, Math.min(CVW, CVH) * 0.34, 0, 6.2832); GX.stroke();
  }

  function renderSeatScene() {
    var sfH = $("sfHgt"), sfR = $("sfRot"), sfS = $("sfSl");
    if (sfH) sfH.textContent = V.hgt + " cm";
    if (sfR) sfR.textContent = Math.round((((V.rot % 360) + 360) % 360)) + "°";
    if (sfS) sfS.textContent = (V.sl >= 0 ? "+" : "") + V.sl + " cm";
    if ($("dockHgt")) $("dockHgt").textContent = V.hgt + " cm";
    if ($("dockRot")) $("dockRot").textContent = Math.round((((V.rot % 360) + 360) % 360)) + "°";
    if ($("dockSl")) $("dockSl").textContent = (V.sl >= 0 ? "+" : "") + V.sl + " cm";
    window.__SEAT_LIVE__ = { rot: V.rot, sl: V.sl, hgt: V.hgt };
    if (!GX) return;
    CamBase = camAt(anim);
    CamB = camAt(anim, 1);
    DLS.length = 0;
    GX.clearRect(0, 0, CVW, CVH);
    addDockBackdrop();
    var shX = 0, shY = 0;
    if (V.jolt > 0.2) { shX = V.jolt * 6 * Math.sin(anim * 91 + 1.3); shY = V.jolt * 5 * Math.sin(anim * 77 + 4.1); }
    CamB = CamBase;
    addFloor();
    addSeat();
    drawFigure();
    DLS.sort(function (a, b) { return b.z - a.z; });
    GX.save();
    GX.translate(shX, shY);
    for (var i = 0; i < DLS.length; i++) DLS[i].d();
    GX.restore();
    overlays();
    if (window.__CABIN_PROBE__ && window.__CABIN_PROBE__.hook) {
      try { window.__CABIN_PROBE__.hook({ proj: proj, CamBase: CamBase, CVW: CVW, CVH: CVH, CVF: CVF, S: S_VIEW(), PHILL: PHILL_VIEW() }); } catch (e) { /* headless */ }
    }
  }
  /* compat shapes for external probes (same field names as the pre-port file) */
  function S_VIEW() {
    return { rot: V.rot, hgt: V.hgt, sl: V.sl, t: V.t, phase: V.phase, done: V.done,
             speed: V.speed, gNow: V.g, joltNow: V.jolt, rain: V.rain,
             mood: V.mood, thoughts: V.thoughts, speech: V.speech,
             bdi: V.bdi, running: V.running };
  }
  function PHILL_VIEW() {
    return { targetRot: V.prefs.rot, targetHgt: V.prefs.hgt,
             tolRot: V.prefs.tolRot, tolHgt: V.prefs.tolHgt };
  }

  /* ================= HUD rendering ================= */
  function renderClock() {
    if ($("clockVal")) $("clockVal").textContent = fmtTime(V.t);
    var chip = $("phaseChip");
    if (chip) {
      var label = V.done ? "Done"
        : (!V.running ? "Paused"
          : (V.phase === "setup" ? "Setup" : V.phase === "ride" ? "Ride" : "Paused"));
      chip.textContent = label;
      chip.className = "phase " + (V.done ? "done" : V.running ? V.phase : "paused");
    }
    if ($("tlMarker")) $("tlMarker").style.left = (Math.min(1, V.t / RIDE_END) * 100) + "%";
  }
  function renderSceneFx() {
    if ($("hudSpeed")) $("hudSpeed").textContent = Math.round(V.speed) + " km/h";
    if ($("sfG")) $("sfG").textContent = V.g.toFixed(1) + " g";
    document.querySelectorAll(".streak").forEach(function (el) {
      el.classList.toggle("on", V.phase === "ride" && !V.done && V.speed > 8);
    });
  }
  function renderDial() {
    var r = ((V.rot % 360) + 360) % 360;
    if ($("rotRead")) $("rotRead").textContent = r + "°";
    if ($("dialDegText")) $("dialDegText").textContent = r + "°";
    if ($("dialNeedle")) $("dialNeedle").setAttribute("transform", "rotate(" + r + " 80 80)");
    if ($("dialSeat")) $("dialSeat").setAttribute("transform", "rotate(" + r + " 80 80)");
    if ($("dialCone")) $("dialCone").setAttribute("d", conePath(80, 80, 44, r));
    if ($("viewSector")) $("viewSector").textContent = viewSector();
  }
  function conePath(cx, cy, rad, deg) {
    var a0 = (deg - 60) * Math.PI / 180, a1 = (deg + 60) * Math.PI / 180;
    return "M" + cx + "," + cy +
      " L" + (cx + Math.sin(a0) * rad) + "," + (cy - Math.cos(a0) * rad) +
      " A" + rad + "," + rad + " 0 0 1 " + (cx + Math.sin(a1) * rad) + "," + (cy - Math.cos(a1) * rad) + " Z";
  }
  function renderRail() {
    if (!$("hgtThumb")) return;
    var H0 = 388, H1 = 300; // px at hgt 38..46
    var y = H0 - (V.hgt - 38) * ((H0 - H1) / 8);
    $("hgtThumb").style.top = (y - 9) + "px";
    if ($("hgtTarget")) $("hgtTarget").style.top = (H0 - (V.prefs.hgt - 38) * ((H0 - H1) / 8)) + "px";
    $("hgtRead").textContent = V.hgt;
    if ($("hgtAtt")) $("hgtAtt").textContent = "att " + rate(HGT, V.hgt).toFixed(2);
  }
  function renderSlide() {
    if (!$("slThumb")) return;
    var x = 50 + (V.sl / 8) * 42; // % across the track, ±8 cm
    $("slThumb").style.left = "calc(" + x + "% - 9px)";
    $("slRead").textContent = (V.sl >= 0 ? "+" : "") + V.sl;
  }
  function renderGauges() {
    if (!$("gRotV")) return;
    var aR = Math.round(rate(ROT, V.rot) * 100), aH = Math.round(rate(HGT, V.hgt) * 100);
    var f = seatFit();
    $("gRotV").textContent = aR;
    $("gRot").style.width = aR + "%";
    $("gHgtV").textContent = aH;
    $("gHgt").style.width = aH + "%";
    var okRot = Math.abs(V.rot - V.prefs.rot) <= V.prefs.tolRot;
    var okHgt = Math.abs(V.hgt - V.prefs.hgt) <= V.prefs.tolHgt;
    if ($("fitRotV")) {
      $("fitRotV").textContent = "fit " + f.rot.toFixed(2);
      $("fitRotV").className = "mono " + (okRot ? "ok" : "bad");
    }
    if ($("fitHgtV")) {
      $("fitHgtV").textContent = "fit " + f.hgt.toFixed(2);
      $("fitHgtV").className = "mono " + (okHgt ? "ok" : "bad");
    }
    if ($("fitRotTxt")) $("fitRotTxt").textContent = okRot ? "within Phill's comfort zone ✓" : "rotated away from Phill's zone";
    if ($("fitHgtTxt")) $("fitHgtTxt").textContent = okHgt ? "where Phill likes to sit ✓"
      : (V.hgt < V.prefs.hgt ? "he would raise it · prefers " + V.prefs.hgt : "he would lower it · prefers " + V.prefs.hgt);
  }
  function renderMood() {
    if (!$("mComfort")) return;
    $("mComfort").textContent = V.mood.comfort.toFixed(2);
    $("mEnergy").textContent = V.mood.energy.toFixed(2);
    $("mSusp").textContent = V.mood.suspicion.toFixed(2);
    $("bComfort").style.width = (V.mood.comfort * 100) + "%";
    $("bEnergy").style.width = (V.mood.energy * 100) + "%";
    $("bSusp").style.width = (V.mood.suspicion * 100) + "%";
  }
  function renderMemory() {
    var rows = $("memRows");
    if (!rows) return;
    rows.innerHTML = "";
    V.memory.forEach(function (m) {
      var row = document.createElement("div"); row.className = "mrow";
      var l = document.createElement("span"); l.className = "lbl"; l.textContent = m.label;
      var tr = document.createElement("span"); tr.className = "track";
      var f = document.createElement("span"); f.className = "fill"; f.style.width = (m.act * 100) + "%";
      tr.appendChild(f);
      var a = document.createElement("span"); a.className = "age";
      a.textContent = fmtTime(m.age || 0) + " old";
      row.appendChild(l); row.appendChild(tr); row.appendChild(a);
      rows.appendChild(row);
    });
    if ($("forgotLine")) $("forgotLine").innerHTML = "forgot · " +
      (V.forgot.length ? V.forgot.slice(-3).map(function (f) { return f.label; }).join(" · ")
        : (V.forgotCount ? "…and " + V.forgotCount + " more" : "nothing yet"));
  }
  function renderThoughts() {
    var el = $("thoughts");
    if (!el) return;
    var pre = "";
    if (V.bdi.intention) {
      pre = '<div class="thought"><span class="tt">intent</span><span>' +
        (INTENT_LABELS[V.bdi.intention] || V.bdi.intention) + " · " +
        Math.max(0, Math.round(V.t - V.bdi.since)) + "s</span></div>";
    }
    el.innerHTML = pre + V.thoughts.map(function (th) {
      return '<div class="thought"><span class="tt">' + th.time + "</span><span>" + th.text + "</span></div>";
    }).join("");
  }
  function renderLog() {
    var el = $("log");
    if (!el) return;
    el.innerHTML = V.log.slice(0, 40).map(function (e) {
      return '<div class="ln ' + (e.kind === "say" ? "say" : "") + '"><span class="t mono">' + e.t +
        "</span><span>" + e.text + "</span></div>";
    }).join("");
  }
  function renderAll() {
    renderClock(); renderSceneFx(); renderSeatScene(); renderDial();
    renderRail(); renderSlide(); renderGauges(); renderMood(); renderMemory();
    renderThoughts(); renderLog(); paintSpeech(); setModule(V.module);
    syncPlay();
  }

  /* ===== transport to the Python engine (POST helpers) ================== */
  function post(path, payload) {
    return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}) }).catch(function () { online = false; updateTransportNote(); });
  }
  function updateTransportNote() {
    var n = $("transportNote");
    if (!n) return;
    if (!online) { n.textContent = "offline — start the mind: python -m cabin_sim.main"; return; }
    var score = V.trust.score;
    if (V.done) n.textContent = score != null
      ? "ride complete · trust " + Math.round(score * 100) + "/100" : "ride complete";
    else if (!V.running) n.textContent = "paused · press play to resume the ride";
    else if (V.phase === "setup") n.textContent = "setup · ⏭ skips to the ride · you can adjust the seat";
    else n.textContent = "ride in progress · you can still adjust the seat";
  }

  /* ================= seat interaction (optimistic, server clamps) ======== */
  function setRot(r) {
    r = Math.round((((r % 360) + 360) % 360));
    if (r === V.rot) return;
    V.rot = r;
    renderAll();
    post("/api/seat", { axis: "rot", value: r });
  }
  function setHgt(h) {
    h = Math.max(38, Math.min(46, Math.round(h)));
    if (h === V.hgt) return;
    V.hgt = h;
    renderAll();
    post("/api/seat", { axis: "hgt", value: h });   /* mm on the wire */
  }
  function setSl(s) {
    s = Math.max(-8, Math.min(8, Math.round(s)));
    if (s === V.sl) return;
    V.sl = s;
    renderAll();
    post("/api/seat", { axis: "sl", value: 360 + s * 10 });
  }

  // dial pointer
  var dial = $("dial"), dragging = false;
  function angleFromEvent(e) {
    var r = dial.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var dx = e.clientX - cx, dy = e.clientY - cy;
    var a = Math.atan2(dx, -dy) * 180 / Math.PI;
    return ((a % 360) + 360) % 360;
  }
  if (dial) {
    dial.addEventListener("pointerdown", function (e) { dragging = true; dial.setPointerCapture && dial.setPointerCapture(e.pointerId); setRot(angleFromEvent(e)); });
    dial.addEventListener("pointermove", function (e) { if (dragging) setRot(angleFromEvent(e)); });
    dial.addEventListener("pointerup", function () { dragging = false; });
  }

  // height rail
  var track = $("hgtTrack");
  function hgtFromEvent(e) {
    var r = track.getBoundingClientRect();
    var y = e.clientY - r.top;
    var H0 = 388, H1 = 300;
    return 38 + (H0 - y) / ((H0 - H1) / 8);
  }
  var draggingH = false;
  if (track) {
    track.addEventListener("pointerdown", function (e) { draggingH = true; track.setPointerCapture && track.setPointerCapture(e.pointerId); setHgt(hgtFromEvent(e)); });
    track.addEventListener("pointermove", function (e) { if (draggingH) setHgt(hgtFromEvent(e)); });
    track.addEventListener("pointerup", function () { draggingH = false; });
  }

  // slide track
  var slTrack = $("slTrack");
  function slFromEvent(e) {
    var r = slTrack.getBoundingClientRect();
    var x = (e.clientX - r.left) / r.width;
    return Math.round(8 * (2 * x - 1));
  }
  var draggingSl = false;
  if (slTrack) {
    slTrack.addEventListener("pointerdown", function (e) { draggingSl = true; slTrack.setPointerCapture && slTrack.setPointerCapture(e.pointerId); setSl(slFromEvent(e)); });
    slTrack.addEventListener("pointermove", function (e) { if (draggingSl) setSl(slFromEvent(e)); });
    slTrack.addEventListener("pointerup", function () { draggingSl = false; });
  }

  // keyboard: arrows + space
  window.addEventListener("keydown", function (e) {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === "ArrowLeft") setRot(V.rot - 5);
    else if (e.key === "ArrowRight") setRot(V.rot + 5);
    else if (e.key === "ArrowUp") setHgt(V.hgt + 1);
    else if (e.key === "ArrowDown") setHgt(V.hgt - 1);
    else if (/^[aAdD]$/.test(e.key)) setSl(e.key.toLowerCase() === "a" ? V.sl - 1 : V.sl + 1);
    else if (e.key === " ") { e.preventDefault(); togglePlay(); }
  });

  /* ================= transport buttons ================= */
  function syncPlay() {
    var lbl = V.running ? "❚❚ Pause" : "▶ Play";
    if ($("btnPlay")) $("btnPlay").textContent = lbl;
    if ($("topPlay")) $("topPlay").textContent = lbl;
    if ($("btnPlay")) $("btnPlay").disabled = V.done;
    if ($("topPlay")) $("topPlay").disabled = V.done;
  }
  function togglePlay() {
    if (V.done) return;
    V.running = !V.running;                 /* optimistic, confirmed by poll */
    syncPlay();
    post("/api/control", { running: V.running });
  }
  function setSpeed(sp) {
    /* view-side refresh rate (the engine paces itself on the server) */
    pollMs = Math.max(120, Math.round(1600 / sp));
    document.querySelectorAll(".speed-group .btn").forEach(function (x) {
      x.classList.toggle("on", +x.getAttribute("data-s") === sp);
    });
  }
  function skipSetup() { post("/api/control", { advance: "ride" }); }
  function restart() { post("/api/control", { reset: true }).then(function () { location.reload(); }); }
  if ($("btnPlay")) $("btnPlay").addEventListener("click", togglePlay);
  if ($("btnRestart")) $("btnRestart").addEventListener("click", restart);
  if ($("btnSkip")) $("btnSkip").addEventListener("click", skipSetup);
  if ($("topPlay")) $("topPlay").addEventListener("click", togglePlay);
  if ($("topRestart")) $("topRestart").addEventListener("click", restart);
  if ($("topSkip")) $("topSkip").addEventListener("click", skipSetup);
  document.querySelectorAll(".speed-group .btn").forEach(function (b) {
    b.addEventListener("click", function () { setSpeed(+b.getAttribute("data-s")); });
  });
  if ($("btnReplay")) $("btnReplay").addEventListener("click", restart);

  /* ===== end-of-ride summary (server has the score; view draws it) ====== */
  function evidenceAnswers() {             /* display-only, from the snapshot */
    var t = V.trust.live != null ? V.trust.live : (V.trust.score || 0.5);
    var f = seatFit();
    var c = V.mood.comfort, s = V.mood.suspicion, e = V.mood.energy;
    function r01(x) { return Math.max(0, Math.min(1, x)); }
    function q(x) { return 1 + Math.round(r01(x) * 4); }
    return {
      q1: q(0.5 * t + 0.5 * c),
      q2: q(0.55 * (1 - s) + 0.45 * t),
      q3: q(0.4 * f.overall + 0.6 * c),
      q4: q(0.5 * e + 0.5 * (1 - s)),
      q5: q(t)
    };
  }
  var TRUST_ITEMS = [
    { id: "q1", txt: "I would trust this cabin for another ride." },
    { id: "q2", txt: "I felt safe while it drove." },
    { id: "q3", txt: "The seating and cabin suited me." },
    { id: "q4", txt: "I stayed aware — it earned that attention." },
    { id: "q5", txt: "Overall, it makes trustworthy decisions." }
  ];
  var tqAnswers = {};
  function renderTrustItems() {
    tqAnswers = evidenceAnswers();
    var el = $("tqItems");
    if (!el) return;
    el.innerHTML = TRUST_ITEMS.map(function (it) {
      return '<div style="margin:8px 0;"><span style="font-size:12.5px; color:#C7C2B4;">' + it.txt + "</span>" +
        '<input type="range" min="1" max="5" step="1" value="' + (tqAnswers[it.id] || 3) + '" id="tq_' + it.id +
        '" style="width:100%; accent-color:#C9A227; margin-top:4px;" aria-label="' + it.txt +
        '"> <span class="tqlabel" style="font-size:10px; color:#8A8578;">1–5</span></div>';
    }).join("");
    TRUST_ITEMS.forEach(function (it) {
      var el2 = document.getElementById("tq_" + it.id);
      if (el2) el2.addEventListener("input", function (e) {
        tqAnswers[it.id] = Math.max(1, Math.min(5, +e.target.value || 3));
      });
    });
  }
  function openTrustQ() {
    renderTrustItems();
    var q = $("trustQ");
    if (q) q.style.display = "flex";
  }
  function remark() {
    var sc = V.trust.score != null ? V.trust.score : (V.trust.live || 0);
    return sc >= 0.65 ? THOUGHTS.endGood[0] : sc >= 0.45 ? THOUGHTS.endMid[0] : THOUGHTS.endBad[0];
  }
  function finishView() {
    if (finishedShown) return;
    finishedShown = true;
    var score = V.trust.score != null ? V.trust.score : (V.trust.live || 0);
    var samples = V.samples, trail = V.trail;
    var avgC = samples.length ? samples.reduce(function (a, c) { return a + c.c; }, 0) / samples.length : 0;
    var avgS = samples.length ? samples.reduce(function (a, c) { return a + c.s; }, 0) / samples.length : 0;
    var grade = score >= 0.62 ? "Phill would take this ride again." :
      score >= 0.45 ? "Acceptable — some minutes were iffy." : "He got out a little wary.";
    if ($("tqScore")) $("tqScore").textContent = "trust " + Math.round(score * 100) + "/100 · ride trend " +
      Math.round((trail.length ? trail[trail.length - 1].v : score) * 100);
    if ($("tqNote")) $("tqNote").textContent = grade + " “" + remark() + "”";
    if ($("sumGrade")) $("sumGrade").textContent = "avg comfort " + avgC.toFixed(2) +
      " · avg suspicion " + avgS.toFixed(2) + " · trust " + score.toFixed(2) + " — " + grade;
    if ($("cvComfort")) drawSeries($("cvComfort"), "t", "c", 0, RIDE_END, 0, 1, "#C9A227", samples);
    if ($("cvSusp")) {
      drawSeries($("cvSusp"), "t", "s", 0, RIDE_END, 0, 1, "#C9A227", samples);
      drawSeries($("cvSusp"), "t", "v", 0, RIDE_END, 0, 1, "#6BD5C0", trail, false);
    }
    if ($("sumMem")) $("sumMem").innerHTML = V.memory.map(function (m) {
      return '<li><span class="cap">' + m.label + "</span> · activation " + m.act.toFixed(2) + "</li>";
    }).join("") || "<li>—</li>";
    if ($("sumForg")) $("sumForg").innerHTML = V.forgot.map(function (m) {
      return '<li><span class="rem">' + m.label + "</span> · forgot it " + m.age + " s in</li>";
    }).join("") || "<li>—</li>";
    if ($("summary")) $("summary").classList.add("show");
    openTrustQ();
    updateTransportNote();
  }
  function drawSeries(cv, kx, ky, x0, x1, y0, y1, st, data, clear) {
    var g = cv.getContext("2d");
    var W = cv.width, H = cv.height;
    var src = data || [];
    if (clear !== false) {
      g.clearRect(0, 0, W, H);
      g.strokeStyle = "rgba(201,162,39,.35)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, 2); g.lineTo(0, H - 2); g.lineTo(W - 2, H - 2); g.stroke();
    }
    if (!src.length) return;
    g.strokeStyle = st || "#C9A227"; g.lineWidth = 2;
    g.beginPath();
    src.forEach(function (s, i) {
      var px = (s[kx] - x0) / (x1 - x0) * (W - 4) + 2;
      var py = H - 2 - (s[ky] - y0) / (y1 - y0) * (H - 4);
      i ? g.lineTo(px, py) : g.moveTo(px, py);
    });
    g.stroke();
  }

  /* ===== live cognitive bridge (snapshot → body) ========================
     Same public surface as before: window.__COG_LIVE__ is one object updated
     in place, subscribers via window.__COG_SUBSCRIBE__(fn). Content now
     originates from the Python mind's snapshot. */
  var cogSubs = [];
  function cogSubscribe(fn) {
    if (typeof fn !== "function") return function () {};
    cogSubs.push(fn);
    return function () {
      var i = cogSubs.indexOf(fn);
      if (i >= 0) cogSubs.splice(i, 1);
    };
  }
  var cogLive = window.__COG_LIVE__;
  if (!cogLive || typeof cogLive !== "object") { cogLive = {}; window.__COG_LIVE__ = cogLive; }
  if (!cogLive.mood) cogLive.mood = {};
  if (!cogLive.ride) cogLive.ride = {};
  if (!cogLive.persona || typeof cogLive.persona !== "object") cogLive.persona = {};
  var cogPriors = { rides: 0, trust: null };
  cogLive.priors = cogPriors;
  function publishCog() {
    cogLive.mood.comfort = V.mood.comfort;
    cogLive.mood.energy = V.mood.energy;
    cogLive.mood.suspicion = V.mood.suspicion;
    cogLive.trust = V.trust.score != null ? V.trust.score : (V.trust.live || 0.5);
    cogLive.intention = V.bdi.intention || null;
    cogLive.module = V.module || null;
    cogLive.ride.speed = V.speed;
    cogLive.ride.g = V.g;
    cogLive.ride.jolt = V.jolt;
    cogLive.ride.rain = V.rain;
    cogLive.ride.kind = V.kind || "";
    cogLive.persona.traits = (V.traits instanceof Array) ? V.traits.slice() : [];
    cogLive.ride.rain = V.rain;
    cogLive.ride.phase = V.phase;
    cogLive.ride.t = V.t;
    cogLive.thoughts = V.thoughts.length ? V.thoughts[0].text : "";
    cogLive.speech = V.speech || "";
    cogLive.module = V.module || "";    /* active module: perceive|intend|think|memorize|forget|speak */
    var p = V.priors;
    cogPriors.rides = p ? (p.rides || 0) : 0;
    cogPriors.trust = (p && typeof p.trust === "number") ? p.trust : null;
    for (var i = 0; i < cogSubs.length; i++) {
      try { cogSubs[i](cogLive); } catch (e) { /* a bad subscriber must not break the view */ }
    }
  }
  window.__COG_LIVE__ = cogLive;
  window.__COG_SUBSCRIBE__ = cogSubscribe;

  /* ===== experimenter chat: PROXY to the Python mind ====================
     Keeps the legacy synchronous hook shape
     window.__EXPERIMENTER_CHAT__.send("…") -> { ok, reply, state }.
     A synchronous XHR preserves that contract; the reply itself is chosen by
     mind.chat_send() on the server, never in this file. */
  function xhrJSON(path, payload) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", path, false);         /* sync: legacy hook is sync */
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(JSON.stringify(payload || {}));
      if (!xhr.status || xhr.status >= 500) return null;
      try { return JSON.parse(xhr.responseText || "{}"); } catch (e) { return null; }
    } catch (e) { return null; }
  }
  window.__EXPERIMENTER_CHAT__ = {
    send: function (raw) {
      var res = xhrJSON("/api/chat", { text: String(raw == null ? "" : raw) });
      if (!res) return { ok: false, error: "offline — Python mind not reachable" };
      if (res.ok) poll();
      return res;
    },
    history: function () { return V.chat.slice(0); },   /* oldest first, from mind */
    state: function () {
      var top = null;
      V.memory.forEach(function (m) { if (!top || m.act > top.act) top = m; });
      return {
        t: V.t, phase: V.phase, done: V.done,
        mood: { comfort: V.mood.comfort, energy: V.mood.energy, suspicion: V.mood.suspicion },
        trust: V.trust.live != null ? V.trust.live : 0.5,
        trustScore: V.trust.score,
        belief: { fitGap: 1 - seatFit().overall, fitRot: 1 - seatFit().rot, fitHgt: 1 - seatFit().hgt, userHands: false },
        intention: V.bdi.intention, since: V.bdi.since,
        seat: { rot: V.rot, hgt: V.hgt, sl: V.sl },
        memory: { count: V.memory.length, top: top ? top.label : null, forgot: V.forgotCount },
        ride: { speed: V.speed, g: V.g, jolt: V.jolt }
      };
    },
    clear: function () {
      var res = xhrJSON("/api/chat", { clear: true });
      V.chat = [];
      return !!(res && res.ok);
    }
  };

  /* ================= polling: the only "simulation" here ================ */
  var pollMs = 700;
  var pollTimer = null;
  function poll() {
    clearTimeout(pollTimer);
    fetch("/api/snapshot", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (s) {
          applySnapshot(s);
          renderAll();
          publishCog();
          if (s.done) finishView();
        }
      })
      .catch(function () { online = false; updateTransportNote(); })
      .then(function () { pollTimer = setTimeout(poll, pollMs); });
  }

  /* ================= static svg build ================= */
  function buildDialTicks() {
    var g = $("dialTicks");
    if (!g) return;
    g.innerHTML = "";
    for (var a = 0; a < 360; a += 30) {
      var r0 = a * Math.PI / 180;
      var id = ((a % 360) + 360) % 360;
      var big = id % 90 === 0;
      var x1 = 80 + Math.sin(r0) * 60, y1 = 80 - Math.cos(r0) * 60;
      var x2 = 80 + Math.sin(r0) * (big ? 68 : 65), y2 = 80 - Math.cos(r0) * (big ? 68 : 65);
      g.innerHTML += '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) +
        '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) +
        '" stroke="' + (big ? "#6B5520" : "#2a2416") + '" stroke-width="' + (big ? 2 : 1) + '"/>';
      if (big) {
        var lx = 80 + Math.sin(r0) * 51, ly = 80 - Math.cos(r0) * 51;
        g.innerHTML += '<text x="' + lx.toFixed(1) + '" y="' + (ly + 3).toFixed(1) +
          '" font-family="Consolas,monospace" font-size="9" fill="' + (id === 0 ? "#C9A227" : "#5C5749") +
          '" text-anchor="middle">' + (id === 0 ? "0" : id === 270 ? "L" : id === 90 ? "R" : id === 180 ? "C" : id) + "</text>";
      }
    }
  }
  function buildRailTicks() {
    var g = $("railTicks");
    if (!g) return;
    var H0 = 388, H1 = 300;
    g.innerHTML = "";
    for (var h = 38; h <= 46; h++) {
      var y = H0 - (h - 38) * ((H0 - H1) / 8);
      g.innerHTML += '<i style="top:' + (y - 4) + 'px">' + h + "</i>";
    }
  }
  function buildTlEvents() {
    if (!$("tlEvents")) return;
    $("tlEvents").innerHTML = EVENTS.map(function (ev) {
      return '<div class="tl-event" style="left:' + (ev.t / RIDE_END * 100) + '%"></div>';
    }).join("");
  }

  /* ================= lavish feedback (unchanged, view-side) ============= */
  function setupLavish() {
    var has = typeof window.lavish !== "undefined";
    if (has && $("lavCard")) {
      $("lavCard").style.display = "block";
      $("lavSend").addEventListener("click", function () {
        var v = $("lavText").value.trim();
        if (!v) return;
        try {
          if (window.lavish.queuePrompt) window.lavish.queuePrompt("Review feedback: " + v);
          if (window.lavish.sendQueuedPrompts) window.lavish.sendQueuedPrompts();
        } catch (e) { /* ignore */ }
        $("lavText").value = "";
        $("lavText").setAttribute("placeholder", "queued ✓ keep going or send another");
      });
    }
  }

  /* ================= boot ================= */
  sizeCanvas();
  buildDialTicks(); buildRailTicks(); buildTlEvents();
  updateTransportNote();
  if ($("speechTxt")) $("speechTxt").textContent = "waiting for the cabin mind…";
  if ($("tqSubmit")) $("tqSubmit").addEventListener("click", function () {
    var q = $("trustQ");
    if (q) q.style.display = "none";
  });
  if ($("tqClose")) $("tqClose").addEventListener("click", function () {
    var q = $("trustQ");
    if (q) q.style.display = "none";
  });
  setupLavish();
  window.addEventListener("resize", function () { sizeCanvas(); buildTlEvents(); });
  setTimeout(function () { sizeCanvas(); buildTlEvents(); }, 60);

  renderAll();
  poll();                             /* first snapshot, then every pollMs */

  /* animation loop: draws V at 60 fps; the mind advances server-side */
  var lastWall = performance.now();
  function frame(now) {
    anim += Math.min(0.1, (now - lastWall) / 1000);
    lastWall = now;
    renderAll();
    publishCog();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
export {};
