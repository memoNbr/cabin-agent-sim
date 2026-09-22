/* ============================================================
   cabin-agent-sim — minimal cabin scene (clean rewrite)

   cubic interior (floor, windowed walls — frames + tinted glass so the
     cabin is visible from outside when the roof is off — dashboard cube;
     NO ceiling panel: the roof cap is exterior-only, open to the sky)
   simple SUV shell (full-height lower body + exterior-only roof cap + 4 wheels)
   gradient sky dome + drifting cloud parallax
   road plane with animated dashed centre line
   OrbitControls, [C] interior/exterior toggle
   wheel-zoom walk-out / walk-in: 500 ms eased camera flight with a
     shell fade, so the move never clips or blocks on geometry
   adjustable seat on the avatar's mount point: height / rotation /
     lateral / longitudinal sliders in the sim bar

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
  target: null
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
        pos: new THREE.Vector3(0, 0.75, -0.95),
        target: new THREE.Vector3(0, 0.5, 1.0)
      },
      exterior: {
        /* three-quarter REAR view, pulled back so the whole vehicle, the road
           beneath it and the road running to the horizon all fit in frame
           (hood faces +z, so the tailgate is the -z end) */
        pos: new THREE.Vector3(-6.8, 3.0, -8.6),
        target: new THREE.Vector3(0, 0.7, 0)
      }
    };
    camera.position.copy(HOME.interior.pos);

    /* Seat mount point for the avatar — a bare Object3D, no rig; it also
       carries the adjustable seat meshes (see below), so slider changes land
       directly on cabinApi.seatMount position/rotation. It doubles as
       avatar.js's seatRig/agentMount guard fields (same node); x/z rest at
       avatar.js's driver waypoint, y follows the height slider (updateSeat,
       default hgt 38 cm → y = 0.10). */
    var seatMount = new THREE.Object3D();
    seatMount.name = "seatMount";
    seatMount.position.set(-0.42, 0.1, 0.55);

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

    /* -- cubic interior: floor 0.12, walls up to the roof line (tops 1.35;
           the body top stops 1 cm lower at 1.34 so the wall tops never
           z-fight it when the cap is off). Each wall is built as a WINDOW
           FRAME (body colour 0x55555d) plus tinted glass (0x88aacc @ 0.3):
           side windows 0.8 x 0.5 centred at y 0.8, windscreen / rear
           window full width x 0.5 across the top — so with the roof off
           the exterior still reads as a vehicle AND you can see straight
           into the cabin from outside. The frame pieces are solid meshes,
           so they stay solid from in here; there is NO ceiling panel of
           any kind (the roof cap only draws for an eye outside the shell —
           see insideShell), the cabin is open floor-to-roof to the sky. */
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
    /* side walls: sill + header + fore/aft pillars around the opening
       z -0.40..0.40 (0.8 long), y 0.55..1.05 (0.5 tall, centre y 0.80) */
    wPart("wallLsill", 0.06, 0.43, 2.6, -0.93, 0.335, 0);
    wPart("wallLhead", 0.06, 0.30, 2.6, -0.93, 1.2, 0);
    wPart("wallLpilF", 0.06, 0.5, 0.9, -0.93, 0.8, 0.85);
    wPart("wallLpilR", 0.06, 0.5, 0.9, -0.93, 0.8, -0.85);
    wGlass("wallLglass", 0.02, 0.5, 0.8, -0.93, 0.8, 0);
    wPart("wallRsill", 0.06, 0.43, 2.6, 0.93, 0.335, 0);
    wPart("wallRhead", 0.06, 0.30, 2.6, 0.93, 1.2, 0);
    wPart("wallRpilF", 0.06, 0.5, 0.9, 0.93, 0.8, 0.85);
    wPart("wallRpilR", 0.06, 0.5, 0.9, 0.93, 0.8, -0.85);
    wGlass("wallRglass", 0.02, 0.5, 0.8, 0.93, 0.8, 0);
    /* windscreen / rear window: full width, y 0.85..1.35 (top 0.5) */
    wPart("wallFcowl", 1.92, 0.73, 0.06, 0, 0.485, 1.33);
    wGlass("wallFglass", 1.92, 0.5, 0.02, 0, 1.1, 1.33);
    wPart("wallBcowl", 1.92, 0.73, 0.06, 0, 0.485, -1.33);
    wGlass("wallBglass", 1.92, 0.5, 0.02, 0, 1.1, -1.33);
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
    pedestal.scale.y = 0.24;   /* 0.12..0.36 on the floor at the default */

    /* -- simple SUV: full-height body + exterior-only roof cap + 4 wheels -----
           The body runs all the way to 1.34 (top); the roof is a thin cap
           seated on the wall tops (1.35..1.40). The cap is an EXTERIOR
           part only: the render loop hides it while the eye is inside the
           shell (insideShell), so it never draws as a grey ceiling panel
           in there — the interior sees sky, the exterior sees a solid
           roof (roof off = cap hidden in both views). ------------------- */
    var suv = new THREE.Group();
    suv.name = "suv";
    scene.add(suv);
    var bodyLower = box(suv, "bodyLower", 1.96, 1.28, 4.3, 0x4a4a52, 0, 0.70, 0, 0.75);
    /* cap (±0.96) seats exactly on the wall tops at y 1.35, inset 2 cm
       from the body sides (±0.98); the body stopping at 1.34 keeps every
       horizontal plane distinct (no z-fighting when the cap is hidden) */
    var roofMesh = box(suv, "bodyRoof", 1.92, 0.05, 3.4, 0x55555d, 0, 1.375, -0.15, 0.75);
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
      yHi: 1.2,
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
      bodyLower.userData.baseOpacity = b;
      var bm = bodyLower.material;
      if (bm.opacity !== b) bm.opacity = b;
      var bt = b < 0.999;
      if (bm.transparent !== bt) { bm.transparent = bt; bm.needsUpdate = true; }
      if (roofBtn) roofBtn.className = "btn" + (state.roof ? " on" : "");
    }
    /* the roof cap is exterior-only: hide it whenever the eye is inside
       the body shell (x ±0.98, y 0.06..1.34, z ±2.15 — the exact volume
       whose own faces are backface-culled), so in there nothing ever
       draws overhead and the sky dome shows through the open roof line.
       From outside the cap renders as the full solid exterior roof. */
    function insideShell(p) {
      return p.x > -0.98 && p.x < 0.98 &&
             p.y > 0.06 && p.y < 1.34 &&
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
    function updateSeat() {
      seatMount.position.set(
        -0.42 + seatCtl.lat / 100,
        seatCtl.hgt / 100 - 0.28,   /* cushion top = floor(0.12) + hgt cm */
        0.55 + seatCtl.lng / 100
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
      updateSeat();
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
      if (hits.length && seatSysOn && seatParts.indexOf(hits[0].object) !== -1) focusSeat();
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
    var SHELL = wallParts.concat([roofMesh, bodyLower]);
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
