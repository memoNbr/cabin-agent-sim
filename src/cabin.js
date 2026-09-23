/* ============================================================
   cabin-agent-sim — minimal cabin scene (clean rewrite)

   cubic interior (floor, windowed walls — A/B/C frames + tinted glass so
     the cabin is visible from outside when the roof is off — dashboard
     cube; NO ceiling panel: the roof cap is exterior-only, open to the
     sky; car-like roofline at 1.42: tapered cap + raked windscreen
     (Cayenne-like), not a bus box)
   simple SUV shell (yellow skirt + hood/deck + open glasshouse +
     exterior-only roof cap + 4 wheels)
   gradient sky dome + drifting cloud parallax
   road plane with animated dashed centre line
   OrbitControls, [C] interior/exterior toggle
   wheel-zoom walk-out / walk-in: 500 ms eased camera flight with a
     shell fade, so the move never clips or blocks on geometry
   adjustable seat on the avatar's mount point: height / rotation /
     lateral / longitudinal sliders in the sim bar
   simple avatar entry: dark-grey primitive figure walks to the driver
     door and sits into the seat mount (sim-bar "avatar" replays it)

   No rounded boxes, no seat rig, no portal UI, no cognitive hooks.
   ============================================================ */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

console.log("cabin init start");

/* ---- page elements (kiosk UI lives in index.html and stays untouched) --- */
var statusEl = document.getElementById("viewerStatus");
var hintEl = document.getElementById("viewerHint");
var roofBtn = document.getElementById("vRoof");
var resetBtn = document.getElementById("vReset");
var camBtn = document.getElementById("vCam");
var photoBtn = document.getElementById("vPhoto");
var photoEl = document.getElementById("scenePhoto");

/* ---- simulation control bar (bottom-center kiosk strip) ---------------- */
var simToggleEl = document.getElementById("simToggle");
var simClockEl = document.getElementById("simClock");
var simJumpEl = document.getElementById("simJump");
var simGoEl = document.getElementById("simGo");
var simSpeedEl = document.getElementById("simSpeed");
var simSeatEl = document.getElementById("simSeat");
var avatarBtn = document.getElementById("simAvatar");

/* ---- adjustable seat controls (on/off toggle + 4 sliders, sim bar) ----- */
var seatVisEl = document.getElementById("seatVis");
var seatSysEl = document.getElementById("seatSys");
var seatHgtEl = document.getElementById("seatHgt");
var seatRotEl = document.getElementById("seatRot");
var seatLatEl = document.getElementById("seatLat");
var seatLngEl = document.getElementById("seatLng");
var seatHgtV = document.getElementById("seatHgtV");
var seatRotV = document.getElementById("seatRotV");
var seatLatV = document.getElementById("seatLatV");
var seatLngV = document.getElementById("seatLngV");

/* ---- shared state: ui.js reads cabinApi.state, global handle documented
        in README as window.__CABIN3D__ ---------------------------------- */
var state = (window.__CABIN3D__ = {
  ready: false,
  error: null,
  webgl: false,
  revision: THREE.REVISION,
  mode: "interior",
  roof: true,
  photo: false,
  simRunning: true,
  simSpeed: 1,
  simTime: 0,
  camPos: null,
  target: null,
  avatar: "out"
});

/* Red full-screen failure surface: missing canvas, missing WebGL, or any
   init exception — never a silent black screen. */
function fatal(msg) {
  if (!state.error) state.error = "failed";
  if (statusEl) statusEl.textContent = msg.split("\n")[0];
  var el = document.getElementById("cabinFatal");
  if (!el) {
    el = document.createElement("div");
    el.id = "cabinFatal";
    el.setAttribute("role", "alert");
    el.style.cssText =
      "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;" +
      "pointer-events:none;" +   /* never swallow clicks — chat/music/HUD keep working */
      "justify-content:center;padding:28px;background:#1a0000;color:#ff6b6b;" +
      "border:2px solid #ff3b30;font:13px/1.65 ui-monospace,Consolas,monospace;" +
      "white-space:pre-wrap;text-align:left;box-sizing:border-box;";
    (document.body || document.documentElement).appendChild(el);
  }
  el.textContent = "CABIN 3D — FATAL\n\n" + msg;
}

/* Stable API shell: ui.js reads cabinApi.state at import time; avatar.js
   guards on { scene, seatRig, agentMount } (filled in by boot()). __avatar is
   pre-seeded with a null-pose stub so avatar.js's init() early-returns and
   main.js never throws — the avatar mounts to seatMount LATER. */
/* ---- pure time helpers (top-level: no DOM, no THREE) ------------------- */
function fmtTime(sec) {
  var s = Math.max(0, Math.floor(sec));
  var m = Math.floor(s / 60);
  var r = s % 60;
  return (m < 10 ? "0" : "") + m + ":" + (r < 10 ? "0" : "") + r;
}
function parseTime(str) {
  str = String(str === null || str === undefined ? "" : str).trim();
  if (!str) return null;
  var m = /^(\d{1,4}):([0-5]?\d)$/.exec(str);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  if (/^\d{1,5}$/.test(str)) return parseInt(str, 10);
  return null;
}
function mod68(v) {
  var m = v % 68;
  return m < 0 ? m + 68 : m;
}

export const cabinApi = {
  state: state,
  fatal: fatal,
  __avatar: {
    getAvatarPose: function () { return null; }
  }
};

/* ---- scene construction ------------------------------------------------ */
function boot() {
  try {
    /* Build the scene graph first, before touching WebGL: avatar.js/ui.js
       contracts (scene/camera/mounts) then hold even if rendering fails. */
    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 400);
    var HOME = {
      interior: {
        pos: new THREE.Vector3(0, 0.80, -0.95),
        target: new THREE.Vector3(0, 0.52, 1.0)
      },
      exterior: {
        /* three-quarter REAR view, pulled back so the whole vehicle, the road
           beneath it and the road running to the horizon all fit in frame
           (hood faces +z, so the tailgate is the -z end) */
        pos: new THREE.Vector3(-6.8, 3.0, -8.6),
        target: new THREE.Vector3(0, 0.72, 0)
      }
    };
    camera.position.copy(HOME.interior.pos);

    /* Seat mount point for the avatar — a bare Object3D, no rig; it also
       carries the adjustable seat meshes (see below), so slider changes land
       directly on cabinApi.seatMount position/rotation. It doubles as
       avatar.js's seatRig/agentMount guard fields (same node); rest pose is
       the driver seat (x -0.42, z 0.38 — set back so the avatar's knees
       clear the dash), y follows the height slider (updateSeat, default
       hgt 38 cm → y = 0.10). updateSeat() hard-clamps every slider so the
       seat can never leave the cabin. */
    var seatMount = new THREE.Object3D();
    seatMount.name = "seatMount";
    seatMount.position.set(-0.42, 0.1, 0.38);

    cabinApi.scene = scene;
    cabinApi.camera = camera;
    cabinApi.seatMount = seatMount;
    cabinApi.seatRig = seatMount;
    cabinApi.agentMount = seatMount;

    /* -- material helpers -------------------------------------------------- */
    function mat(color, rough) {
      return new THREE.MeshStandardMaterial({
        color: color,
        roughness: rough === undefined ? 0.9 : rough,
        metalness: 0
      });
    }
    function box(parent, name, w, h, d, color, x, y, z, rough) {
      var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, rough));
      m.name = name;
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    }

    /* -- cubic interior: floor 0.12, walls up to the car-like roof line
           (tops 1.42; the body top stops 1 cm lower at 1.41 so the wall
           tops never z-fight it when the cap is off). Each wall is built
           as a WINDOW FRAME (body colour 0x55555d) plus tinted glass
           (0x88aacc @ 0.3): side windows split by a B-pillar into front
           (z 0.05..0.40) and rear (z -0.40..-0.05) panes, y 0.55..1.12 —
           A-pillar at the windscreen end, B-pillar amidships, C-pillar at
           the rear end, so the greenhouse reads as a framed automobile;
           the windscreen rakes back ~28° Cayenne-like from the cowl top to
           tuck under the roof front edge (sloped A-posts rake with it),
           rear window full width x 0.52 across the top — so
           with the roof off the exterior still reads as a vehicle AND you
           can see straight into the cabin from outside. The frame pieces
           are solid meshes, so they stay solid from in here; there is NO
           ceiling panel of any kind (the roof cap only draws for an eye
           outside the shell — see insideShell), the cabin is open
           floor-to-roof to the sky. */
    var interior = new THREE.Group();
    interior.name = "interior";
    scene.add(interior);
    box(interior, "floor", 1.8, 0.12, 2.6, 0x303036, 0, 0.06, 0);
    var FRAME = 0x55555d;
    var wallParts = [];   /* every frame / glass piece — all shell-faded */
    function wPart(name, w, h, d, x, y, z) {
      var m = box(interior, name, w, h, d, FRAME, x, y, z);
      wallParts.push(m);
      return m;
    }
    function wGlass(name, w, h, d, x, y, z) {
      var m = box(interior, name, w, h, d, 0x88aacc, x, y, z, 0.3);
      m.material.transparent = true;
      m.material.opacity = 0.3;
      m.userData.baseOpacity = 0.3;   /* shellFade() multiplies this */
      wallParts.push(m);
      return m;
    }
    /* side walls: sill + header + A/B/C pillars around the openings
       z -0.40..0.40 (front pane 0.05..0.40, rear pane -0.40..-0.05),
       y 0.55..1.12 (0.57 tall, centre y 0.835); headers run z -1.30..1.05,
       ending where the raked windscreen begins */
    wPart("wallLsill", 0.06, 0.43, 2.6, -0.93, 0.335, 0);
    wPart("wallLhead", 0.06, 0.15, 2.35, -0.93, 1.345, -0.125);
    wPart("wallLpilA", 0.06, 0.57, 0.9, -0.93, 0.835, 0.85);
    wPart("wallLpilB", 0.06, 0.57, 0.10, -0.93, 0.835, 0);
    wPart("wallLpilC", 0.06, 0.57, 0.9, -0.93, 0.835, -0.85);
    wGlass("wallLglassF", 0.02, 0.57, 0.35, -0.93, 0.835, 0.225);
    wGlass("wallLglassR", 0.02, 0.57, 0.35, -0.93, 0.835, -0.225);
    wPart("wallRsill", 0.06, 0.43, 2.6, 0.93, 0.335, 0);
    wPart("wallRhead", 0.06, 0.15, 2.35, 0.93, 1.345, -0.125);
    wPart("wallRpilA", 0.06, 0.57, 0.9, 0.93, 0.835, 0.85);
    wPart("wallRpilB", 0.06, 0.57, 0.10, 0.93, 0.835, 0);
    wPart("wallRpilC", 0.06, 0.57, 0.9, 0.93, 0.835, -0.85);
    wGlass("wallRglassF", 0.02, 0.57, 0.35, 0.93, 0.835, 0.225);
    wGlass("wallRglassR", 0.02, 0.57, 0.35, 0.93, 0.835, -0.225);
    /* windscreen: raked ~28° (rotation.x -0.494) from the cowl top
       (y 0.90, z 1.33) to tuck under the roof front edge (y 1.42, z 1.05);
       narrowed to ±0.95 so the raked edges bury inside the side pillars
       instead of sitting coplanar on them. Rear window stays vertical. */
    var fg = wGlass("wallFglass", 1.90, 0.62, 0.02, 0, 1.16, 1.19);
    fg.rotation.x = -0.494;
    function wPost(name, x) {
      var m = box(interior, name, 0.08, 0.66, 0.08, FRAME, x, 1.16, 1.19);
      m.rotation.x = -0.494;   /* same rake: base buried in the cowl, top in the cap */
      wallParts.push(m);
      return m;
    }
    wPost("wallLpostA", -0.93);
    wPost("wallRpostA", 0.93);
    /* rear window: full width, y 0.90..1.42 (top 0.52) */
    wPart("wallBcowl", 1.92, 0.78, 0.06, 0, 0.51, -1.33);
    wGlass("wallBglass", 1.90, 0.52, 0.02, 0, 1.16, -1.33);
    box(interior, "dash", 1.7, 0.4, 0.45, 0x26262c, 0, 0.32, 1.0, 0.8);
    interior.add(seatMount);

    /* Adjustable seat: the four meshes hang off seatMount — the very node
       exposed as cabinApi.seatMount / seatRig / agentMount — so every sim-bar
       slider writes position/rotation straight onto cabinApi.seatMount and
       the seat follows in both views. Mesh locals are mount-relative (x/z at
       the driver reference, cushion top = floor + hgt cm); the pedestal is a
       unit-height box that updateSeat() stretches to keep touching the floor. */
    var seatParts = [];
    function seatBox(name, w, h, d, color, x, y, z, rot) {
      var m = box(seatMount, name, w, h, d, color, x, y, z, 0.85);
      if (rot) m.rotation.x = rot;
      seatParts.push(m);
      return m;
    }
    var pedestal = seatBox("seatPedestal", 0.18, 1, 0.18, 0x34343a, 0, 0.14, -0.05);
    seatBox("seatCushion", 0.46, 0.14, 0.4, 0x7a7a82, 0, 0.33, -0.05);
    seatBox("seatBack", 0.46, 0.52, 0.12, 0x6a6a72, 0, 0.65, -0.31, -0.14);
    seatBox("seatHead", 0.24, 0.14, 0.09, 0x7a7a82, 0, 0.96, -0.34, -0.14);
    /* seat control cluster on the right bolster (real seat-side furniture
       the avatar's hand can actually touch): height lever (front), swivel
       dial/knob (middle), slide paddle (rear). Grab points below are the
       mount-local spots the hand aims at (see CTLS). */
    seatBox("seatCtlH", 0.05, 0.12, 0.07, 0x232328, 0.26, 0.35, 0.02);
    seatBox("seatCtlR", 0.06, 0.05, 0.06, 0x232328, 0.26, 0.375, -0.10);
    seatBox("seatCtlS", 0.05, 0.08, 0.10, 0x232328, 0.26, 0.34, -0.20);
    var CTLS = {
      height: { grab: [0.26, 0.41, 0.02] },
      dial: { grab: [0.29, 0.375, -0.10] },
      slide: { grab: [0.29, 0.34, -0.20] }
    };
    pedestal.scale.y = 0.24;   /* 0.12..0.36 on the floor at the default */

    /* -- avatar: simple figure + entry sequence ----------------------------
       Purely visual — Phill (cognitive.js) stays the mind (avatar.js's
       init() early-returns on the pre-seeded cabinApi.__avatar stub, so
       this figure is the only body). Basic primitives in one turquoise
       material: box torso, sphere head, cylinder thighs/shins, box feet —
       1.66 m standing, which puts the seated head at 1.26 m (1.34 m at the
       46 cm seat max), always under the 1.41 m roofline. No rig: each leg
       has one hip and one knee pivot purely so the sit pose (hips at
       cushion height, knees bent) can be lerped. Phases: out at the driver
       door -> walk (2 s, linear) -> sit (0.9 s: the drop + fold eases
       ahead of the slide-in, so the head is already under the roof before
       the body crosses the shell) -> parented to seatMount at local
       (0, -0.50, -0.24), so every seat slider and the swivel carry it.
       Plays once on load; the sim-bar "avatar" button replays it. -------- */
    var avDoor = { x: -1.2, y: 0, z: -0.15 };   /* start: outside the driver
       door — the seat rides at x -0.42, so its door is the -x side */
    var avSeat = new THREE.Vector3(0, -0.5, -0.24);   /* seated pose, mount-local */
    var WALK_MS = 2000, SIT_MS = 900;
    var SEATED_THIGH = -1.78, SEATED_SHIN = 1.78;   /* ~102 deg at hip + knee */
    var avPhase = "out", avT0 = 0;
    var avA = new THREE.Vector3(avDoor.x, avDoor.y, avDoor.z);   /* walk start */
    var avB = new THREE.Vector3();   /* walk end: outside the driver door */
    var avC = new THREE.Vector3();   /* sit end: world pose on the seat */
    var avYaw0 = 0, avYaw1 = 0;
    var _avV = new THREE.Vector3();
    function avSmooth(t) {
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      return t * t * (3 - 2 * t);
    }
    function avPlan() {
      /* the walk stops just OUTSIDE the body skin (x <= -1.1) at the seat's
         own height of the side window — an upright 1.66 m figure can never
         stand up inside the 1.41 m cabin, so it only enters once folded */
      var s = seatMount.getWorldPosition(_avV);
      avB.set(
        Math.min(s.x - 0.73, -1.1),
        0,
        Math.max(-0.35, Math.min(0.3, s.z - 0.25))
      );
      avYaw0 = Math.atan2(avB.x - avA.x, avB.z - avA.z);
    }
    function avPlanSeat() {
      seatMount.updateWorldMatrix(true, false);
      avC.copy(avSeat).applyMatrix4(seatMount.matrixWorld);
      avYaw1 = seatMount.rotation.y;
    }

    var avMat = mat(0x40c8c0, 0.9);   /* turquoise figure */
    var avRoot = new THREE.Group();
    avRoot.name = "avatar";
    function avPart(geo, x, y, z, parent) {
      var m = new THREE.Mesh(geo, avMat);
      m.position.set(x, y, z);
      (parent || avRoot).add(m);
      return m;
    }
    var avTorso = avPart(new THREE.BoxGeometry(0.42, 0.5, 0.24), 0, 1.15, 0);   /* torso 0.90..1.40 */
    /* head group (pivot at the neck) + eyes + arms: the cognitive face.
       NOTE: avatar.js is dead code — its init() early-returns on the stub,
       so the expression rig lives HERE on the live figure. Every channel
       below reads window.__COG_LIVE__ (cognitive.js bridge) with numeric
       guards; backend down = calm baseline, never hardcoded moods. */
    var avHeadG = new THREE.Group();
    avHeadG.name = "avatarHead";
    avHeadG.position.set(0, 1.42, 0);
    avRoot.add(avHeadG);
    function avHeadPart(geo, x, y, z, material) {
      var m = new THREE.Mesh(geo, material || avMat);
      m.position.set(x, y, z);
      avHeadG.add(m);
      return m;
    }
    avHeadPart(new THREE.SphereGeometry(0.13, 16, 12), 0, 0.11, 0);   /* head, top 1.66 */
    var avEyeMat = mat(0x141416, 0.9);
    function avEye(x) {
      var m = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), avEyeMat);
      m.position.set(x, 0.13, 0.115);
      avHeadG.add(m);
      return m;
    }
    var avEyeL = avEye(-0.05), avEyeR = avEye(0.05);
    function avArm(side) {
      var sh = new THREE.Group();
      sh.position.set(side * 0.26, 1.32, 0);
      avRoot.add(sh);
      var a = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.42, 0.09), avMat);
      a.position.set(0, -0.21, 0);
      sh.add(a);
      var h = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), avMat);
      h.position.set(0, -0.44, 0);
      sh.add(h);
      return sh;
    }
    var avArmL = avArm(-1), avArmR = avArm(1);
    /* expression state: damped toward cognitive targets every frame */
    var _ex = { yaw: 0, pitch: 0, lean: 0, armL: 0, aim: 0,
      ctl: null, ctlT: -1e9, nodT: -1e9, lastSpeech: "",
      sacT: 2, sacHold: 0, sacYaw: 0, sacPitch: 0,
      lastIntent: null, intentT: -1e9 };
    var _exT = -1;
    var _exInit = false;
    var _lastMP = new THREE.Vector3();
    var _lastMY = 0;
    var _e1 = new THREE.Euler();
    var _e2 = new THREE.Euler();
    var _q1 = new THREE.Quaternion();
    var _qG = new THREE.Quaternion();
    var _qAim = new THREE.Quaternion();
    var _v1 = new THREE.Vector3();
    var _v2 = new THREE.Vector3();
    var _down = new THREE.Vector3(0, -1, 0);
    function exNum(v, d) { return (typeof v === "number" && isFinite(v)) ? v : d; }
    function exClamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
    function exClamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
    /* Phill's documented defaults (personas/phill.json traits) — used only
       until the live persona channel publishes; live traits always win.
       Weights below are calibration constants; every BEHAVIOR they scale is
       selected by live trait + mood + ride state, never hardcoded. */
    var PHILL_TRAITS = ["introvert", "suspicious", "confident", "uninterested in cars"];
    function traitGains(raw) {
      var list = (raw instanceof Array && raw.length) ? raw : PHILL_TRAITS;
      var has = function (n) { return list.indexOf(n) >= 0; };
      return {
        introvert: has("introvert") ? 0.8 : 0.2,
        suspicious: has("suspicious") ? 0.75 : 0.25,
        confident: has("confident") ? 0.7 : 0.3,
        cars: has("uninterested in cars") ? 0.15 : 0.5
      };
    }
    function stepExpression(nowMs) {
      var now = nowMs / 1000;
      var dt = _exT < 0 ? 0.016 : Math.min(Math.max(now - _exT, 0), 0.1) || 0.016;
      _exT = now;
      var C = (typeof window !== "undefined" ? window.__COG_LIVE__ : null) || null;
      var mood = (C && C.mood) || {};
      var ride = (C && C.ride) || {};
      var comfort = exNum(mood.comfort, 0.5);
      var energy = exNum(mood.energy, 0.6);
      var suspicion = exNum(mood.suspicion, 0.5);
      var trust = exNum(C && C.trust, 0.5);
      var jolt = Math.max(0, exNum(ride.jolt, 0));
      var g = Math.max(0, exNum(ride.g, 0));
      var speed = Math.max(0, exNum(ride.speed, 0));
      var intent = (C && C.intention) || null;
      var speech = (C && typeof C.speech === "string") ? C.speech : "";
      var cogModule = (C && typeof C.module === "string") ? C.module : null;
      var rideKind = (C && C.ride && typeof C.ride.kind === "string") ? C.ride.kind : "";
      var P = traitGains(C && C.persona && C.persona.traits);
      if (intent !== _ex.lastIntent) { _ex.lastIntent = intent; _ex.intentT = now; }
      var seated = avPhase === "seated";
      /* 1) facial expression from mood: suspicion widens the eyes, trust relaxes the lids */
      /* personality-modulated vigilance: suspicion blended with the
         suspicious trait, decaying as trust is earned (slow trust = more
         vigilant glancing) */
      var vigilance = exClamp01((suspicion * 0.55 + P.suspicious * 0.45) * (1 - 0.4 * trust));
      var alertK = vigilance > 0.5 ? exClamp01((vigilance - 0.5) / 0.5) : 0;
      var tension = exClamp01(suspicion * (0.4 + 0.6 * P.suspicious));
      var slumpK = energy < 0.4 ? exClamp01((0.4 - energy) / 0.4) : 0;
      var braceK, curveK;
      if (rideKind) {
        braceK = rideKind === "brake" ? 1 : 0;
        curveK = rideKind === "curve" ? 1 : 0;
      } else {
        braceK = exClamp01(Math.max(0, (g - 0.35) / 0.3));
        curveK = 0;
      }
      var joltK = exClamp01(Math.max(0, (jolt - 0.22) / 0.35));
      /* introvert gain: minimizes unnecessary motion, not threat scanning */
      var moveGain = (1 - 0.45 * P.introvert) * (1 - 0.4 * tension);
      var lidK = trust > 0.6 ? exClamp01((trust - 0.6) / 0.4) : 0;
      var eyeS = 1 + 0.65 * alertK;
      avEyeL.scale.set(eyeS, eyeS * (1 - 0.35 * lidK), 1);
      avEyeR.scale.set(eyeS, eyeS * (1 - 0.35 * lidK), 1);
      /* 2) head tracking toward ride events: scan on jolt, pitch down on braking g, far gaze at speed */
      var yawT = (Math.sin(now * 0.9) * 0.05
        + Math.sin(now * 3.1) * 0.5 * alertK
        + Math.sin(now * 9.0) * 0.25 * joltK) * moveGain;
      yawT *= (1 - 0.8 * braceK);   /* brace is steady, never curious */
      var pitchT = 0.06 * alertK * (1 - braceK) + 0.10 * braceK
        - 0.04 * exClamp01(speed / 30);
      /* relaxed lean-back when comfortable and trusted (seated only) */
      var calmK = (comfort > 0.7 && trust > 0.55) ? exClamp01((comfort - 0.7) / 0.3) : 0;
      var leanT = seated ? -0.05 * calmK : 0;
      if (slumpK > 0 && seated) {
        /* low energy slumps forward, winning over the relaxed lean-back */
        leanT += 0.10 * slumpK;
        pitchT += 0.08 * slumpK;
      }
      if (curveK > 0 && seated) {
        /* planted into the seat through the curve: ride publishes no
           lateral channel, so this is a centered plant, never a faked
           directional lean */
        leanT += 0.04 * curveK;
        yawT *= (1 - 0.5 * curveK);
      }
      /* 3) seat-control tracking: which rail moved this frame? height (y),
            swivel dial (yaw, wrap-safe) or slide track (x/z). Head + right
            hand go to the moving control; settle with no motion defaults to
            the dial. Grab points are seatMount-local (see CTLS); avatar
            space = mount space + (0, +0.5, +0.24), the fixed seated offset. */
      var mp = seatMount.position, my = seatMount.rotation.y;
      var ctl = null;
      if (_exInit) {
        var ady = Math.abs(mp.y - _lastMP.y);
        var dyaw = Math.abs(my - _lastMY);
        dyaw = Math.min(dyaw, Math.PI * 2 - dyaw);
        var adxz = Math.abs(mp.x - _lastMP.x) + Math.abs(mp.z - _lastMP.z);
        if (ady > 0.002) ctl = "height";
        else if (dyaw > 0.005) ctl = "dial";
        else if (adxz > 0.003) ctl = "slide";
      }
      _lastMP.copy(mp); _lastMY = my; _exInit = true;
      if (!seated) { _ex.ctl = null; }
      else if (ctl) { _ex.ctl = ctl; _ex.ctlT = now; }
      else if (intent === "settle" && (!_ex.ctl || (now - _ex.ctlT) > 4)) {
        _ex.ctl = "dial"; _ex.ctlT = now;
      }
      var ctlActive = seated && !!_ex.ctl && !!CTLS[_ex.ctl] && (now - _ex.ctlT) < 1.2;
      var armLT = 0;
      if (seated && intent === "settle") armLT = -0.1;
      else if (seated && intent === "attend") armLT = -0.15;
      if (braceK > 0) {
        /* instinctive brace, both arms guarding — protective, never curious */
        armLT = armLT * (1 - braceK) + (-0.35) * braceK;
        leanT += 0.06 * braceK;   /* slight forward tuck */
      }
      /* suspicious vigilance saccades: discrete darts to the windows, the
         dash or straight ahead (no mirror meshes exist, so these three real
         directions stand in). Rate from vigilance; paused while bracing or
         task-locked on a control. Target choice is the only random draw;
         rate, amplitude and gating are all state-driven. */
      _ex.sacT -= dt;
      if (_ex.sacT <= 0 && seated && braceK < 0.3 && !ctlActive) {
        _ex.sacT = 3.2 - 2.3 * vigilance + Math.random() * 0.8;
        var sr = Math.random();
        if (sr < 0.35) { _ex.sacYaw = -0.62; _ex.sacPitch = 0.02; }
        else if (sr < 0.6) { _ex.sacYaw = 0.65; _ex.sacPitch = 0.02; }
        else if (sr < 0.85) { _ex.sacYaw = 0; _ex.sacPitch = 0.42; }
        else { _ex.sacYaw = 0; _ex.sacPitch = -0.02; }
        _ex.sacHold = 0.45;
      }
      if (_ex.sacHold > 0) {
        _ex.sacHold -= dt;
        yawT = _ex.sacYaw;
        pitchT = _ex.sacPitch;
      }
      if (!ctlActive && seated && intent === "attend") {
        /* forward through the windshield, tracking road events (base terms
           already carry jolt scan + braking pitch; ride publishes no curve-
           direction channel, so curves read as alert scanning) */
        yawT = Math.sin(now * 0.9) * 0.05
          + Math.sin(now * 3.1) * 0.5 * alertK
          + Math.sin(now * 9.0) * 0.25 * joltK;
      } else if (!ctlActive && seated && intent === "calibrate"
          && (now - _ex.intentT) < (0.4 + 2.2 * (0.15 + 0.85 * P.cars))) {
        /* glance at the HUD/dash — briefly for the car-uninterested
           (Phill: ~1 s), longer for the curious; then back to forward */
        avRoot.updateWorldMatrix(true, false);
        _v1.set(0, 0.35, 1.0);
        avRoot.worldToLocal(_v1);
        var ddx = _v1.x, ddy = _v1.y - 1.42, ddz = _v1.z;
        yawT = exClamp(Math.atan2(ddx, ddz), -0.9, 0.9);
        pitchT = exClamp(Math.atan2(-ddy, Math.sqrt(ddx * ddx + ddz * ddz)), -0.3, 0.7)
          + Math.sin(now * 1.4) * 0.03 * moveGain;
      }
      /* 5) nod on fresh chat speech (+ module sync): utterance onset opens a
            ~1.5 s nod window, refreshed while the speak module runs; the head
            turns toward the experimenter (the viewing camera) with the nod */
      if (speech !== _ex.lastSpeech) {
        _ex.lastSpeech = speech;
        if (speech) _ex.nodT = now;
      }
      if (cogModule === "speak" && speech) _ex.nodT = now;
      var nodK = exClamp01(1 - (now - _ex.nodT) / 1.5);
      var nodPitch = Math.sin(now * 8.5) * 0.07 * nodK;
      var expW = (seated && nodK > 0.3) ? nodK * 0.6 : 0;
      if (expW > 0.01) {
        avHeadG.getWorldPosition(_v1);
        _v2.copy(camera.position).sub(_v1);
        var wyaw = Math.atan2(_v2.x, _v2.z);
        avRoot.getWorldQuaternion(_q1);
        _e1.setFromQuaternion(_q1, "YXZ");
        var dyw = wyaw - _e1.y;
        dyw = Math.atan2(Math.sin(dyw), Math.cos(dyw));
        yawT = yawT * (1 - expW) + exClamp(dyw, -0.9, 0.9) * expW;
      }
      /* control look wins over everything: face the grab point, lean in */
      if (ctlActive) {
        var G = CTLS[_ex.ctl].grab;
        var cdx = G[0], cdy = G[1] + 0.5 - 1.42, cdz = G[2] + 0.24;
        yawT = exClamp(Math.atan2(cdx, cdz), -0.9, 0.9);
        pitchT = exClamp(Math.atan2(-cdy, Math.sqrt(cdx * cdx + cdz * cdz)), -0.3, 0.7);
        leanT = 0.12;
      }
      pitchT += nodPitch;   /* nod composes over every gaze */
      /* ease everything (frame-rate independent lerp). Rates are
         personality-split: confident reaches are decisive (fast arm),
         tension stiffens the torso (slow lean). */
      var k = 1 - Math.exp(-8 * dt);
      var kArm = 1 - Math.exp(-(5 + 9 * P.confident) * dt);
      var kLean = 1 - Math.exp(-(8 - 4 * tension) * dt);
      _ex.yaw += (yawT - _ex.yaw) * k;
      _ex.pitch += (pitchT - _ex.pitch) * k;
      _ex.lean += (leanT - _ex.lean) * kLean;
      _ex.armL += (armLT - _ex.armL) * k;
      avHeadG.rotation.y = _ex.yaw;
      avHeadG.rotation.x = _ex.pitch;
      if (seated) avRoot.rotation.x = _ex.lean;
      avArmL.rotation.x = _ex.armL;
      /* right hand: rest pose -> control aim (single-joint shoulder aim at
         the grab point; avatar-space dir from the shoulder pivot) */
      _e2.set(-0.35 * braceK, 0, 0);
      _qG.setFromEuler(_e2);
      var aimT = ctlActive ? 1 : 0;
      _ex.aim += (aimT - _ex.aim) * k;
      if (_ex.aim > 0.01 && _ex.ctl && CTLS[_ex.ctl]) {
        var G2 = CTLS[_ex.ctl].grab;
        _v1.set(G2[0] - 0.26, (G2[1] + 0.5) - 1.32, (G2[2] + 0.24) - 0);
        if (_v1.lengthSq() > 1e-8) {
          _v1.normalize();
          _qAim.setFromUnitVectors(_down, _v1);
          _qG.slerp(_qAim, exClamp01(_ex.aim));
        }
      }
      avArmR.quaternion.slerp(_qG, kArm);
      /* 4) breathing synced to energy: ~13..35 breaths/min, shallower
         under tension, steadier through curves */
      var rate = 1.4 + 2.2 * exClamp01(energy);
      var amp = (0.006 + 0.008 * exClamp01(energy))
        * (1 - 0.55 * tension) * (1 - 0.2 * curveK);
      avTorso.scale.y = 1 + Math.sin(now * rate) * amp;
    }
    var avThighGeo = new THREE.CylinderGeometry(0.09, 0.078, 0.42, 12);
    var avShinGeo = new THREE.CylinderGeometry(0.075, 0.062, 0.42, 12);
    var avFootGeo = new THREE.BoxGeometry(0.14, 0.06, 0.2);
    function avLeg(side) {
      var hip = new THREE.Group();
      hip.position.set(side * 0.11, 0.9, 0);       /* hip pivot: 0.90 up */
      avRoot.add(hip);
      avPart(avThighGeo, 0, -0.21, 0, hip);
      var knee = new THREE.Group();
      knee.position.set(0, -0.42, 0);              /* knee pivot */
      hip.add(knee);
      avPart(avShinGeo, 0, -0.21, 0, knee);
      avPart(avFootGeo, 0, -0.44, 0.04, knee);     /* toes point +z (forward) */
      return { hip: hip, knee: knee };
    }
    var avLegL = avLeg(-1), avLegR = avLeg(1);
    function setLegFold(k) {
      var th = SEATED_THIGH * k, sh = SEATED_SHIN * k;
      avLegL.hip.rotation.x = th; avLegR.hip.rotation.x = th;
      avLegL.knee.rotation.x = sh; avLegR.knee.rotation.x = sh;
    }
    function avatarEnter() {
      avPlan();
      avPlanSeat();
      scene.add(avRoot);              /* pulls it back out of seatMount */
      avRoot.position.copy(avA);
      avRoot.rotation.set(0, avYaw0, 0);
      setLegFold(0);
      avPhase = "walk";
      avT0 = performance.now();
      state.avatar = "walk";
    }
    function stepAvatar(now) {
      if (avPhase === "walk") {
        var p = Math.min(1, (now - avT0) / WALK_MS);
        avRoot.position.lerpVectors(avA, avB, p);   /* linear, per spec */
        if (p >= 1) {
          avPlanSeat();        /* land on wherever the seat is now */
          avPhase = "sit";
          avT0 = now;
          state.avatar = "sit";
        }
      } else if (avPhase === "sit") {
        var q = Math.min(1, (now - avT0) / SIT_MS);
        var eD = avSmooth(q / 0.55);   /* drop + fold first */
        var eM = avSmooth((q - 0.4) / 0.6);   /* then slide aboard */
        avRoot.position.set(
          avB.x + (avC.x - avB.x) * eM,
          avB.y + (avC.y - avB.y) * eD,
          avB.z + (avC.z - avB.z) * eM
        );
        avRoot.rotation.y = avYaw0 + (avYaw1 - avYaw0) * eM;
        setLegFold(eD);
        if (q >= 1) {
          seatMount.add(avRoot);        /* parent: rides the seat sliders */
          avRoot.position.copy(avSeat);
          avRoot.rotation.set(0, 0, 0);
          setLegFold(1);
          avPhase = "seated";
          state.avatar = "seated";
          /* the agent is aboard: tell the mind so it greets (LLM, bank
             fallback) like a human settling in — fires on load and on every
             replay; failure is silent, the ride never breaks */
          try {
            fetch("/api/entered", { method: "POST",
              headers: { "Content-Type": "application/json" }, body: "{}" }
            ).catch(function () {});
          } catch (e) {}
        }
      }
      stepExpression(now);
    }
    /* a seat click may now land on the figure sitting on the seat — walking
       the parent chain keeps click-to-focus working through it */
    function inAvatar(o) {
      while (o) { if (o === avRoot) return true; o = o.parent; }
      return false;
    }
    avPlan();
    avRoot.position.copy(avA);
    avRoot.rotation.y = avYaw0;
    scene.add(avRoot);
    /* feed ui.js's per-frame mirror (README: __CABIN3D__.avatarPose) */
    cabinApi.__avatar.getAvatarPose = function () {
      avRoot.updateWorldMatrix(true, false);
      var w = avRoot.getWorldPosition(_avV);
      return {
        state: avPhase,
        world: { x: w.x, y: w.y, z: w.z },
        seated: avPhase === "seated"
      };
    };
    if (avatarBtn) avatarBtn.addEventListener("click", avatarEnter);

    /* -- simple SUV: yellow skirt + hood/deck + open glasshouse +
           exterior-only roof cap + 4 wheels. The solid bodywork stops at
           the beltline (0.88): yellow skirt full-length below, grey hood
           (front, z 1.30..2.15) and deck (rear, z -2.15..-1.30) above it —
           so the greenhouse (frames + raked windscreen + glass) stands open
           to the air and the windshield is never blocked by a solid block.
           The roof is a thin tapered cap seated on the wall tops
           (1.42..1.47), narrowed and shortened versus the body so the
           greenhouse reads automobile, not bus. The cap is an EXTERIOR
           part only: the render loop hides it while the eye is inside the
           shell (insideShell), so it never draws as a grey ceiling panel
           in there — the interior sees sky, the exterior sees a solid
           roof (roof off = cap hidden in both views). ------------------ */
    var suv = new THREE.Group();
    suv.name = "suv";
    scene.add(suv);
    /* yellow lower skirt (0.06..0.61) full length + grey hood/deck
       (0.61..0.88, inset 3 cm per side): stepped nose/tail, glasshouse
       open above the beltline. The skirt is 4 perimeter strips, not one
       solid box, so no yellow top face ever spans the cabin and cuts the
       interior view — the exterior sides read exactly the same. */
    var bodySkirtParts = [];
    function skirtPart(name, w, d, x, z) {
      var m = box(suv, name, w, 0.55, d, 0xe9a90b, x, 0.335, z, 0.75);
      bodySkirtParts.push(m);
      return m;
    }
    skirtPart("bodySkirtL", 0.10, 4.30, -0.93, 0);
    skirtPart("bodySkirtR", 0.10, 4.30, 0.93, 0);
    skirtPart("bodySkirtF", 1.76, 0.10, 0, 2.10);
    skirtPart("bodySkirtB", 1.76, 0.10, 0, -2.10);
    var hood = box(suv, "hood", 1.90, 0.27, 0.85, 0x4a4a52, 0, 0.745, 1.725, 0.75);
    var deck = box(suv, "deck", 1.90, 0.27, 0.85, 0x4a4a52, 0, 0.745, -1.725, 0.75);
    var bodyShell = bodySkirtParts.concat([hood, deck]);
    /* tapered cap (±0.90, z -1.65..1.35) seats exactly on the wall tops
       at y 1.42; hood/deck stop at 0.88, so every horizontal plane stays
       distinct (no z-fighting when the cap is hidden) */
    var roofMesh = box(suv, "bodyRoof", 1.80, 0.05, 3.0, 0x55555d, 0, 1.445, -0.15, 0.75);
    var wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 18);
    var wheelMat = mat(0x17171a, 0.95);
    /* wheels sit 8 cm proud of the body side so all four still read from a
       distance; wheel bottom is exactly y=0, sunk 1 cm into the road plane */
    var wheelSpots = [[-0.94, 1.4], [0.94, 1.4], [-0.94, -1.4], [0.94, -1.4]];
    for (var wi = 0; wi < wheelSpots.length; wi++) {
      var wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.name = "wheel" + wi;
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(wheelSpots[wi][0], 0.34, wheelSpots[wi][1]);
      suv.add(wheel);
    }

    /* Fake contact shadow: with no shadow maps, this dark patch is what
       visually plants the vehicle on the road instead of floating. It sits
       above road/lines (y 0.03) and spans slightly wider than the body. */
    var contact = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 4.9),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.42,
        depthWrite: false
      })
    );
    contact.name = "contactShadow";
    contact.rotation.x = -Math.PI / 2;
    contact.position.set(0, 0.03, 0);
    scene.add(contact);

    /* -- ground + road + scrolling dashes --------------------------------- */
    var ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), mat(0x505058, 1));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    /* The road runs 240 m — far past the 60 m dome horizon, so it always
       reads as stretching into the distance. It is offset sideways so the
       vehicle sits centred in a lane (between the dashed centre line and the
       right edge line) instead of balanced on top of the line. */
    var roadG = new THREE.Group();
    roadG.name = "roadway";
    roadG.position.x = -2.075;
    scene.add(roadG);
    var road = new THREE.Mesh(new THREE.PlaneGeometry(9, 240), mat(0x62626e, 1));
    road.rotation.x = -Math.PI / 2;
    road.position.y = 0.01;
    roadG.add(road);
    var stripeMat = new THREE.MeshBasicMaterial({
      color: 0xc9c9d0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });
    for (var si = -1; si <= 1; si += 2) {
      var stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 240), stripeMat);
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.set(si * 4.15, 0.02, 0);
      roadG.add(stripe);
    }
    /* Dashed centre line: one strip of dashes slides back one gap-width and
       resets — a seamless endless "driving" loop (dashes drift toward the
       interior camera = forward motion). */
    var DASH_GAP = 7;
    var DASH_SPEED = 7;
    var dashG = new THREE.Group();
    dashG.name = "roadDashes";
    roadG.add(dashG);
    var dashMat = new THREE.MeshBasicMaterial({
      color: 0xe8e8ee,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });
    for (var di = -11; di <= 11; di++) {
      var dash = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 2.6), dashMat);
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(0, 0.021, di * DASH_GAP);
      dashG.add(dash);
    }

    /* -- gradient sky dome (unlit = always bright) ------------------------ */
    var cv = document.createElement("canvas");
    cv.width = 8;
    cv.height = 256;
    var ctx2d = cv.getContext("2d");
    if (ctx2d) {
      var grad = ctx2d.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0.0, "#b0b0c0");   /* zenith */
      grad.addColorStop(0.45, "#c9cad4");
      grad.addColorStop(0.5, "#e0e0e8");   /* horizon */
      grad.addColorStop(0.54, "#6a6a72");
      grad.addColorStop(1.0, "#505058");   /* below horizon, matches ground */
      ctx2d.fillStyle = grad;
      ctx2d.fillRect(0, 0, 8, 256);
    }
    var skyTex = new THREE.CanvasTexture(cv);
    if (THREE.SRGBColorSpace) skyTex.colorSpace = THREE.SRGBColorSpace;
    var dome = new THREE.Mesh(
      new THREE.SphereGeometry(60, 32, 20),
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false })
    );
    dome.name = "skyDome";
    scene.add(dome);

    /* -- clouds: flat boxes at varied depth + speed = parallax ------------- */
    var clouds = [];
    for (var ci = 0; ci < 10; ci++) {
      var cl = new THREE.Mesh(
        new THREE.BoxGeometry(3 + (ci % 4) * 1.2, 0.55 + (ci % 3) * 0.25, 1.4),
        new THREE.MeshBasicMaterial({ color: 0xdcdce2 })
      );
      cl.name = "cloud" + ci;
      cl.position.set(
        -28 + ci * 6.2,
        7 + (ci % 5) * 1.5,
        ci % 3 === 0 ? 12 + (ci % 2) * 8 : -10 - ((ci * 7) % 34)
      );
      cl.userData.s = 0.25 + (ci % 4) * 0.18;
      cl.userData.x0 = -28 + ci * 6.2;
      scene.add(cl);
      clouds.push(cl);
    }

    /* -- basic lighting: interior readable from every angle (no shadow
           maps, so the rig lights the cabin straight through the shell) --- */
    scene.add(new THREE.AmbientLight(0xffffff, 1.0));
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8f8f98, 2.2));
    var key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(4, 8, 3);
    scene.add(key);
    var fill = new THREE.DirectionalLight(0xf2f4ff, 1.0);
    fill.position.set(-5, 4, -3);
    scene.add(fill);
    var rim = new THREE.DirectionalLight(0xffffff, 0.8);
    rim.position.set(0, 3, -7);
    scene.add(rim);

    /* ---- canvas + WebGL (fatal overlay on either failure) ---------------- */
    var HOST = document.getElementById("cabin3d");
    if (!HOST || !HOST.getContext) {
      state.error = "no-canvas";
      fatal("#cabin3d canvas missing\n\nExpected <canvas id=\"cabin3d\"> in the page before the app module runs.");
      return;
    }
    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: HOST,
        antialias: true,
        powerPreference: "high-performance"
      });
    } catch (e) {
      state.error = "no-webgl";
      fatal("WebGL unavailable\n\n" + ((e && e.message) || e) +
        "\n\nEnable hardware acceleration or update the graphics driver, then reload.");
      return;
    }
    console.log("WebGL ok");
    state.webgl = true;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35;

    var controls = new OrbitControls(camera, HOST);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 0.25;
    controls.maxDistance = 22;
    controls.maxPolarAngle = Math.PI * 0.52;
    controls.target.copy(HOME.interior.target);
    controls.update();
    cabinApi.controls = controls;
    cabinApi.renderer = renderer;

    /* ---- camera behaviour ------------------------------------------------ */
    var BOUND = {
      x: 0.8,
      yLo: 0.2,
      yHi: 1.28,
      zLo: -1.2,
      zHi: 1.15
    };
    function clampCam() {
      camera.position.x = Math.min(BOUND.x, Math.max(-BOUND.x, camera.position.x));
      camera.position.y = Math.min(BOUND.yHi, Math.max(BOUND.yLo, camera.position.y));
      camera.position.z = Math.min(BOUND.zHi, Math.max(BOUND.zLo, camera.position.z));
    }
    function setMode(m) {
      if (m !== "interior" && m !== "exterior") return;
      if (camAnim) endCamAnim();   /* C pressed mid-flight: land, solidify shell */
      state.mode = m;
      camera.position.copy(HOME[m].pos);
      controls.target.copy(HOME[m].target);
      controls.update();
      if (camBtn) camBtn.className = "btn" + (m === "exterior" ? " on" : "");
    }
    function setRoof(on) {
      /* the roof button toggles the exterior shell only — it never touches
         any interior ceiling (there is none). roofMesh.visible is owned per
         frame by the eye test in animate() (eye outside + roof on = solid
         cap; eye inside = cap hidden, open sky). The BODY skin follows the
         button directly: fully opaque with the roof on (solid vehicle),
         ghosted to 12% with the roof off — otherwise its opaque sides
         would sit in front of the window cutouts and still block the view
         into the cabin from outside. */
      state.roof = !!on;
      roofMesh.visible = state.roof;
      var b = state.roof ? 1 : 0.12;
      for (var bi = 0; bi < bodyShell.length; bi++) {
        var bp = bodyShell[bi];
        bp.userData.baseOpacity = b;
        var bm = bp.material;
        if (bm.opacity !== b) bm.opacity = b;
        var bt = b < 0.999;
        if (bm.transparent !== bt) { bm.transparent = bt; bm.needsUpdate = true; }
      }
      if (roofBtn) roofBtn.className = "btn" + (state.roof ? " on" : "");
    }
    /* the roof cap is exterior-only: hide it whenever the eye is inside
       the body shell (x ±0.98, y 0.06..1.41, z ±2.15 — the exact volume
       whose own faces are backface-culled), so in there nothing ever
       draws overhead and the sky dome shows through the open roof line.
       From outside the cap renders as the full solid exterior roof. */
    function insideShell(p) {
      return p.x > -0.98 && p.x < 0.98 &&
             p.y > 0.06 && p.y < 1.41 &&
             p.z > -2.15 && p.z < 2.15;
    }
    function resetView() {
      if (camAnim) endCamAnim();
      camera.position.copy(HOME[state.mode].pos);
      controls.target.copy(HOME[state.mode].target);
      if (state.mode === "interior") clampCam();
      controls.update();
    }

    /* ---- keyboard: [C] toggle, W/S/Q/E travel --------------------------- */
    var keyState = {};
    function isTyping() {
      var a = document.activeElement;
      return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
    }
    window.addEventListener("keydown", function (e) {
      var k = (e.key || "").toLowerCase();
      if (isTyping()) return;
      if (k === "c") { setMode(state.mode === "interior" ? "exterior" : "interior"); return; }
      if (k !== "w" && k !== "s" && k !== "q" && k !== "e") return;
      keyState[k] = true;
      if (hintEl) hintEl.classList.add("gone");
    });
    window.addEventListener("keyup", function (e) { keyState[(e.key || "").toLowerCase()] = false; });
    window.addEventListener("blur", function () {
      for (var k in keyState) keyState[k] = false;
      dragging = false;
    });

    var travel = new THREE.Vector3();
    var travelF = new THREE.Vector3();
    var travelR = new THREE.Vector3();
    var UP = new THREE.Vector3(0, 1, 0);
    function applyTravel(dt) {
      var sp = 0.6 * dt;
      travelF.subVectors(controls.target, camera.position);
      travelF.y = 0;
      if (travelF.lengthSq() < 1e-8) travelF.set(0, 0, -1);
      travelF.normalize();
      travelR.crossVectors(travelF, UP).normalize();
      travel.set(0, 0, 0);
      if (keyState.w) travel.add(travelF);
      if (keyState.s) travel.sub(travelF);
      if (keyState.e) travel.add(travelR);
      if (keyState.q) travel.sub(travelR);
      if (travel.lengthSq() === 0) return;
      travel.normalize().multiplyScalar(sp);
      camera.position.add(travel);
      controls.target.add(travel);
      if (state.mode === "interior") clampCam();
    }

    /* ---- pointer + kiosk buttons ---------------------------------------- */
    var dragging = false;
    HOST.addEventListener("pointerdown", function () {
      dragging = true;
      HOST.classList.add("grabbing");
      if (hintEl) hintEl.classList.add("gone");
    });
    window.addEventListener("pointerup", function () {
      dragging = false;
      HOST.classList.remove("grabbing");
    });
    if (roofBtn) roofBtn.addEventListener("click", function () { setRoof(!state.roof); });
    if (resetBtn) resetBtn.addEventListener("click", resetView);
    if (camBtn) camBtn.addEventListener("click", function () {
      setMode(state.mode === "interior" ? "exterior" : "interior");
    });
    if (photoBtn && photoEl) {
      var setPhoto = function (on) {
        state.photo = !!on;
        photoEl.classList.toggle("on", state.photo);
        photoBtn.className = "btn" + (state.photo ? " on" : "");
      };
      photoBtn.addEventListener("click", function () { setPhoto(!state.photo); });
      photoEl.addEventListener("click", function () { setPhoto(false); });
    }

    /* ---- simulation bar: start/stop, speed, clock, jump, seat focus ------ */
    /* seat focus framing — the target follows the live seatMount, so a
       height-/rail-adjusted seat is still centred in frame */
    var SEAT_VIEW = { pos: new THREE.Vector3(0.3, 0.8, 1.1) };
    function setSimRunning(on) {
      state.simRunning = !!on;
      if (simToggleEl) {
        simToggleEl.textContent = state.simRunning ? "stop" : "start";
        simToggleEl.className = "kbtn" + (state.simRunning ? " on" : "");
      }
    }
    function focusSeat() {
      setMode("interior");
      camera.position.copy(SEAT_VIEW.pos);
      controls.target.set(
        seatMount.position.x,
        seatMount.position.y + 0.5,
        seatMount.position.z - 0.05
      );
      clampCam();
      controls.update();
      if (hintEl) hintEl.classList.add("gone");
    }
    var lastClock = "";
    function paintClock(force) {
      if (!simClockEl) return;
      var s = fmtTime(state.simTime);
      if (force || s !== lastClock) { lastClock = s; simClockEl.textContent = s; }
    }
    if (simToggleEl) simToggleEl.addEventListener("click", function () { setSimRunning(!state.simRunning); });
    if (simSpeedEl) simSpeedEl.addEventListener("change", function () {
      var v = parseFloat(simSpeedEl.value);
      state.simSpeed = v > 0 ? v : 1;
    });
    if (simSeatEl) simSeatEl.addEventListener("click", focusSeat);

    /* ---- adjustable seat: on/off + height / rotation / lateral / longi-
       tudinal. Sliders write cabinApi.seatMount position (x = lateral rail,
       y = height, z = longitudinal rail) and rotation.y (swivel) live; the
       pedestal stretches so it always reaches the floor; readouts mirror. */
    var seatCtl = { hgt: 38, rot: 0, lat: 0, lng: 0 };
    var seatSysOn = true;
    state.seat = seatCtl;
    var seatLocalT = -1e9;   /* last local slider input (ms): defers the pull */
    function postSeat(axis, value) {   /* world.Seat is authoritative */
      try {
        fetch("/api/seat", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ axis: axis, value: value }) }
        ).catch(function () {});
      } catch (e) {}
    }
    /* the mind moves the seat too (self_adjust): pull the rig toward
       __COG_LIVE__.seat — published by cognitive.js from world.Seat — so
       the agent's own settling is visible; never while the user drags */
    function syncSeatFromCog(nowMs) {
      if (nowMs - seatLocalT < 900) return;
      var lastSync = syncSeatFromCog._t || 0;
      if (nowMs - lastSync < 100) return;
      syncSeatFromCog._t = nowMs;
      var C = (typeof window !== "undefined" ? window.__COG_LIVE__ : null) || null;
      var s = C && C.seat;
      if (!s) return;
      var h = +s.hgt, r = +s.rot, l = +s.sl;
      if (h === seatCtl.hgt && r === seatCtl.rot && l === seatCtl.lng) return;
      seatCtl.hgt = h; seatCtl.rot = r; seatCtl.lng = l;
      if (seatHgtEl) seatHgtEl.value = h;
      if (seatRotEl) seatRotEl.value = r;
      if (seatLngEl) seatLngEl.value = l;
      updateSeat();
    }
    function updateSeat() {
      /* hard clamps: the sliders can never push the seat out of the cabin
         (inner walls x ±0.90, front/rear walls z ±1.30) and the rest pose
         sits back (z 0.38) so the seated avatar's knees clear the dash
         face (z 0.775) at every slider extreme */
      var sx = -0.42 + seatCtl.lat / 100;
      var sz = 0.38 + seatCtl.lng / 100;
      sx = Math.min(0.67, Math.max(-0.67, sx));
      sz = Math.min(0.75, Math.max(-0.50, sz));
      seatMount.position.set(
        sx,
        seatCtl.hgt / 100 - 0.28,   /* cushion top = floor(0.12) + hgt cm */
        sz
      );
      seatMount.rotation.y = THREE.MathUtils.degToRad(seatCtl.rot);
      pedestal.scale.y = 0.14 + seatMount.position.y;
      pedestal.position.y = (0.38 - seatMount.position.y) / 2;
      if (seatHgtV) seatHgtV.textContent = String(seatCtl.hgt);
      if (seatRotV) seatRotV.textContent = seatCtl.rot + "\u00b0";
      if (seatLatV) seatLatV.textContent = String(seatCtl.lat);
      if (seatLngV) seatLngV.textContent = (seatCtl.lng > 0 ? "+" : "") + seatCtl.lng;
    }
    function readSeatSliders() {
      if (seatHgtEl) seatCtl.hgt = +seatHgtEl.value;
      if (seatRotEl) seatCtl.rot = +seatRotEl.value;
      if (seatLatEl) seatCtl.lat = +seatLatEl.value;
      if (seatLngEl) seatCtl.lng = +seatLngEl.value;
      seatLocalT = performance.now();
      updateSeat();
      /* mirror the drag to the server so the mind's fit belief and the
         cockpit panel converge on the same world.Seat (lat is view-only) */
      postSeat("hgt", seatCtl.hgt * 10); /* cm -> mm on the wire */
      postSeat("rot", seatCtl.rot);
      postSeat("sl", 360 + seatCtl.lng * 10);
    }
    [seatHgtEl, seatRotEl, seatLatEl, seatLngEl].forEach(function (el) {
      if (el) el.addEventListener("input", readSeatSliders);
    });
    function setSeatSystem(on) {
      seatSysOn = !!on;
      for (var i = 0; i < seatParts.length; i++) seatParts[i].visible = seatSysOn;
      if (seatSysEl) seatSysEl.classList.toggle("gone", !seatSysOn);
      if (seatVisEl) {
        seatVisEl.textContent = seatSysOn ? "seat on" : "seat off";
        seatVisEl.className = "kbtn" + (seatSysOn ? " on" : "");
      }
    }
    if (seatVisEl) seatVisEl.addEventListener("click", function () {
      setSeatSystem(!seatSysOn);
      if (seatSysOn) focusSeat();
    });
    updateSeat();
    var jumpGo = function () {
      var t = parseTime(simJumpEl && simJumpEl.value);
      if (t === null) return;
      state.simTime = t;
      paintClock(true);
      if (simJumpEl) simJumpEl.value = "";
    };
    if (simGoEl) simGoEl.addEventListener("click", jumpGo);
    if (simJumpEl) simJumpEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); jumpGo(); }
    });

    /* clicking the seat in 3D — tap (not orbit-drag) raycasts the scene; the
       shell blocks clicks from outside, the nearest seat part selects */
    var ray = new THREE.Raycaster();
    var downXY = null;
    HOST.addEventListener("pointerdown", function (e) { downXY = [e.clientX, e.clientY]; });
    HOST.addEventListener("pointerup", function (e) {
      if (!downXY) return;
      var moved = Math.abs(e.clientX - downXY[0]) + Math.abs(e.clientY - downXY[1]);
      downXY = null;
      if (moved > 6) return;
      var rect = HOST.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      ray.setFromCamera(
        new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1
        ),
        camera
      );
      var hits = ray.intersectObjects(scene.children, true);
      if (hits.length && seatSysOn &&
        (seatParts.indexOf(hits[0].object) !== -1 || inAvatar(hits[0].object))) focusSeat();
    });

    /* ---- zoom walk-out / walk-in: pulling the wheel past a threshold flies
           the camera to the other view — exterior three-quarter
           (-6.8, 3.0, -8.6) — over 500 ms with cubic easing. The shell the
           path crosses (wall frames + glass + body) fades out first and
           back in on arrival, each piece at its own base opacity (glass
           0.3; body 0.12 with the roof off, 1 with it on), so the flight
           never clips or blocks on geometry. --------------------------- */
    var EXIT_DIST = 2.0;    /* interior zoom-out: past the interior bounds */
    var ENTER_DIST = 3.0;   /* exterior zoom-in: outside the shell (max ~2.5) */
    var FADE_MS = 500;
    var SHELL = wallParts.concat([roofMesh].concat(bodyShell));
    var camAnim = null;
    var lastDist = camera.position.distanceTo(controls.target);
    function shellFade(k) {
      /* each shell piece keeps its own base opacity (glass 0.3, the body
         skin 0.12 with the roof off / 1 with it on, frames 1) and the
         flight factor k scales it — so endCamAnim's shellFade(1) restores
         every material to its correct resting state, not one flat 1 */
      for (var i = 0; i < SHELL.length; i++) {
        var m = SHELL[i], mt = m.material;
        var base = m.userData.baseOpacity === undefined ? 1 : m.userData.baseOpacity;
        var want = base * k;
        var wantT = want < 0.999;
        if (mt.opacity !== want) mt.opacity = want;
        if (mt.transparent !== wantT) { mt.transparent = wantT; mt.needsUpdate = true; }
      }
    }
    function beginTrans(toMode) {
      if (camAnim || toMode === state.mode) return;
      camAnim = {
        t0: performance.now(),
        dur: FADE_MS,
        to: toMode,
        fromPos: camera.position.clone(),
        fromTgt: controls.target.clone()
      };
      state.mode = toMode;
      if (camBtn) camBtn.className = "btn" + (toMode === "exterior" ? " on" : "");
      controls.enabled = false;
      if (hintEl) hintEl.classList.add("gone");
    }
    function stepCamAnim(now) {
      var p = Math.min(1, (now - camAnim.t0) / camAnim.dur);
      var e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      var H = HOME[camAnim.to];
      camera.position.lerpVectors(camAnim.fromPos, H.pos, e);
      controls.target.lerpVectors(camAnim.fromTgt, H.target, e);
      /* shell fully gone across the middle of the flight: every wall/roof
         plane either path crosses lands inside this faded window */
      var k = p < 0.16 ? 1 - p / 0.16 : p < 0.7 ? 0 : (p - 0.7) / 0.3;
      shellFade(k);
      if (p >= 1) endCamAnim();
    }
    function endCamAnim() {
      shellFade(1);
      camAnim = null;
      controls.enabled = true;
      lastDist = camera.position.distanceTo(controls.target);
    }

    /* ---- resize ---------------------------------------------------------- */
    function resize() {
      var w = (HOST && HOST.clientWidth) || 1;
      var h = (HOST && HOST.clientHeight) || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    if (window.ResizeObserver) {
      try { new ResizeObserver(resize).observe(HOST); } catch (e) { /* ignore */ }
    }
    window.addEventListener("resize", resize);
    resize();

    /* ---- ready ----------------------------------------------------------- */
    setRoof(true);
    state.ready = true;
    /* the entry sequence plays once on load; the sim-bar button replays it
       from the driver door at any time (the guard keeps it to one auto-run) */
    setTimeout(function () { if (avPhase === "out") avatarEnter(); }, 700);
    if (statusEl) {
      statusEl.textContent = "cabin ready · drag to orbit · [C] walk outside · W/S/Q/E travel";
      setTimeout(function () { statusEl.className = "viewer-status gone"; }, 1600);
    }

    /* ---- render loop ----------------------------------------------------- */
    var last = (window.performance && performance.now) ? performance.now() : Date.now();
    var ticked = false;
    function animate(now) {
      requestAnimationFrame(animate);
      var dt = Math.min(Math.max((now - last) / 1000, 0), 0.05) || 0.016;
      last = now;
      if (!camAnim) applyTravel(dt);
      /* simulation clock drives all motion: stop freezes it, the speed
         multiplier scales it, jump-to-time rewrites it — dash and cloud
         positions are pure functions of simTime */
      if (state.simRunning) state.simTime += dt * state.simSpeed;
      dashG.position.z = -((state.simTime * DASH_SPEED) % DASH_GAP);
      for (var i = 0; i < clouds.length; i++) {
        var c = clouds[i];
        c.position.x = -34 + mod68(c.userData.x0 + state.simTime * c.userData.s);
      }
      paintClock();
      stepAvatar(now);
      syncSeatFromCog(now);
      controls.update();
      if (camAnim) {
        /* flight owns the camera; controls.update() above keeps damping
           residuals draining while position/look-at come from the tween */
        stepCamAnim(now);
      } else {
        var d = camera.position.distanceTo(controls.target);
        if (state.mode === "interior" && d > EXIT_DIST && d > lastDist && !dragging) {
          beginTrans("exterior");
        } else if (state.mode === "exterior" && d < ENTER_DIST && d < lastDist && !dragging) {
          beginTrans("interior");
        }
        if (!camAnim && state.mode === "interior") clampCam();
        lastDist = camera.position.distanceTo(controls.target);
      }
      /* roof cap = exterior part only: hidden while the eye is under it,
         so the interior never shows a grey ceiling panel overhead */
      roofMesh.visible = state.roof && !insideShell(camera.position);
      renderer.render(scene, camera);
      state.camPos = camera.position.toArray();
      state.target = controls.target.toArray();
      if (!ticked) { ticked = true; console.log("animate tick"); }
    }
    requestAnimationFrame(animate);
  } catch (e) {
    state.error = "init-failed";
    console.error("[cabin] init failed:", e);
    fatal("cabin init failed\n\n" + ((e && e.stack) || e));
  }
}

/* Deferred module scripts run after parsing, so boot() executes with the DOM
   fully available; if the script ever arrives mid-parse, wait for the real
   DOMContentLoaded event first (canvas #cabin3d must exist). */
function start() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
    return;
  }
  boot();
}
start();
