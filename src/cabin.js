import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export const cabinApi = (function () {
  var HOST = document.getElementById("cabin3d");
  var statusEl = document.getElementById("viewerStatus");
  var hintEl = document.getElementById("viewerHint");
  var roofBtn = document.getElementById("vRoof");
  var resetBtn = document.getElementById("vReset");
  var PARTS = [];
  var state = window.__CABIN3D__ = {
    ready: false, error: null, webgl: false, revision: THREE.REVISION,
    view: "shell-drawn", roof: true, photo: false, parts: [], travelKeys: [],
    triangles: 0, camPos: null, target: null
  };
  function status(t, err) {
    if (!statusEl) return;
    statusEl.textContent = t;
    statusEl.className = "viewer-status" + (err ? " err" : "");
  }
  if (!HOST || !HOST.getContext) { state.error = "no-canvas"; return; }
  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: HOST, antialias: true, powerPreference: "high-performance" });
  } catch (e) {
    state.error = "no-webgl"; status("3D unavailable — WebGL not supported in this browser", true); return;
  }
  state.webgl = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  if ("outputColorSpace" in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;

  var scene = new THREE.Scene();
  try {
    var bgc = document.createElement("canvas"); bgc.width = 4; bgc.height = 256;
    var bgx = bgc.getContext("2d");
    if (bgx) {
      var grd = bgx.createLinearGradient(0, 0, 0, 256);
      grd.addColorStop(0, "#93a1b5"); grd.addColorStop(0.52, "#525c6c"); grd.addColorStop(1, "#232a34");
      bgx.fillStyle = grd; bgx.fillRect(0, 0, 4, 256);
      var bgTex = new THREE.CanvasTexture(bgc);
      if ("colorSpace" in bgTex) bgTex.colorSpace = THREE.SRGBColorSpace;
      scene.background = bgTex;
    }
  } catch (e) { scene.background = new THREE.Color(0x525c6c); }
  var pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;

  var camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.02, 60);
  /* starts low, facing forward, at driver eye height, looking up toward the windshield cant */
  var homeCam = { pos: new THREE.Vector3(-0.34, 1.06, 0.18), target: new THREE.Vector3(0.14, 0.52, 1.32) };
  camera.position.copy(homeCam.pos);

  /* cool ambient + a soft warm key so the white reads cleanly */
  scene.add(new THREE.HemisphereLight(0xcfe0f5, 0x39424e, 1.15));
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  var key = new THREE.DirectionalLight(0xfff2dc, 1.35); key.position.set(-2.2, 3.6, 2.8); scene.add(key);
  var rim = new THREE.DirectionalLight(0x9dbdff, 1.0); rim.position.set(3.0, 1.6, -3.2); scene.add(rim);

  var controls = new OrbitControls(camera, HOST);
  controls.enableDamping = true; controls.dampingFactor = 0.075;
  controls.rotateSpeed = 0.7; controls.zoomSpeed = 0.85; controls.panSpeed = 0.7;
  controls.screenSpacePanning = true;
  controls.target.copy(homeCam.target);
  controls.minDistance = 0.12; controls.maxDistance = 9;
  state.THREE = THREE; state.camera = camera; state.controls = controls;

  /* ================= drawn-shell builder ================= */
  var shell = new THREE.Group(); shell.name = "cabinShell"; scene.add(shell);
  var roofG = new THREE.Group(); roofG.name = "roofAssembly"; shell.add(roofG);
  var fillMat = new THREE.MeshStandardMaterial({ color: 0xf5f6f8, roughness: 0.92, metalness: 0.0 });
  fillMat.envMapIntensity = 0.22;
  fillMat.polygonOffset = true; fillMat.polygonOffsetFactor = -1.5; fillMat.polygonOffsetUnits = -2;
  var edgeMat = new THREE.LineBasicMaterial({ color: 0x0a0c10 });

  function tag(o, name) {
    o.name = name;
    o.userData.part = name;
    if (PARTS.indexOf(name) === -1) PARTS.push(name);
    return o;
  }
  function drawn(name, geometry, color, group) {
    var m = fillMat.clone(); m.color.setHex(color === undefined ? 0xf5f6f8 : color);
    var mesh = new THREE.Mesh(geometry, m);
    group = group || shell;
    group.add(tag(mesh, name));
    if (geometry.index) state.triangles += geometry.index.count / 3;
    else if (geometry.attributes.position) state.triangles += geometry.attributes.position.count / 3;
    var edges = new THREE.EdgesGeometry(geometry, 8);
    var ln = new THREE.LineSegments(edges, edgeMat);
    group.add(tag(ln, name + "-edge"));
  }
  function boxPart(name, cx, cy, cz, w, h, d, color, group, rot) {
    var g = new THREE.BoxGeometry(w, h, d);
    g.translate(cx, cy, cz);
    if (rot) { g.rotateX(rot.rx || 0); g.rotateZ(rot.rz || 0); }
    drawn(name, g, color, group);
  }
  function quadPart(name, corners, color, group) {
    var g = new THREE.BufferGeometry();
    var pos = new Float32Array([
      corners[0][0], corners[0][1], corners[0][2],
      corners[1][0], corners[1][1], corners[1][2],
      corners[2][0], corners[2][1], corners[2][2],
      corners[3][0], corners[3][1], corners[3][2]
    ]);
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.computeVertexNormals();
    drawn(name, g, color, group);
  }

  boxPart("floorPan", 0, 0.06, -0.05, 1.74, 0.12, 2.5, 0xf7f8fa);
  boxPart("centerTunnel", 0, 0.21, -0.10, 0.34, 0.18, 1.9, 0xeef1f4);
  boxPart("doorCardL", -0.745, 0.40, -0.05, 0.05, 0.56, 2.06, 0xf2f4f6);
  boxPart("doorCardR", 0.745, 0.40, -0.05, 0.05, 0.56, 2.06, 0xf2f4f6);
  boxPart("armrestL", -0.66, 0.46, 0.0, 0.12, 0.06, 0.7, 0xeaedf0);
  boxPart("armrestR", 0.66, 0.46, 0.0, 0.12, 0.06, 0.7, 0xeaedf0);
  boxPart("pillarA-L", -0.635, 0.91, 0.81, 0.09, 0.46, 0.09, 0xf3f5f7, shell, { rx: -0.13, rz: -0.151 });
  boxPart("pillarA-R", 0.635, 0.91, 0.81, 0.09, 0.46, 0.09, 0xf3f5f7, shell, { rx: -0.13, rz: 0.151 });
  boxPart("pillarB-L", -0.67, 0.88, 0.30, 0.08, 0.44, 0.08, 0xf3f5f7);
  boxPart("pillarB-R", 0.67, 0.88, 0.30, 0.08, 0.44, 0.08, 0xf3f5f7);
  boxPart("rearBulkhead", 0, 0.49, -1.13, 1.42, 0.75, 0.05, 0xf2f4f6);
  boxPart("rearLedge", 0, 0.88, -1.12, 1.42, 0.045, 0.16, 0xeaedf0);
  quadPart("windshieldCant", [
    [-0.60, 1.12, 0.80], [0.60, 1.12, 0.80], [0.66, 0.40, 1.20], [-0.66, 0.40, 1.20]
  ], 0xdfe6ee);
  boxPart("dashCowl", 0, 0.43, 1.06, 1.34, 0.045, 0.20, 0xecf0f4);
  boxPart("roofRailL", -0.655, 1.14, -0.15, 0.08, 0.05, 1.9, 0xf5f6f8, roofG);
  boxPart("roofRailR", 0.655, 1.14, -0.15, 0.08, 0.05, 1.9, 0xf5f6f8, roofG);
  boxPart("roofHeaderFront", 0, 1.145, 0.85, 1.36, 0.055, 0.09, 0xf5f6f8, roofG);
  boxPart("roofHeaderRear", 0, 1.125, -1.12, 1.36, 0.055, 0.09, 0xf5f6f8, roofG);
  boxPart("sunroofFrameF", 0, 1.13, 0.60, 0.70, 0.045, 0.045, 0xf2f4f6, roofG);
  boxPart("sunroofFrameR", 0, 1.13, -0.02, 0.70, 0.045, 0.045, 0xf2f4f6, roofG);
  boxPart("sunroofFrameL", -0.35, 1.13, 0.29, 0.045, 0.045, 0.62, 0xf2f4f6, roofG);
  boxPart("sunroofFrameRib", 0.35, 1.13, 0.29, 0.045, 0.045, 0.62, 0xf2f4f6, roofG);

  /* ================= seat mount point =================
     SEAT.mount: world-space foot of the driver seat. The seat rig is built here,
     live-offset each frame from S.rot (yaw deg) / S.sl (±8 cm) / height (cm). */
  var SEAT = {
    mount: { x: -0.34, y: 0.12, z: -0.05 },
    pivot: { x: -0.34, y: 0.12, z: -0.05 },
    default: { rotDeg: 0, slideCm: 0, heightCm: 38 }
  };
  var seatMount = tag(new THREE.Object3D(), "seatMount");
  seatMount.position.set(SEAT.mount.x, SEAT.mount.y, SEAT.mount.z);
  seatMount.userData.SEAT = true;
  seatMount.userData.seatDefault = { rotDeg: SEAT.default.rotDeg, slideCm: SEAT.default.slideCm, heightCm: SEAT.default.heightCm };
  shell.add(seatMount);
  var fp = new THREE.BufferGeometry();
  fp.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
    -0.23, 0.002, -0.29, 0.23, 0.002, -0.29, 0.23, 0.002, 0.19, -0.23, 0.002, 0.19
  ]), 3));
  var fpMat = new THREE.LineDashedMaterial({ color: 0x0a0c10, transparent: true, opacity: 0.4, dashSize: 0.045, gapSize: 0.035 });
  var fpLines = new THREE.LineLoop(fp, fpMat);
  fpLines.computeLineDistances();
  tag(fpLines, "seatFootprintDashed");
  seatMount.add(fpLines);

  /* drawn seat rig — white parts with black outline edges, matching the shell.
     seatRig sits at the mount and carries every live seat transform so S.rot /
     S.sl / height move this exact seat the agent will take. */
  var seatRig = tag(new THREE.Group(), "seatRig");
  seatMount.add(seatRig);
  boxPart("seatPlinth", 0, 0.03, 0, 0.54, 0.04, 0.46, 0xf2f4f6, seatRig);
  boxPart("seatSquab", 0, 0.19, 0, 0.52, 0.28, 0.50, 0xf5f6f8, seatRig);
  boxPart("seatBack", 0, 0.52, -0.24, 0.50, 0.56, 0.12, 0xf3f5f7, seatRig, { rx: -0.16 });
  boxPart("seatHead", 0, 0.84, -0.35, 0.30, 0.11, 0.08, 0xf3f5f7, seatRig, { rx: -0.16 });
  var agentMount = tag(new THREE.Object3D(), "agentMount");
  agentMount.position.set(0, 0.86, 0.02);
  agentMount.userData.AGENT = true;
  seatRig.add(agentMount);
  state.SEAT = SEAT; state.seatMount = seatMount; state.agentMount = agentMount;
  state.seatRig = seatRig;

  var travel = new THREE.Vector3();
  var travelF = new THREE.Vector3(), travelR = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  var keyState = {};
  function isTyping() {
    var a = document.activeElement;
    return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
  }
  window.addEventListener("keydown", function (e) {
    var k = (e.key || "").toLowerCase();
    if (k !== "w" && k !== "s" && k !== "q" && k !== "e") return;
    if (isTyping()) return;
    keyState[k] = true;
    if (state.travelKeys.indexOf(k) === -1) state.travelKeys.push(k);
    if (hintEl) hintEl.classList.add("gone");
  });
  window.addEventListener("keyup", function (e) { keyState[(e.key || "").toLowerCase()] = false; });
  window.addEventListener("blur", function () { for (var k in keyState) keyState[k] = false; });

  function applyTravel(dt) {
    var sp = 0.6 * dt;
    travelF.subVectors(controls.target, camera.position); travelF.y = 0;
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
  }

  function setRoof(on) {
    state.roof = !!on;
    roofG.visible = state.roof;
    if (roofBtn) roofBtn.className = "btn" + (state.roof ? " on" : "");
  }
  function resetView() {
    camera.position.copy(homeCam.pos);
    controls.target.copy(homeCam.target);
    controls.update();
  }

  camera.position.copy(homeCam.pos);
  controls.target.copy(homeCam.target);
  controls.update();
  setRoof(true);
  state.ready = true;
  state.camPos = camera.position.toArray();
  state.target = controls.target.toArray();
  state.parts = PARTS.slice();
  status("shell drawn · " + PARTS.length + " parts · seat mounted & live");
  setTimeout(function () { if (statusEl) statusEl.className = "viewer-status gone"; }, 1600);

  function resize() {
    var w = HOST.clientWidth || 1, h = HOST.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  if (window.ResizeObserver) { try { new ResizeObserver(resize).observe(HOST); } catch (e) { /* ignore */ } }
  window.addEventListener("resize", resize);
  resize();

  HOST.addEventListener("pointerdown", function () { HOST.classList.add("grabbing"); if (hintEl) hintEl.classList.add("gone"); });
  window.addEventListener("pointerup", function () { HOST.classList.remove("grabbing"); });
  if (roofBtn) roofBtn.addEventListener("click", function () { setRoof(!state.roof); });
  if (resetBtn) resetBtn.addEventListener("click", resetView);
  var photoBtn = document.getElementById("vPhoto");
  var photoEl = document.getElementById("scenePhoto");
  if (photoBtn && photoEl) {
    function setPhoto(on) {
      state.photo = !!on;
      photoEl.classList.toggle("on", state.photo);
      photoBtn.className = "btn" + (state.photo ? " on" : "");
    }
    photoBtn.addEventListener("click", function () { setPhoto(!state.photo); });
    photoEl.addEventListener("click", function () { setPhoto(false); });
  }

  var last = (window.performance && performance.now) ? performance.now() : Date.now();
  function animate(now) {
    requestAnimationFrame(animate);
    var dt = Math.min((now - last) / 1000, 0.05); last = now;
    if (dt > 0) applyTravel(dt);
    var live = window.__SEAT_LIVE__;
    if (live && seatRig) {
      seatRig.position.y = (live.hgt - SEAT.default.heightCm) / 100;
      seatRig.position.z = live.sl / 100;
      seatRig.rotation.y = THREE.MathUtils.degToRad(live.rot);
      state.seatLive = { rot: live.rot, sl: live.sl, hgt: live.hgt };
    }
    controls.update();
    renderer.render(scene, camera);
    state.camPos = camera.position.toArray();
    state.target = controls.target.toArray();
  }
  requestAnimationFrame(animate);

  state.hook = function (opts) {
    opts = opts || {};
    if (opts.setRoof !== undefined) setRoof(opts.setRoof);
    if (opts.reset) resetView();
    return {
      ready: state.ready, error: state.error, webgl: state.webgl, revision: state.revision,
      view: state.view, parts: state.parts.slice(), triangles: Math.round(state.triangles),
      roof: state.roof, photo: state.photo,
      cam: camera.position.toArray(), target: controls.target.toArray(),
      distance: camera.position.distanceTo(controls.target),
      orbit: !!controls, reticle: HOST.clientWidth + "x" + HOST.clientHeight,
      seatMount: { name: seatMount.name, pos: seatMount.position.toArray(), default: seatMount.userData.seatDefault },
      seatRig: {
        name: seatRig.name,
        pos: seatRig.position.toArray(),
        rotY: seatRig.rotation.y,
        live: state.seatLive || null
      },
      agentMount: {
        name: agentMount.name,
        local: agentMount.position.toArray(),
        world: agentMount.getWorldPosition(new THREE.Vector3()).toArray(),
        agent: agentMount.userData.AGENT
      },
      SEAT: SEAT,
      travelKeys: state.travelKeys.slice()
    };
  };
  return {
    scene: scene, camera: camera, controls: controls, renderer: renderer,
    seatRig: seatRig, agentMount: agentMount, seatMount: seatMount, state: state
  };
})();
