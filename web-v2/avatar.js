import * as THREE from "three";

const FLOOR_Y = 0.12;
const WALK_SPEED = 0.55;
const SEAT_DROP = 0.52;
const BREATHE = 0.008;
const HEADING_EASE = 4.5;

const WAYPOINTS = {
  driver: { x: -0.42, z: 0.55, face: 0 },
  passenger: { x: 0.42, z: 0.42, face: 90 },
  rear: { x: 0.34, z: -0.72, face: 180 },
  dash: { x: 0.06, z: 1.0, face: -18 }
};
const ORDER = ["passenger", "rear", "dash", "driver"];
const DWELL = { passenger: 2.8, rear: 2.8, dash: 3.6, driver: 2.2, sit: 13 };

const _ea = new THREE.Euler();
const _q = new THREE.Quaternion();

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function smooth(t) { return t * t * (3 - 2 * t); }
function damp(k, dt) { return 1 - Math.exp(-k * dt); }
function nrmDeg(d) { return ((d % 360) + 360) % 360; }
function quatHeading(deg) {
  return _q.setFromEuler(_ea.set(0, deg * Math.PI / 180, 0, "YXZ")).clone();
}
function yawDeg(q) {
  _ea.setFromQuaternion(q, "YXZ");
  return nrmDeg(_ea.y * 180 / Math.PI);
}

export function init(api) {
  if (!api || !api.scene || !api.seatRig || !api.agentMount) {
    throw new Error("avatar.init: api needs { scene, camera, seatRig, agentMount }");
  }
  if (api.__avatar) return api.__avatar;
  const scene = api.scene;
  const camera = api.camera;
  const seatRig = api.seatRig;
  const agentMount = api.agentMount;

  const fillMat = new THREE.MeshStandardMaterial({
    color: 0xf5f6f8, roughness: 0.94, metalness: 0
  });
  fillMat.envMapIntensity = 0.22;
  fillMat.polygonOffset = true;
  fillMat.polygonOffsetFactor = -1.5;
  fillMat.polygonOffsetUnits = -2;
  const dark = fillMat.clone(); dark.color.setHex(0x262d39);
  const gold = fillMat.clone(); gold.color.setHex(0xc9a227);
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x0a0c10 });

  function solid(parent, name, geo, mat) {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    parent.add(m);
    const ln = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), edgeMat);
    ln.name = name + "-edge";
    parent.add(ln);
    return m;
  }
  function box(parent, name, w, h, d, cx, cy, cz, mat) {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(cx, cy, cz);
    return solid(parent, name, geo, mat);
  }
  function ball(parent, name, r, cx, cy, cz, mat) {
    const geo = new THREE.SphereGeometry(r, 10, 8);
    geo.translate(cx, cy, cz);
    return solid(parent, name, geo, mat);
  }

  const root = new THREE.Group();
  root.name = "avatarRoot";
  scene.add(root);
  const body = new THREE.Group();
  body.name = "avatarBody";
  root.add(body);

  box(body, "legL", 0.055, 0.155, 0.055, -0.034, 0.085, 0.012, fillMat);
  box(body, "legR", 0.055, 0.155, 0.055, 0.034, 0.085, 0.012, fillMat);
  box(body, "footL", 0.052, 0.03, 0.085, -0.034, 0.015, 0.03, dark);
  box(body, "footR", 0.052, 0.03, 0.085, 0.034, 0.015, 0.03, dark);
  box(body, "torso", 0.155, 0.165, 0.09, 0, 0.245, 0, fillMat);
  box(body, "sash", 0.085, 0.014, 0.006, 0, 0.3, 0.0475, gold);
  const armL = box(body, "armL", 0.034, 0.14, 0.034, -0.096, 0.245, 0.014, fillMat);
  const armR = box(body, "armR", 0.034, 0.14, 0.034, 0.096, 0.245, 0.014, fillMat);
  armL.rotation.z = 0.09;
  armR.rotation.z = -0.09;
  ball(body, "handL", 0.028, -0.102, 0.172, 0.026, dark);
  ball(body, "handR", 0.028, 0.102, 0.172, 0.026, dark);
  box(body, "neck", 0.03, 0.02, 0.03, 0, 0.335, 0, fillMat);
  ball(body, "head", 0.055, 0, 0.375, 0, fillMat);
  ball(body, "eyeL", 0.01, -0.022, 0.378, 0.048, dark);
  ball(body, "eyeR", 0.01, 0.022, 0.378, 0.048, dark);
  box(body, "mouth", 0.028, 0.004, 0.004, 0, 0.36, 0.0495, dark);
  box(body, "cap", 0.088, 0.024, 0.088, 0, 0.406, 0, dark);

  const state = {
    mode: "seated",
    leg: null,
    dwell: null,
    atWp: "driver",
    headingDeg: 0,
    stride: 0
  };
  const tasks = [];

  function now() { return performance.now() / 1000; }
  function later(sec, fn) { tasks.push({ at: now() + sec, run: fn }); }

  const seatAnchor = new THREE.Vector3();
  const seatQuat = new THREE.Quaternion();

  function readSeat() {
    agentMount.getWorldPosition(seatAnchor);
    seatAnchor.y -= SEAT_DROP;
    seatRig.getWorldQuaternion(seatQuat);
  }

  function walkTo(wp) {
    const t = typeof wp === "string" ? WAYPOINTS[wp] : null;
    if (!t) throw new Error("avatar.walkTo: unknown waypoint '" + wp + "'");
    state.atWp = wp;
    state.leg = {
      x0: root.position.x, z0: root.position.z,
      x1: t.x, z1: t.z,
      face: t.face,
      t0: now(),
      dur: Math.max(0.45, Math.min(6, Math.hypot(t.x - root.position.x, t.z - root.position.z) / WALK_SPEED))
    };
    state.mode = "walk";
  }

  function sit() {
    state.mode = "seated";
    state.leg = null;
    state.atWp = "driver";
  }

  const pos = new THREE.Vector3();
  const target = new THREE.Vector3();
  const tquat = new THREE.Quaternion();

  function update(dt, t) {
    for (let i = tasks.length - 1; i >= 0; i--) {
      if (t >= tasks[i].at) { const run = tasks[i].run; tasks.splice(i, 1); run(); }
    }

    let tx, tz, ty, tq;
    let striding = 0;

    if (state.mode === "seated") {
      readSeat();
      tx = seatAnchor.x; ty = seatAnchor.y; tz = seatAnchor.z;
      tq = seatQuat;
    } else if (state.leg) {
      const p = clamp01((t - state.leg.t0) / state.leg.dur);
      const e = smooth(p);
      tx = state.leg.x0 + (state.leg.x1 - state.leg.x0) * e;
      tz = state.leg.z0 + (state.leg.z1 - state.leg.z0) * e;
      ty = FLOOR_Y;
      const came = e > 0.65 || p >= 1;
      striding = state.leg.dur > 0 ? (p >= 1 ? 0 : p < 0.1 ? e * 2 : 1) : 0;
      let head = Math.atan2(state.leg.x1 - state.leg.x0, state.leg.z1 - state.leg.z0) * 180 / Math.PI;
      if (came) head = state.leg.face;
      tq = quatHeading(head);
      state.headingDeg = head;
      if (p >= 1) {
        state.leg = null;
        const at = state.atWp;
        state.dwell = at;
        root.position.x = tx;
        root.position.z = tz;
        const d = DWELL[at] !== undefined ? DWELL[at] : 2.5;
        if (at === "driver") later(d, () => { sit(); later(DWELL.sit, next); });
        else later(d, next);
        striding = 0;
      }
    } else {
      const a = state.dwell ? WAYPOINTS[state.dwell] : WAYPOINTS.driver;
      tx = root.position.x; tz = root.position.z; ty = FLOOR_Y;
      tq = quatHeading(a.face);
      state.headingDeg = a.face;
    }

    if (state.mode === "walk" && state.leg) {
      const k = damp(5.5, dt);
      target.set(tx, ty, tz);
      pos.copy(root.position);
      pos.x += (target.x - pos.x) * k;
      pos.z += (target.z - pos.z) * k;
      pos.y += (ty - pos.y) * damp(7, dt);
      root.position.copy(pos);
      state.stride = striding;
    } else {
      const k = damp(4.5, dt);
      target.set(tx, ty, tz);
      pos.copy(root.position);
      pos.x += (target.x - pos.x) * k;
      pos.z += (target.z - pos.z) * k;
      pos.y += (ty - pos.y) * k;
      root.position.copy(pos);
      state.stride = 0;
    }

    root.quaternion.slerp(tq, damp(HEADING_EASE, dt));

    const breathe = Math.sin(t * 2.1) * BREATHE;
    const hop = state.mode === "walk" && state.leg
      ? Math.sin(t * 9.2) * 0.016 * state.stride
      : (state.mode === "walk" ? Math.sin(t * 9.2) * 0.012 * state.stride : 0);
    body.position.y = breathe + hop;
    if (state.mode === "walk") {
      body.rotation.z = Math.sin(t * 9.2) * 0.05 * state.stride;
    } else {
      body.rotation.z *= damp(3, dt);
      body.rotation.x = -0.12;
    }
  }

  function next() {
    const wp = ORDER[state.idx % ORDER.length];
    state.idx = (state.idx + 1) % ORDER.length;
    walkTo(wp);
  }

  function getAvatarPose() {
    root.updateWorldMatrix(true, false);
    const w = root.getWorldPosition(new THREE.Vector3());
    const wq = root.getWorldQuaternion(new THREE.Quaternion());
    return {
      t: now(),
      state: state.mode,
      world: { x: w.x, y: w.y, z: w.z },
      headingDeg: yawDeg(wq),
      atWaypoint: state.atWp,
      seatRel: state.mode === "seated" ? { x: 0, y: 0.34, z: 0.02 } : null,
      target: state.leg ? { x: state.leg.x1, z: state.leg.z1 } : null,
      speed: state.mode === "walk" && state.leg ? WALK_SPEED : 0,
      seam: { drop: SEAT_DROP, floorY: FLOOR_Y }
    };
  }

  root.position.set(agentMount.position.x, agentMount.position.y - SEAT_DROP + 0.12, agentMount.position.z);

  state.idx = 0;
  later(5, next);
  let last = now();
  (function loop(now2) {
    requestAnimationFrame(loop);
    const dt = Math.min((now2 - last) / 1000, 0.05);
    last = now2;
    update(dt, now2 / 1000);
  })(last);

  const api2 = { sit: sit, walkTo: walkTo, getAvatarPose: getAvatarPose, waypoints: WAYPOINTS };
  api.__avatar = api2;
  return api2;
}