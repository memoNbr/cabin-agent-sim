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
      grd.addColorStop(0, "#ffffff"); grd.addColorStop(0.5, "#f2f2f2"); grd.addColorStop(1, "#e2e2e4");
      bgx.fillStyle = grd; bgx.fillRect(0, 0, 4, 256);
      var bgTex = new THREE.CanvasTexture(bgc);
      if ("colorSpace" in bgTex) bgTex.colorSpace = THREE.SRGBColorSpace;
      scene.background = bgTex;
    }
  } catch (e) { scene.background = new THREE.Color(0xf5f8fc); }
  var pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;

  var camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.02, 60);
  /* starts at driver eye height, looking forward into the clean white cabin */
  var homeCam = { pos: new THREE.Vector3(-0.34, 1.06, 0.4), target: new THREE.Vector3(0, 0.55, 1.0) };
  camera.position.copy(homeCam.pos);

  /* soft even lighting for clean white interior */
  scene.add(new THREE.HemisphereLight(0xffffff, 0xffffff, 1.0));
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  var key = new THREE.DirectionalLight(0xffffff, 0.8); key.position.set(-1.5, 3.0, 2.0); scene.add(key);
  var fill = new THREE.DirectionalLight(0xf4f4f4, 0.5); fill.position.set(1.5, 2.5, -2.0); scene.add(fill);
  var rim = new THREE.DirectionalLight(0xeaeaea, 0.3); rim.position.set(0, 3.5, 0); scene.add(rim);

  var controls = new OrbitControls(camera, HOST);
  controls.enableDamping = true; controls.dampingFactor = 0.075;
  controls.rotateSpeed = 0.7; controls.zoomSpeed = 0.85; controls.panSpeed = 0.7;
  controls.screenSpacePanning = true;
  controls.target.copy(homeCam.target);
  controls.minDistance = 0.12; controls.maxDistance = 9;
  state.THREE = THREE; state.camera = camera; state.controls = controls; state.scene = scene;

  /* ================= drawn-shell builder ================= */
  var shell = new THREE.Group(); shell.name = "cabinShell"; scene.add(shell);
  var roofG = new THREE.Group(); roofG.name = "roofAssembly"; shell.add(roofG);
  var fillMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.0 });
  fillMat.envMapIntensity = 0.1;
  fillMat.polygonOffset = true; fillMat.polygonOffsetFactor = -1.5; fillMat.polygonOffsetUnits = -2;
  var edgeMat = new THREE.LineBasicMaterial({ color: 0x14171c });

  function tag(o, name) {
    o.name = name;
    o.userData.part = name;
    if (PARTS.indexOf(name) === -1) PARTS.push(name);
    return o;
  }
  function drawn(name, geometry, color, group) {
    var m = fillMat.clone(); m.color.setHex(color === undefined ? 0xffffff : color);
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
    if (rot) { g.rotateX(rot.rx || 0); g.rotateY(rot.ry || 0); g.rotateZ(rot.rz || 0); }
    drawn(name, g, color, group);
  }

  /* ================= empty monochrome shell (black + greys + off-white) ================= */
  var W = 1.74, L = 2.5, H = 1.2;
  var halfW = W / 2, halfL = L / 2;
  var C = {
    /* neutral monolithic cabin — deep neutral blacks, matte: exterior body
       (walls), carpet, roof shell. No colour cast. */
    body: 0x0e0e10,   /* walls / body shell */
    carpet: 0x070708, /* floor */
    headliner: 0x0c0c0e, headBands: 0x141416, seam: 0x101012,
    /* charcoal cabin trim — dash / doors / seat bases */
    leather: 0x202022, leather2: 0x29292c, bolster: 0x1c1c1e,
    /* off-white Ivory accents — seats, armrests, inserts (the white read) */
    ivory: 0xe9e7e1, ivory2: 0xdad8d2,
    /* thread: light grey on black panels, dark on ivory surfaces */
    stitch: 0xc9c7c1, threadDark: 0x232326,
    /* hardware + trim (neutral) */
    alu: 0xb9b7b3, aluDark: 0x8b8985, steel: 0x1d1d1f,
    wheel: 0x141416, hub: 0x26262a, blackBtn: 0x0e0e10, cluster: 0x0e0e10,
    /* GTS red — kept only as a thin hairline pinstripe on the roofline */
    red: 0xd4001f, redDim: 0x9a0f22
  };
  var J = { body: C.body, carpet: C.carpet, headliner: C.headliner, headBands: C.headBands, seam: C.seam };
  boxPart("floor", 0, 0.06, 0, W, 0.12, L, J.carpet);
  boxPart("wallL", -halfW, H / 2, 0, 0.08, H, L, J.body);
  boxPart("wallR", halfW, H / 2, 0, 0.08, H, L, J.body);
  boxPart("wallF", 0, H / 2, halfL, W, H, 0.08, J.body);
  boxPart("wallRear", 0, H / 2, -halfL, W, H, 0.08, J.body);
  boxPart("ceiling", 0, H + 0.06, 0, W, 0.1, L, J.headliner, roofG);
  /* jet-black roofline from inside: subtle texture bands across the headliner */
  boxPart("headlinerBandF", 0, 1.208, 0.55, W - 0.12, 0.004, 0.05, J.headBands, roofG);
  boxPart("headlinerBandC", 0, 1.208, 0, W - 0.12, 0.004, 0.05, J.headBands, roofG);
  boxPart("headlinerBandR", 0, 1.208, -0.55, W - 0.12, 0.004, 0.05, J.headBands, roofG);
  /* thin seam where the roofline meets the glass */
  boxPart("headlinerSeam", 0, 1.205, 0, W + 0.02, 0.012, L + 0.02, J.seam, roofG);
  /* red GTS pinstripe welt along the roof edge seams — the black-car read */
  boxPart("roofPinstripeF", 0, 1.258, 1.2535, W - 0.02, 0.01, 0.01, C.red, roofG);
  boxPart("roofPinstripeRear", 0, 1.258, -1.2535, W - 0.02, 0.01, 0.01, C.red, roofG);
  boxPart("roofPinstripeLeft", -0.873, 1.258, 0, 0.01, 0.01, L - 0.02, C.red, roofG);
  boxPart("roofPinstripeRight", 0.873, 1.258, 0, 0.01, 0.01, L - 0.02, C.red, roofG);

  /* subtle window accents — thin glazing lines on front/rear walls */
  var winMat = new THREE.MeshStandardMaterial({ color: 0xcfd2d6, roughness: 0.1, metalness: 0.0, transparent: true, opacity: 0.18 });
  winMat.envMapIntensity = 0.3;
  function winQuad(name, corners, group) {
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
    var mesh = new THREE.Mesh(g, winMat);
    group = group || shell;
    group.add(tag(mesh, name));
    var edges = new THREE.EdgesGeometry(g, 8);
    var ln = new THREE.LineSegments(edges, edgeMat);
    group.add(tag(ln, name + "-edge"));
  }
  winQuad("windshield", [
    [-0.55, 0.95, halfL - 0.01], [0.55, 0.95, halfL - 0.01],
    [0.60, 0.35, halfL - 0.01], [-0.60, 0.35, halfL - 0.01]
  ]);
  winQuad("rearWindow", [
    [-0.55, 0.95, -halfL + 0.01], [0.55, 0.95, -halfL + 0.01],
    [0.55, 0.45, -halfL + 0.01], [-0.55, 0.45, -halfL + 0.01]
  ]);
  winQuad("sideWindowL", [
    [-halfW + 0.01, 0.95, 0.65], [-halfW + 0.01, 0.95, -0.65],
    [-halfW + 0.01, 0.45, -0.65], [-halfW + 0.01, 0.45, 0.65]
  ]);
  winQuad("sideWindowR", [
    [halfW - 0.01, 0.95, 0.65], [halfW - 0.01, 0.95, -0.65],
    [halfW - 0.01, 0.45, -0.65], [halfW - 0.01, 0.45, 0.65]
  ]);
  /* windshield sits on a real cowl: raise its lower edge onto the dash brow */
  var ws = scene.getObjectByName("windshield");
  if (ws) {
    var wp = ws.geometry.attributes.position;
    if (wp) {
      var wa = wp.array;
      for (var wi = 0; wi < wa.length; wi += 3) if (Math.abs(wa[wi + 1] - 0.35) < 1e-3) wa[wi + 1] = 0.70;
      wp.needsUpdate = true;
    }
  }

  /* ================= monochrome interior surfaces =================
     empty-wrap over the empty cabin shell: sculpted dash, low center
     console (screen powered off), door cards with ivory armrests +
     metallic accents, three-spoke multi-function wheel, blank cluster.
     Power is OFF, no occupant fixtures — freshly-delivered interior. */
  var interior = tag(new THREE.Group(), "cabinInterior");
  shell.add(interior);
  var aluMat = new THREE.MeshStandardMaterial({ color: C.alu, roughness: 0.35, metalness: 0.85 });
  var aluDarkMat = new THREE.MeshStandardMaterial({ color: C.aluDark, roughness: 0.4, metalness: 0.8 });
  var glassMat = new THREE.MeshStandardMaterial({ color: 0x0e1013, roughness: 0.18, metalness: 0.9 });
  /* unpowered = blank/off: the portrait screen is a single dark matte panel */
  var screenMat = new THREE.MeshStandardMaterial({ color: 0x08080a, roughness: 0.85, metalness: 0.15, emissive: 0x000000 });
  aluMat.envMapIntensity = 0.8; aluDarkMat.envMapIntensity = 0.7; glassMat.envMapIntensity = 0.6;
  function meshPart(name, geometry, mat, group) {
    var m = new THREE.Mesh(geometry, mat === undefined ? fillMat : mat);
    group = group || interior;
    group.add(tag(m, name));
    if (geometry.index) state.triangles += geometry.index.count / 3;
    else if (geometry.attributes.position) state.triangles += geometry.attributes.position.count / 3;
    return m;
  }
  function boxM(name, cx, cy, cz, w, h, d, mat, group, rot) {
    var g = new THREE.BoxGeometry(w, h, d);
    g.translate(cx, cy, cz);
    if (rot) { g.rotateX(rot.rx || 0); g.rotateY(rot.ry || 0); g.rotateZ(rot.rz || 0); }
    meshPart(name, g, mat, group);
  }
  function arc(name, cx, cy, cz, r, color, group, from, to, seg) {
    from = from === undefined ? 0 : from; to = to === undefined ? Math.PI * 2 : to;
    seg = seg || 40;
    var pts = [];
    for (var i = 0; i <= seg; i++) {
      var a = from + (to - from) * i / seg;
      pts.push(new THREE.Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, cz));
    }
    var g = new THREE.BufferGeometry().setFromPoints(pts);
    var ln = new THREE.Line(g, new THREE.LineBasicMaterial({ color: color }));
    (group || interior).add(tag(ln, name));
  }

  /* ---- door cards (driver + passenger) ---- */
  function doorCard(sign) {
    var xo = sign * 0.80, tl = sign < 0 ? "L" : "R", s = sign;
    boxPart("doorPanel" + tl, xo, 0.40, 0, 0.10, 0.80, 1.88, C.leather2, interior);
    boxPart("doorInsert" + tl, xo - s * 0.045, 0.40, -0.05, 0.016, 0.40, 1.1, C.ivory2, interior);
    boxPart("doorShoulder" + tl, xo, 0.80, 0.12, 0.055, 0.018, 1.55, C.alu, interior);
    boxPart("armrest" + tl, xo, 0.34, 0.10, 0.14, 0.065, 0.52, C.ivory, interior);
    boxPart("armrestStitch" + tl, xo, 0.362, 0.02, 0.006, 0.012, 0.44, C.threadDark, interior);
    boxPart("doorPull" + tl, xo + s * 0.035, 0.24, 0.06, 0.07, 0.04, 0.34, C.aluDark, interior);
    boxPart("doorSwitchPad" + tl, xo - s * 0.045, 0.36, 0.30, 0.05, 0.025, 0.08, C.cluster, interior);
  }
  doorCard(-1); doorCard(1);

  /* ---- sculpted dashboard ---- */
  boxPart("dashFascia", 0, 0.38, 1.18, W, 0.50, 0.10, C.leather, interior);
  boxPart("dashBrow", 0, 0.68, 1.10, 1.56, 0.08, 0.26, C.leather2, interior);
  boxPart("dashChrome", 0, 0.722, 1.13, 1.5, 0.012, 0.2, C.alu, interior);
  boxPart("dashStitch", 0, 0.722, 0.99, 1.3, 0.006, 0.008, C.stitch, interior);
  boxPart("dashLower", 0, 0.10, 1.185, W, 0.14, 0.10, J.body, interior);
  boxPart("ventL", -0.28, 0.46, 1.172, 0.10, 0.05, 0.016, C.aluDark, interior);
  boxPart("ventC", 0, 0.46, 1.172, 0.16, 0.05, 0.016, C.aluDark, interior);
  boxPart("ventR", 0.28, 0.46, 1.172, 0.10, 0.05, 0.016, C.aluDark, interior);

  /* ---- low center console + wide portrait infotainment ---- */
  boxPart("consoleTunnel", 0, 0.22, 0.55, 0.46, 0.30, 1.05, J.body, interior);
  boxPart("consoleTray", 0, 0.40, 0.50, 0.31, 0.12, 0.88, C.leather2, interior);
  boxPart("consoleKnee", 0, 0.28, 1.16, 0.32, 0.28, 0.20, C.leather, interior);
  boxPart("consoleShifter", 0, 0.50, 0.315, 0.19, 0.055, 0.34, C.leather, interior);
  var knob = meshPart("shifterKnob", new THREE.CylinderGeometry(0.022, 0.026, 0.05, 14), aluDarkMat);
  knob.position.set(0, 0.545, 0.30);
  boxPart("consoleSeam", 0, 0.503, 0.16, 0.15, 0.006, 0.007, C.stitch, interior);
  boxM("screenFrame", 0, 0.63, 0.80, 0.32, 0.30, 0.04, aluDarkMat, interior, { ry: -0.10 });
  boxM("screenGlass", 0, 0.63, 0.802, 0.295, 0.272, 0.02, glassMat, interior, { ry: -0.10 });
  boxM("infotainmentScreen", 0, 0.63, 0.808, 0.285, 0.262, 0.014, screenMat, interior, { ry: -0.10 });

  /* ---- three-spoke multi-function steering wheel + column ---- */
  boxPart("steeringColumn", -0.34, 0.80, 1.12, 0.055, 0.055, 0.24, C.cluster, interior);
  var wheelG = tag(new THREE.Group(), "steeringAssembly");
  wheelG.position.set(-0.34, 0.80, 1.02);
  wheelG.rotation.set(-0.22, 0.16, 0);
  interior.add(wheelG);
  meshPart("steeringRing", new THREE.TorusGeometry(0.155, 0.017, 12, 30), new THREE.MeshStandardMaterial({ color: C.wheel, roughness: 0.55, metalness: 0.1 }), wheelG);
  meshPart("steeringHub", new THREE.CylinderGeometry(0.048, 0.048, 0.03, 18), new THREE.MeshStandardMaterial({ color: C.hub, roughness: 0.5, metalness: 0.15 }), wheelG);
  boxM("steeringSpokeL", -0.115, 0.012, 0, 0.09, 0.052, 0.045, C.hub, wheelG, { rz: -0.22 });
  boxM("steeringSpokeR", 0.115, 0.012, 0, 0.09, 0.052, 0.045, C.hub, wheelG, { rz: 0.22 });
  boxM("steeringSpokeLow", 0, -0.098, 0, 0.15, 0.045, 0.045, C.hub, wheelG, { rz: 0 });
  boxM("wheelBtnL", -0.115, 0.012, 0.012, 0.05, 0.028, 0.02, C.blackBtn, wheelG, { rz: -0.22 });
  boxM("wheelBtnR", 0.115, 0.012, 0.012, 0.05, 0.028, 0.02, C.blackBtn, wheelG, { rz: 0.22 });
  meshPart("wheelCrest", new THREE.CylinderGeometry(0.014, 0.014, 0.032, 12), new THREE.MeshStandardMaterial({ color: C.alu, roughness: 0.3, metalness: 0.9 }), wheelG);

  /* ---- digital instrument cluster (behind the wheel) ---- */
  var clusterG = tag(new THREE.Group(), "instrumentCluster");
  clusterG.position.set(-0.34, 0.80, 1.13);
  clusterG.rotation.set(-0.10, 0, 0);
  interior.add(clusterG);
  boxM("clusterPanel", 0, 0, 0, 0.34, 0.17, 0.045, C.cluster, clusterG);
  boxM("clusterGlass", 0, 0, 0.03, 0.30, 0.12, 0.012, glassMat, clusterG);

  /* ---- no ambient light strips — the fresh car stays powered off ---- */

  /* ---- GTS red accents — monochrome-first: colour reduced to a single thin
     hairline (the roofline pinstripe); the leftover red trims now read as
     charcoal/ivory seam + stitch so the cabin stays black · grey · off-white ---- */
  /* ivory contrast strip on the dash front edge, right under the windshield cowl */
  boxPart("dashRedStrip", 0, 0.685, 1.225, W - 0.12, 0.014, 0.02, C.ivory, interior);
  /* dark stitched seam along the top of each door panel, just under the beltline */
  boxPart("doorRedStitchL", -0.755, 0.77, 0.10, 0.011, 0.012, 1.50, C.threadDark, interior, { rz: 0.018 });
  boxPart("doorRedStitchR", 0.755, 0.77, 0.10, 0.011, 0.012, 1.50, C.threadDark, interior, { rz: -0.018 });
  /* charcoal beltline seam where the side glass meets the body shoulder */
  boxPart("beltlineSeamL", -0.832, 0.795, 0, 0.008, 0.014, 1.26, C.steel, interior);
  boxPart("beltlineSeamR", 0.832, 0.795, 0, 0.008, 0.014, 1.26, C.steel, interior);

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
  var fpMat = new THREE.LineDashedMaterial({ color: 0x66666c, transparent: true, opacity: 0.4, dashSize: 0.045, gapSize: 0.035 });
  var fpLines = new THREE.LineLoop(fp, fpMat);
  fpLines.computeLineDistances();
  tag(fpLines, "seatFootprintDashed");
  seatMount.add(fpLines);

  /* Ivory comfort seat — black/white read: off-white covers, charcoal bolsters,
     dark contrast stitching. seatRig sits at the mount and carries every live seat transform so S.rot / S.sl /
     height move this exact seat the agent will take; backRig adds recline. */
  var seatRig = tag(new THREE.Group(), "seatRig");
  seatMount.add(seatRig);
  boxPart("seatPlinth", 0, 0.03, 0, 0.60, 0.04, 0.52, C.steel, seatRig);
  boxPart("seatTrackRail", 0, 0.052, 0, 0.06, 0.022, 0.56, C.alu, seatRig);
  boxPart("seatSquab", 0, 0.19, 0, 0.58, 0.27, 0.54, C.ivory, seatRig);
  boxPart("seatCushion", 0, 0.26, 0.02, 0.40, 0.10, 0.46, C.ivory2, seatRig);
  boxPart("seatBolsterL", -0.205, 0.24, 0, 0.115, 0.25, 0.52, C.bolster, seatRig, { rz: 0.10 });
  boxPart("seatBolsterR", 0.205, 0.24, 0, 0.115, 0.25, 0.52, C.bolster, seatRig, { rz: -0.10 });
  boxPart("squabStitchF", 0, 0.312, -0.225, 0.38, 0.006, 0.007, C.threadDark, seatRig);
  boxPart("squabStitchB", 0, 0.312, 0.265, 0.38, 0.006, 0.007, C.threadDark, seatRig);
  /* black/white scuff piping around the ivory seat edges */
  boxPart("seatPipingF", 0, 0.28, -0.205, 0.38, 0.007, 0.007, C.threadDark, seatRig);
  boxPart("seatPipingRear", 0, 0.28, 0.245, 0.38, 0.007, 0.007, C.threadDark, seatRig);
  boxPart("seatPipingLeft", -0.19, 0.28, 0.02, 0.007, 0.007, 0.45, C.threadDark, seatRig);
  boxPart("seatPipingRight", 0.19, 0.28, 0.02, 0.007, 0.007, 0.45, C.threadDark, seatRig);
  /* seatback + headrest hang on a recline hinge at the squab's rear edge.
     backRig.rotation.x = seatback recline (10–40°, default 24°); the rest of the
     seat still rides live from S.rot / S.sl / height via __SEAT_LIVE__. */
  var RECLINE = { kind: "seatback", unit: "deg", min: 10, max: 40, default: 24 };
  var backRig = tag(new THREE.Group(), "backRig");
  backRig.position.set(0, 0.30, -0.25);
  seatRig.add(backRig);
  boxPart("seatBack", 0, 0.29, 0, 0.52, 0.56, 0.14, C.ivory2, backRig);
  boxPart("backWingL", -0.19, 0.30, -0.02, 0.115, 0.54, 0.15, C.bolster, backRig, { rz: -0.05 });
  boxPart("backWingR", 0.19, 0.30, -0.02, 0.115, 0.54, 0.15, C.bolster, backRig, { rz: 0.05 });
  boxPart("backSpineStitch", 0, 0.22, 0.08, 0.30, 0.50, 0.005, C.threadDark, backRig);
  boxPart("shoulderStitch", 0, 0.44, 0.08, 0.30, 0.006, 0.006, C.threadDark, backRig);
  boxPart("seatHead", 0, 0.66, -0.05, 0.34, 0.12, 0.10, C.ivory2, backRig);
  boxPart("headStitch", 0, 0.66, -0.012, 0.24, 0.006, 0.008, C.threadDark, backRig);
  var agentMount = tag(new THREE.Object3D(), "agentMount");
  agentMount.position.set(0, 0.86, 0.02);
  agentMount.userData.AGENT = true;
  seatRig.add(agentMount);
  state.SEAT = SEAT; state.seatMount = seatMount; state.agentMount = agentMount;
  state.seatRig = seatRig; state.backRig = backRig; state.RECLINE = RECLINE;

  var rcTrackEl = document.getElementById("rcTrack");
  var rcThumbEl = document.getElementById("rcThumb");
  var rcReadEl = document.getElementById("rcRead");
  state.reclineDeg = RECLINE.default;
  backRig.rotation.x = -THREE.MathUtils.degToRad(state.reclineDeg);
  if (rcThumbEl) rcThumbEl.style.left = ((state.reclineDeg - RECLINE.min) / (RECLINE.max - RECLINE.min) * 100) + "%";
  if (rcReadEl) rcReadEl.textContent = state.reclineDeg + "°";
  function setRecline(d) {
    d = Math.round(Math.max(RECLINE.min, Math.min(RECLINE.max, d)));
    if (d === state.reclineDeg) return;
    state.reclineDeg = d;
    backRig.rotation.x = -THREE.MathUtils.degToRad(d);
    if (rcReadEl) rcReadEl.textContent = d + "°";
    if (rcThumbEl) rcThumbEl.style.left = ((d - RECLINE.min) / (RECLINE.max - RECLINE.min) * 100) + "%";
  }
  if (rcTrackEl && rcThumbEl) {
    var rcDrag = false;
    function rcFrom(e) {
      var r = rcTrackEl.getBoundingClientRect();
      var x = (e.clientX - r.left) / (r.width || 1);
      return RECLINE.min + Math.max(0, Math.min(1, x)) * (RECLINE.max - RECLINE.min);
    }
    rcTrackEl.addEventListener("pointerdown", function (e) {
      rcDrag = true;
      if (rcTrackEl.setPointerCapture) rcTrackEl.setPointerCapture(e.pointerId);
      setRecline(rcFrom(e));
    });
    rcTrackEl.addEventListener("pointermove", function (e) { if (rcDrag) setRecline(rcFrom(e)); });
    rcTrackEl.addEventListener("pointerup", function () { rcDrag = false; });
    rcTrackEl.addEventListener("pointercancel", function () { rcDrag = false; });
  }

  var travel = new THREE.Vector3();
  var travelF = new THREE.Vector3(), travelR = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  var keyState = {};
  function isTyping() {
    var a = document.activeElement;
    return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
  }
  window.addEventListener("keydown", function (e) {
    var k = (e.key || "").toLowerCase();
    if (isTyping()) return;
    if (k === "[" || k === "]") { setRecline(state.reclineDeg + (k === "]" ? 5 : -5)); return; }
    if (k !== "w" && k !== "s" && k !== "q" && k !== "e") return;
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
  status("Empty black-and-white cabin drawn · " + PARTS.length + " parts · seat mounted & live");
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
      recline: {
        deg: state.reclineDeg,
        limits: { min: RECLINE.min, max: RECLINE.max },
        backRigRotX: backRig.rotation.x
      },
      cayenne: {
        interior: !!interior,
        palette: {
          body: "#" + J.body.toString(16).padStart(6, '0'),
          carpet: "#" + J.carpet.toString(16).padStart(6, '0'),
          headliner: "#" + J.headliner.toString(16).padStart(6, '0'),
          headBands: "#" + J.headBands.toString(16).padStart(6, '0'),
          leather: "#" + C.leather.toString(16).padStart(6, '0'),
          ivory: "#" + C.ivory.toString(16).padStart(6, '0'),
          stitch: "#" + C.stitch.toString(16).padStart(6, '0'),
          threadDark: "#" + C.threadDark.toString(16).padStart(6, '0'),
          steel: "#" + C.steel.toString(16).padStart(6, '0'),
          red: "#" + C.red.toString(16).padStart(6, '0'),
          alu: "#" + C.alu.toString(16).padStart(6, '0'),
          ambient: "off"
        },
        wheelPos: wheelG.position.toArray(),
        clusterPos: clusterG.position.toArray(),
        ambientCount: 0
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
