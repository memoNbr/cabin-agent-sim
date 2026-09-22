(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  /* ================= reference data (thesis) ================= */
  var ROT = [[0,1.0],[30,0.5],[60,0.1429],[90,0.4286],[120,0.2143],[150,0.4286],[180,0.6071],[210,0.4286],[240,0.5333],[270,0.6],[300,0.2857],[330,0.8462],[360,1.0]];
  var HGT = [[38,0.4545],[40,0.2955],[42,0.1818],[44,0.04545],[46,0.02273]];

  function rate(tbl, x) {
    var f = tbl[0], l = tbl[tbl.length - 1];
    if (x <= f[0]) return f[1];
    if (x >= l[0]) return l[1];
    for (var i = 0; i < tbl.length - 1; i++) {
      var a = tbl[i], b = tbl[i + 1];
      if (x >= a[0] && x <= b[0]) {
        return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
      }
    }
    return f[1];
  }

  /* ================= persona ================= */
  var PHILL = {
    name: "Phill", targetRot: 0, targetHgt: 44,
    tolRot: 20, tolHgt: 2,
    talkativeness: 0.55, suspicionBase: 0.5, memoryLambda: 0.004,
    assertiveness: 0.6,        /* how strongly his own comfort pulls on the seat */
    settleThresh: 0.22,        /* fit-gap at which he starts to self-settle     */
    settleStep: 1              /* cm / ° steps while adjusting himself          */
  };

  /* ================= ride script (sim seconds) ================= */
  var RIDE_START = 120, RIDE_END = 600;
  var EVENTS = [
    { t: 121, kind: "depart",     g: 0.15, jolt: 0.0, spd: 60,  label: "Departing — auto-pilot engaged" },
    { t: 158, kind: "merge",      g: 0.20, jolt: 0.0, spd: 105, label: "Merging onto the motorway" },
    { t: 200, kind: "curve",      g: 0.38, jolt: 0.0, spd: 115, label: "Long left-hand curve" },
    { t: 258, kind: "bump",       g: 0.10, jolt: 0.55, spd: 92, label: "Pothole · thump!" },
    { t: 292, kind: "overtake",   g: 0.45, jolt: 0.25, spd: 135, label: "Overtaking a truck" },
    { t: 340, kind: "smooth",     g: 0.08, jolt: 0.0, spd: 120, label: "Cruising steadily" },
    { t: 386, kind: "curve",      g: 0.32, jolt: 0.0, spd: 112, label: "Right-hand curve" },
    { t: 425, kind: "brake",      g: 0.25, jolt: 0.18, spd: 40, label: "Traffic ahead — slowing" },
    { t: 470, kind: "workzone",   g: 0.12, jolt: 0.22, spd: 70, label: "Roadworks · rumble strip" },
    { t: 520, kind: "smooth",     g: 0.06, jolt: 0.0, spd: 128, label: "Clear road again" },
    { t: 550, kind: "rain",       g: 0.14, jolt: 0.10, spd: 105, label: "Light rain on the glass" },
    { t: 575, kind: "brake",      g: 0.20, jolt: 0.10, spd: 30, label: "Slowing for the destination" },
    { t: 590, kind: "arrive",     g: 0.05, jolt: 0.0, spd: 0,   label: "Arrived — parked" }
  ];

  /* ================= language (Phill, English, dry) ================= */
  var THOUGHTS = {
    bump:     ["That was a proper thump.", "The road's had better days.", "It handled that. Fine, so far."],
    curve:    ["Laying over into this one.", "It holds its line on the bends.", "Round it goes, no fuss."],
    overtake: ["Big truck beside us, gone past.", "Wash of air as it rushed by.", "It overtook without a wobble."],
    brake:    ["Whoa, slowing for something up ahead.", "Traffic's stacking up again.", "Braking by itself now."],
    smooth:   ["Nice and quiet when it just cruises.", "No steering wheel and I don't miss it. Yet.", "Smooth stretch. Easy."],
    workzone: ["Rumble strip. Bump bump bump.", "Roadworks again, it's taking them slow.", "That strip rattles the spine on purpose."],
    rain:     ["Starting to spit on the glass.", "Wipers on, steady.", "Rain. It's handling it."],
    arrive:   ["There we are, parked up.", "Made it. Right on time, it seems."],
    depart:   ["Here we go.", "It's driving itself out.", "Off we go then."],
    merge:    ["Gliding onto the motorway on its own.", "No drama joining the traffic."],
    seatLow:  ["Sits a bit low, this. Can't see much bonnet.", "Lowering again. My legs are bunching."],
    seatGood: ["That's more like it.", "Better height. I can see over the dash now.", "Yes, this is the position."],
    rotFwd:   ["Facing forward. Normal driving.", "Back to the road ahead."],
    rotSide:  ["Now I'm looking out the side.", "Sideways view. Neighbourhood rolling past."],
    rotCabin: ["Turned round to face the cabin.", "Odd, but the view backwards is clear."],
    rotOther: ["A bit turned from the road.", "Tilted off true, that."],
    idleC:    ["Not bad, honestly.", "I could get used to this.", "It rides smoothly at least.", "Plenty of room now."],
    idleS:    ["It decides things before I've even looked.", "Right… it moves by itself. Taking my time.", "No wheel. Of course."],
    idleN:    ["Weekend commute.", "Home in about an hour, probably.", "Hope the week stays quiet.", "A bit of quiet before the week starts."],
    settle:   ["Let me settle that properly.", "There — a seat to sit tall in.", "Give it a nudge, that's it."],
    request:  ["I'd sit a touch taller, if it's being adjusted anyway.", "A little more upright and I'm comfortable.", "Could it raise me an inch? I build my own height in."],
    trustOk:  ["The car earns trust, mile by mile.", "It reads the road and I read it back. Alright.", "Starting to relax into this."],
    trustLow: ["I'm not sure it sees everything.", "The more it twitches, the less I trust it.", "It handles things, but I stay awake."],
    settleLow:["Lower again. Maybe I came back wrong.", "I keep wanting to sit up straighter."],
    chat:     ["Someone's asking me things again.", "Experimenter on the line — I'll answer straight.", "That question's still sitting with me."],
    trustMid: ["It's done right so far, mostly.", "Cautious is the sensible way to ride.", "Ask me again when we park."],
    endGood:  ["I'd take another ride.", "That's a keeper, honestly."],
    endMid:   ["Mostly fine. A few minutes were iffy.", "Decent enough ride."],
    endBad:   ["I'd rather drive myself next time.", "Got out a little wary."]
  };
  function pick(arr, exclude) {
    var c = arr.filter(function (s) { return s !== exclude; });
    return c[Math.floor(Math.random() * c.length)];
  }

  /* ================= state ================= */
  var S = {
    rot: 0, hgt: 38, sl: 0,
    t: 0, running: true, timeScale: 4,
    phase: "setup", done: false,
    speed: 0, targetSpeed: 0, gNow: 0, joltNow: 0,
    rain: 0,
    mood: { comfort: 0.4, energy: 0.6, suspicion: 0.5 },
    memory: [], forgot: [], forgotCount: 0,
    thoughts: [], speech: "", lastModule: "",
    nextSpeak: 14, lastThink: 0,
    samples: [], log: [],
    belief: { fitGap: 0, fitRot: 0, fitHgt: 0, userHands: false },
    bdi: { intention: null, since: 0, last: {} },
    trust: { score: 0.5, items: {}, trail: [] },
    priors: null,
    selfAct: 0
  };
  var fired = {};
  var lastSampleT = -1;
  var lastRot = 0, rotChanged = false;
  var lastUserInput = -99;   /* sim-time of the last dial/rail grab */

  function logLine(kind, text) {
    var t = fmtTime(S.t);
    S.log.unshift({ t: t, kind: kind, text: text });
    if (S.log.length > 60) S.log.pop();
    renderLog();
  }
  function fmtTime(t) {
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return (m < 10 ? "0" + m : m) + ":" + (s < 10 ? "0" + s : s);
  }

  /* ================= mood ================= */
  function seatFit() {
    var dr = Math.min(1, Math.abs(S.rot - PHILL.targetRot) / 180);
    var dh = Math.min(1, Math.abs(S.hgt - PHILL.targetHgt) / 8);
    return { rot: 1 - dr, hgt: 1 - dh, overall: 1 - (dr + dh) / 2 };
  }
  function comfortTarget() {
    var aR = rate(ROT, S.rot), aH = rate(HGT, S.hgt), f = seatFit().overall;
    return Math.max(0, Math.min(1, 0.35 * aR + 0.35 * aH + 0.30 * f));
  }
  function setModule(m) {
    S.lastModule = m;
    document.querySelectorAll(".mod").forEach(function (el) {
      el.classList.toggle("on", el.getAttribute("data-m") === m);
    });
  }

  /* ================= cognition ================= */
  function remember(id, label, salience, important) {
    var act = salience + (important ? 0.1 : 0);
    S.memory.push({ id: id, label: label, salience: salience, act: Math.min(1, act), born: S.t, rehearsed: 0 });
    setModule("memorize");
    if (S.memory.length > 8) S.memory.splice(0, S.memory.length - 8);
  }
  function decayMemory(dt) {
    var dead = [];
    S.memory.forEach(function (m, i) {
      m.act *= Math.exp(-PHILL.memoryLambda * dt);
      if (m.act < 0.09) dead.push(i);
    });
    dead.sort(function (a, b) { return b - a; });
    dead.forEach(function (i) {
      var m = S.memory.splice(i, 1)[0];
      if (S.forgot.length > 5) S.forgot.shift();
      S.forgot.push({ label: m.label, age: Math.round(S.t - m.born) });
      S.forgotCount++;
      setModule("forget");
    });
  }
  function pickMemory() {
    if (!S.memory.length) return null;
    return S.memory.reduce(function (a, b) { return (b.act > a.act ? b : a); });
  }
  function think(inPhrase) {
    var m = pickMemory();
    var phrase = inPhrase || null;
    if (!phrase) {
      if (rotChanged) {
        var sec = viewSector();
        phrase = pick(THOUGHTS[sec === "FORWARD" ? "rotFwd" : sec === "CABIN" ? "rotCabin" : "rotSide"]);
        rotChanged = false;
      } else if (m) {
        phrase = pick(THOUGHTS[m.id]);
        m.rehearsed++;
        m.act = Math.min(1, m.act + 0.22);
      }
    }
    if (!phrase) phrase = pick(THOUGHTS[ambientMood()]);
    S.thoughts.unshift({ time: fmtTime(S.t), text: phrase });
    if (S.thoughts.length > 3) S.thoughts.pop();
    setModule("think");
    renderThoughts();
    return phrase;
  }
  function ambientMood() {
    if (S.mood.suspicion > 0.6) return "idleS";
    if (S.mood.comfort > 0.55) return "idleC";
    return "idleN";
  }
  function maybeSpeak(text) {
    var freq = PHILL.talkativeness * (0.4 +
      (S.mood.suspicion > 0.62 ? 0.3 : 0) + (S.mood.comfort < 0.35 ? 0.25 : 0));
    var r = Math.random();
    if (r < freq) {
      speak(text);
    }
  }
  function speak(text, force) {
    S.speech = text;
    S.lastModule = "speak";
    setModule("speak");
    var sp = $("speech");
    $("speechTxt").textContent = text;
    sp.classList.remove("pulse");
    void sp.offsetWidth;
    sp.classList.add("pulse");
    logLine("say", "“" + text + "”");
  }
  function eventSpeak(text) { speak(text, true); }

  /* ================= BDI reasoning (mind-owned) ================= */
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function angDist(a, b) { return Math.abs((((a - b) % 360) + 540) % 360 - 180); }

  /* beliefs: the fit between the cabin his body tells him and the seat's real state */
  function perceiveFit() {
    var f = seatFit();
    S.belief.fitRot = 1 - f.rot;
    S.belief.fitHgt = 1 - f.hgt;
    S.belief.fitGap = 1 - f.overall;
    S.belief.userHands = (S.t - lastUserInput) < 3;
  }

  /* a live latent construct: how much he trusts the machine car right now */
  function trustValue() {
    var s = 1 - S.mood.suspicion;
    var ev = clamp01(1 - S.joltNow / 0.6);
    return clamp01(0.34 * S.mood.comfort + 0.40 * s + 0.16 * ev + 0.10 * (1 - S.belief.fitGap));
  }

  /* desires → intentions. each goal: strength of desire, precondition, cooldown */
  var BDI_GOALS = {
    settle: {
      label: "settle the seat",
      desire: function () {
        var g = S.belief.fitGap;
        if (g < 0.18) return 0;
        var ph = S.phase === "setup" ? 1.3 : 0.9;
        return Math.min(2, ph * g * (S.belief.userHands ? 0.15 : 1));
      },
      pre: function () { return S.belief.fitGap >= PHILL.settleThresh && !S.belief.userHands; },
      cd: 9
    },
    attend: {
      label: "attend to the road",
      desire: function () {
        var m = pickMemory();
        return (m ? 0.3 + m.act * 0.7 : 0.15) + (S.mood.suspicion > 0.6 ? 0.4 : 0);
      },
      pre: function () { return true; },
      cd: 3.2
    },
    calibrate: {
      label: "calibrate trust in the cabin",
      desire: function () {
        if (S.phase !== "ride") return 0;
        var k = (S.mood.suspicion > 0.62 || S.belief.fitGap > 0.35) ? 0.85 : 0.5;
        return 0.35 + Math.min(0.6, (S.t - RIDE_START) / (RIDE_END - RIDE_START)) * k;
      },
      pre: function () { return S.phase === "ride"; },
      cd: 10
    }
  };

  /* action: pull his own seat toward where his body says it goes */
  function selfAdjust() {
    var changed = false;
    if (S.belief.fitHgt > 0.22 && S.hgt < PHILL.targetHgt) {
      S.hgt = Math.max(38, Math.min(46, S.hgt + PHILL.settleStep));
      changed = true;
    } else if (S.belief.fitHgt > 0.22 && S.hgt > PHILL.targetHgt) {
      S.hgt = Math.max(38, Math.min(46, S.hgt - PHILL.settleStep));
      changed = true;
    }
    if (S.belief.fitRot > 0.22) {
      var dRot = angDist(S.rot, PHILL.targetRot);
      if (dRot > PHILL.tolRot + 2) {
        var dir = ((PHILL.targetRot - S.rot + 540) % 360) - 180;
        S.rot = Math.round((((S.rot + (dir > 0 ? 10 : -10)) % 360) + 360) % 360);
        rotChanged = true;
        changed = true;
      }
    }
    if (changed) {
      S.selfAct++;
      logLine("adj", "self-settle → " + (((S.rot % 360) + 360) % 360) + "° / " + S.hgt + " cm");
      renderAll();
    }
    return changed;
  }

  function bdiActSettle() {
    if (selfAdjust()) {
      if (S.selfAct % 2 === 0) speak(pick(THOUGHTS.settle), true);
      else think(pick(THOUGHTS.settle));
    } else {
      think(pick(THOUGHTS.settleLow));
      setModule("intend");
    }
  }
  function bdiActAttend() {
    var phrase = think();
    maybeSpeak(phrase);
  }
  function bdiActCalibrate() {
    var tw = trustValue();
    if (tw >= 0.6) think(pick(THOUGHTS.trustOk));
    else if (tw <= 0.38) { var ln = pick(THOUGHTS.trustLow); think(ln); maybeSpeak(ln); }
    else setModule("intend");
  }

  /* the reasoning loop: perceive beliefs, grow desires, fire the best intention */
  function bdiReason(dt) {
    perceiveFit();

    /* fit-gap persistence erodes trust: the cabin ignores his body's preferred sitting */
    var gb = S.belief.fitGap > 0.3 ? (S.belief.fitGap - 0.3) * 2.4 : 0;
    if (gb > 0) {
      S.mood.suspicion = Math.min(1, S.mood.suspicion + dt * 0.006 * gb * (S.belief.userHands ? 1.6 : 1));
    }

    var best = null, bestV = 0;
    Object.keys(BDI_GOALS).forEach(function (k) {
      var go = BDI_GOALS[k];
      if (S.t - (S.bdi.last[k] || -99) < go.cd) return;
      if (!go.pre()) return;
      var v = go.desire();
      if (v > 0 && v > bestV) { best = k; bestV = v; }
    });

    if (best) {
      S.bdi.intention = best;
      S.bdi.since = S.t;
      S.bdi.last[best] = S.t;
    } else {
      S.bdi.intention = null;
    }

    if (best === "settle") bdiActSettle();
    else if (best === "attend") bdiActAttend();
    else if (best === "calibrate") bdiActCalibrate();
  }

  /* ================= experimenter chat (mind-owned) =================
     window.__EXPERIMENTER_CHAT__ — a two-way bridge so an experimenter can
     talk to Phill mid-ride and read the state his answers come from.
     Inbound lines are encoded into memory like any other perception, so a
     later recall can resurface them; replies are picked from the CURRENT
     fit / mood / trust values, never from a fixed script. */
  var chatHist = [];
  function chatReply(text) {
    var q = String(text).toLowerCase(), tw = trustValue();
    /* seat talk → he answers from his body's fit, and clears the settle
       cooldown so the BDI loop can act on the request straight away */
    if (/(seat|height|tall|lower|raise|rotate|rotation|adjust|settle)/.test(q)) {
      if (S.belief.fitGap >= PHILL.settleThresh) {
        S.bdi.last.settle = -99;
        return pick(THOUGHTS.request);
      }
      return pick(THOUGHTS.seatGood);
    }
    /* trust talk → answered from the live latent trust value */
    if (/(trust|safe|confidence|rely|sure)/.test(q)) {
      if (tw >= 0.6) return pick(THOUGHTS.trustOk);
      if (tw <= 0.38) return pick(THOUGHTS.trustLow);
      return pick(THOUGHTS.trustMid);
    }
    /* wellbeing talk → answered from the current ambient mood */
    if (/(feel|how|you|ok|okay|alright|comfort|fine|doing)/.test(q)) return pick(THOUGHTS[ambientMood()]);
    return pick(THOUGHTS.idleN);
  }
  function experimenterState() {
    var top = pickMemory();
    return {
      t: S.t, phase: S.phase, done: S.done,
      mood: { comfort: S.mood.comfort, energy: S.mood.energy, suspicion: S.mood.suspicion },
      trust: trustValue(), trustScore: S.trust.score,
      belief: { fitGap: S.belief.fitGap, fitRot: S.belief.fitRot, fitHgt: S.belief.fitHgt, userHands: S.belief.userHands },
      intention: S.bdi.intention, since: S.bdi.since,
      seat: { rot: S.rot, hgt: S.hgt, sl: S.sl },
      memory: { count: S.memory.length, top: top ? top.label : null, forgot: S.forgotCount },
      ride: { speed: S.speed, g: S.gNow, jolt: S.joltNow }
    };
  }
  function experimenterSend(raw) {
    var text = String(raw == null ? "" : raw).trim();
    if (!text) return { ok: false, error: "empty message" };
    chatHist.push({ who: "experimenter", t: S.t, text: text });
    logLine("chat", "experimenter · " + text);
    remember("chat", "Experimenter: " + text, 0.5, true);
    var reply = chatReply(text);
    chatHist.push({ who: "phill", t: S.t, text: reply });
    if (chatHist.length > 40) chatHist.splice(0, chatHist.length - 40);
    speak(reply, true);
    return { ok: true, reply: reply, state: experimenterState() };
  }
  window.__EXPERIMENTER_CHAT__ = {
    send: experimenterSend,                            /* send("…") → { ok, reply, state } */
    history: function () { return chatHist.slice(0); }, /* [{ who, t, text }] oldest first  */
    state: experimenterState,                          /* live mood / trust / BDI snapshot */
    clear: function () { chatHist.length = 0; return true; }
  };

  /* ================= trust questionnaire (privacy-guarded) ================= */
  var TRUST_ITEMS = [
    { id: "q1", txt: "I would trust this cabin for another ride." },
    { id: "q2", txt: "I felt safe while it drove." },
    { id: "q3", txt: "The seating and cabin suited me." },
    { id: "q4", txt: "I stayed aware — it earned that attention." },
    { id: "q5", txt: "Overall, it makes trustworthy decisions." }
  ];
  function evidenceAnswers() {
    var t = trustValue(), f = seatFit();
    return {
      q1: 1 + Math.round(clamp01(0.5 * t + 0.5 * S.mood.comfort) * 4),
      q2: 1 + Math.round(clamp01(0.55 * (1 - S.mood.suspicion) + 0.45 * t) * 4),
      q3: 1 + Math.round(clamp01(0.4 * f.overall + 0.6 * S.mood.comfort) * 4),
      q4: 1 + Math.round(clamp01(0.5 * S.mood.energy + 0.5 * (1 - S.mood.suspicion)) * 4),
      q5: 1 + Math.round(clamp01(t) * 4)
    };
  }
  function finalRemark() {
    if (S.trust.score >= 0.65) return pick(THOUGHTS.endGood);
    if (S.trust.score >= 0.45) return pick(THOUGHTS.endMid);
    return pick(THOUGHTS.endBad);
  }
  /* optional LLM commentary: mirrors the existing window.lavish queue pattern.
     No keys are stored or sent; the prompt carries only aggregate ride telemetry.
     If no LLM hook is configured, the canned remark stands. */
  function llmCommentary(text, context) {
    if (typeof window.lavish !== "undefined" && window.lavish.queuePrompt && window.lavish.sendQueuedPrompts) {
      try {
        window.lavish.queuePrompt("Cabin agent Phill (" + context + ") — “" + text +
          "” | ride telemetry only: comfort " + S.mood.comfort.toFixed(2) + ", suspicion " +
          S.mood.suspicion.toFixed(2) + ", trust " + S.trust.score.toFixed(2) + " — no personal data.");
        window.lavish.sendQueuedPrompts();
      } catch (e) { /* canned fallback stands */ }
    }
    return text;
  }
  function submitTrust() {
    var vals = TRUST_ITEMS.map(function (it) { return S.trust.items[it.id] || 3; });
    S.trust.score = clamp01(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length / 5);
    var remark = llmCommentary(finalRemark(), "end-of-ride");
    var avgT = S.trust.trail.length ? S.trust.trail[S.trust.trail.length - 1].v : S.trust.score;
    var tq = $("tqScore"), tn = $("tqNote");
    if (tq) tq.textContent = "trust " + (S.trust.score * 100).toFixed(0) + "/100 · ride trend " + (avgT * 100).toFixed(0);
    if (tn) tn.textContent = (S.trust.score >= 0.65 ? "Phill trusts this cabin." : S.trust.score >= 0.45 ? "Cautious, but willing." : "He got out wary.") + " “" + remark + "”";
  }
  function renderTrustItems() {
    S.trust.items = evidenceAnswers();
    var el = $("tqItems");
    if (!el) return;
    el.innerHTML = TRUST_ITEMS.map(function (it) {
      return '<div style="margin:8px 0;"><span style="font-size:12.5px; color:#C7C2B4;">' + it.txt + "</span>" +
        '<input type="range" min="1" max="5" step="1" value="' + (S.trust.items[it.id] || 3) + '" id="tq_' + it.id +
        '" style="width:100%; accent-color:#C9A227; margin-top:4px;" aria-label="' + it.txt +
        '"> <span class="tqlabel" style="font-size:10px; color:#8A8578;">1–5</span></div>';
    }).join("");
    TRUST_ITEMS.forEach(function (it) {
      var el2 = document.getElementById("tq_" + it.id);
      if (el2) el2.addEventListener("input", function (e) {
        S.trust.items[it.id] = Math.max(1, Math.min(5, +e.target.value || 3));
      });
    });
  }
  function openTrustQ() {
    renderTrustItems();
    var q = $("trustQ");
    if (q) q.style.display = "flex";
  }
  /* priors persist only as aggregated scores for the NEXT ride's baseline —
     no personal data, no locations, no identities. Memory: localStorage. */
  function ridePriors(avgC, avgS) {
    var p = S.priors || { rides: 0 };
    S.priors = { rides: (p.rides || 0) + 1, trust: S.trust.score, comfort: avgC, suspicion: avgS };
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem("cabinSimPriors", JSON.stringify(S.priors));
    } catch (e) { /* storage unavailable — in-memory priors only */ }
  }
  function loadPriors() {
    try {
      if (typeof localStorage !== "undefined") {
        var raw = localStorage.getItem("cabinSimPriors");
        if (raw) S.priors = JSON.parse(raw);
      }
    } catch (e) { S.priors = null; }
    if (S.priors && typeof S.priors.trust === "number") {
      PHILL.suspicionBase = clamp01(0.5 + (0.5 - S.priors.trust) * 0.35);
    }
  }

  /* ================= event firing ================= */
  function perceive(ev) {
    var impact = Math.max(ev.g, ev.jolt);
    var salience = Math.max(0.35, 0.42 + impact * 0.5);
    var important = (ev.kind === "bump" || ev.kind === "arrive" || ev.kind === "workzone");
    remember(ev.kind, ev.label, salience, important);
    S.speed = ev.spd; S.targetSpeed = ev.spd; S.gNow = ev.g; S.joltNow = ev.jolt;

    if (ev.jolt > 0.3) {
      S.mood.suspicion = Math.min(1, S.mood.suspicion + 0.20);
      S.mood.comfort = Math.max(0, S.mood.comfort - ev.jolt * 0.12);
    }
    if (ev.kind === "brake") S.mood.suspicion = Math.min(1, S.mood.suspicion + 0.07);
    if (ev.kind === "overtake") S.mood.suspicion = Math.min(1, S.mood.suspicion + 0.05);
    if (ev.kind === "rain") S.mood.suspicion = Math.min(1, S.mood.suspicion + 0.04);

    banner(ev.label, (ev.jolt > 0.3 ? "jolt" : ev.g > 0.25 ? "" : ""));
    if (ev.jolt > 0.3 && !fired[ev.kind + ev.t]) shakeScene();
    if (ev.jolt > 0.2 || (ev.g > 0.25 && Math.random() < 0.5)) {
      eventSpeak(pick(THOUGHTS[ev.kind]));
    }
    logLine("evt", ev.label + "  (" + (ev.spd || 0) + " km/h)");
    setModule("perceive");
    renderMemory(); renderSceneFx();
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
    // ride inertia: curves lean into the corner, braking dives, jolts rattle
    var l = ((S.rot % 360) + 360) % 360;
    var side = Math.sin((l - 20) * Math.PI / 180);
    var sK = swayK || 0;
    var crv = Math.max(0, S.gNow - 0.22) * 8.5 * (side >= 0 ? 1 : -1) * sK;
    var dv = (S.speed < 55 && S.targetSpeed < S.speed) ? (55 - S.speed) / 55 * 4.0 * sK : 0;
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

  function seatSlide() {
    return S.sl;
  }
  function addSeat() {
    var H = S.hgt, cb = H - 11, yaw = ((S.rot % 360) + 360) % 360;
    var sl = S.sl, SX = SEATX;
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
    var cR = [L(SX - 17, cb, sl - 12), L(SX + 17, cb, sl - 12), L(SX + 17, H, sl - 12), L(SX - 17, H, sl - 12)];
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
    var bLS = [L(SX - 15, H, sl - 12), L(SX - 15, H, sl - 21), L(SX - 15, H + bkY, sl - 21 - bkZ), L(SX - 15, H + bkY, sl - 12 - bkZ)];
    var bRS = [L(SX + 15, H, sl - 12), L(SX + 15, H, sl - 21), L(SX + 15, H + bkY, sl - 21 - bkZ), L(SX + 15, H + bkY, sl - 12 - bkZ)];
    pushP(bLS, shade("#1a2030", faceN(bLS[0], bLS[1], bLS[2])), null);
    pushP(bRS, shade("#202738", faceN(bRS[0], bRS[1], bRS[2])), null);
    pushCap(L(SX - 14, H + bkY - 6, sl - 12 - bkZ), L(SX + 14, H + bkY - 6, sl - 12 - bkZ), 0.8, "rgba(230,200,90,.4)", null);
    var hrF = [L(SX - 9, H + bkY, sl - 33), L(SX + 9, H + bkY, sl - 33), L(SX + 9, H + bkY + 13, sl - 26), L(SX - 9, H + bkY + 13, sl - 26)];
    var hrT = [L(SX - 9, H + bkY + 13, sl - 26), L(SX + 9, H + bkY + 13, sl - 26), L(SX + 9, H + bkY + 16, sl - 28), L(SX - 9, H + bkY + 16, sl - 28)];
    pushP(hrF, shade("#2b3348", faceN(hrF[0], hrF[1], hrF[2])), null);
    pushP(hrT, shade("#35405a", faceN(hrT[0], hrT[1], hrT[2])), null);
    var hrL = [L(SX - 9, H + bkY, sl - 33), L(SX - 9, H + bkY, sl - 30), L(SX - 9, H + bkY + 16, sl - 30), L(SX - 9, H + bkY + 13, sl - 33)];
    pushP(hrL, shade("#1a2030", faceN(hrL[0], hrL[1], hrL[2])), null);
  }

  function drawFigure() {
    var H = S.hgt;
    var hipY = H + 2;
    var yawDeg = ((S.rot % 360) + 360) % 360;
    var sl = seatSlide(), SX = SEATX;
    function L(x, y, z) {
      var q = rotY(v3(x, y, z), yawDeg, SX, sl);
      return { x: q.x, y: q.y, z: q.z };
    }
    function fwd() { return rotY(v3(0, 0, 1), yawDeg, SX, sl); }
    var FV = fwd();
    var shX = v3(SX, 46, sl), shL = v3(SX - 18, 47, sl - 1), shR = v3(SX + 18, 47, sl - 1);
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
    var nrm = ((S.rot % 360) + 360) % 360;
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
    /* heading ribbon — which way Phill is facing in the cabin */
    var headDeg = ((S.rot % 360) + 360) % 360;
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
    /* vignette */
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
    $("sfHgt").textContent = S.hgt + " cm";
    $("sfRot").textContent = Math.round((((S.rot % 360) + 360) % 360)) + "°";
    $("sfSl").textContent = (S.sl >= 0 ? "+" : "") + S.sl + " cm";
    $("dockHgt").textContent = S.hgt + " cm";
    $("dockRot").textContent = Math.round((((S.rot % 360) + 360) % 360)) + "°";
    $("dockSl").textContent = (S.sl >= 0 ? "+" : "") + S.sl + " cm";
    window.__SEAT_LIVE__ = { rot: S.rot, sl: S.sl, hgt: S.hgt };
    if (!GX) return;
    CamBase = camAt(S.t);
    CamB = camAt(S.t, 1);
    DLS.length = 0;
    GX.clearRect(0, 0, CVW, CVH);
    addDockBackdrop();
    var shX = 0, shY = 0;
    if (S.joltNow > 0.2) { shX = S.joltNow * 6 * Math.sin(S.t * 91 + 1.3); shY = S.joltNow * 5 * Math.sin(S.t * 77 + 4.1); }
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
      try { window.__CABIN_PROBE__.hook({ proj: proj, CamBase: CamBase, CVW: CVW, CVH: CVH, CVF: CVF, S: S, PHILL: PHILL }); } catch (e) { /* headless */ }
    }
  }
  function banner(text, cls) {
    var b = $("eventBanner");
    b.textContent = text;
    b.className = "event-banner show" + (cls ? " " + cls : "");
    clearTimeout(banner._t);
    banner._t = setTimeout(function () { b.className = "event-banner"; }, 2200);
  }
  function shakeScene() {
    var w = $("sceneWrap");
    w.classList.remove("jolt-shake"); void w.offsetWidth; w.classList.add("jolt-shake");
  }

  /* ================= view sector ================= */
  function viewSector() {
    var r = ((S.rot % 360) + 360) % 360;
    if (r < 30 || r >= 330) return "FORWARD";
    if (r >= 150 && r < 210) return "CABIN";
    if (r < 150) return "LEFT";
    return "RIGHT";
  }

  /* ================= rendering ================= */
  function renderClock() {
    $("clockVal").textContent = fmtTime(S.t);
    $("phaseChip").textContent = S.done ? "Done" : (S.phase === "setup" ? "Setup" : S.phase === "ride" ? "Ride" : "Paused");
    $("phaseChip").className = "phase " + (S.done ? "done" : S.phase);
    $("tlMarker").style.left = (S.t / RIDE_END * 100) + "%";
  }
  function renderSceneFx() {
    $("hudSpeed").textContent = Math.round(S.speed) + " km/h";
    $("sfG").textContent = S.gNow.toFixed(1) + " g";
    document.querySelectorAll(".streak").forEach(function (el) {
      el.classList.toggle("on", S.phase === "ride" && !S.done && S.speed > 8);
    });
  }
  function renderDial() {
    var r = ((S.rot % 360) + 360) % 360;
    $("rotRead").textContent = r + "°";
    $("dialDegText").textContent = r + "°";
    $("dialNeedle").setAttribute("transform", "rotate(" + r + " 80 80)");
    $("dialSeat").setAttribute("transform", "rotate(" + r + " 80 80)");
    var cone = conePath(80, 80, 44, r);
    $("dialCone").setAttribute("d", cone);
    $("viewSector").textContent = viewSector();
  }
  function conePath(cx, cy, rad, deg) {
    var a0 = (deg - 60) * Math.PI / 180, a1 = (deg + 60) * Math.PI / 180;
    return "M" + cx + "," + cy +
      " L" + (cx + Math.sin(a0) * rad) + "," + (cy - Math.cos(a0) * rad) +
      " A" + rad + "," + rad + " 0 0 1 " + (cx + Math.sin(a1) * rad) + "," + (cy - Math.cos(a1) * rad) + " Z";
  }
  function renderRail() {
    var H0 = 388, H1 = 300; // px at hgt 38..46
    var y = H0 - (S.hgt - 38) * ((H0 - H1) / 8);
    $("hgtThumb").style.top = (y - 9) + "px";
    $("hgtTarget").style.top = (H0 - (PHILL.targetHgt - 38) * ((H0 - H1) / 8)) + "px";
    $("hgtRead").textContent = S.hgt;
    $("hgtAtt").textContent = "att " + rate(HGT, S.hgt).toFixed(2);
  }
  function renderSlide() {
    var x = 50 + (S.sl / 8) * 42; // % across the track, ±8 cm
    $("slThumb").style.left = "calc(" + x + "% - 9px)";
    $("slRead").textContent = (S.sl >= 0 ? "+" : "") + S.sl;
  }
  function renderGauges() {
    var aR = Math.round(rate(ROT, S.rot) * 100), aH = Math.round(rate(HGT, S.hgt) * 100);
    var f = seatFit();
    $("gRotV").textContent = aR;
    $("gRot").style.width = aR + "%";
    $("gHgtV").textContent = aH;
    $("gHgt").style.width = aH + "%";
    $("fitRotV").textContent = "fit " + f.rot.toFixed(2);
    $("fitHgtV").textContent = "fit " + f.hgt.toFixed(2);
    $("fitRotTxt").textContent = Math.abs(S.rot - PHILL.targetRot) <= PHILL.tolRot ? "within Phill's comfort zone ✓" : "rotated away from Phill's zone";
    $("fitHgtTxt").textContent = Math.abs(S.hgt - PHILL.targetHgt) <= PHILL.tolHgt ? "where Phill likes to sit ✓" : (S.hgt < PHILL.targetHgt ? "he would raise it · prefers 44" : "he would lower it · prefers 44");
    $("fitRotV").className = "mono " + (Math.abs(S.rot - PHILL.targetRot) <= PHILL.tolRot ? "ok" : "bad");
    $("fitHgtV").className = "mono " + (Math.abs(S.hgt - PHILL.targetHgt) <= PHILL.tolHgt ? "ok" : "bad");
  }
  function renderMood() {
    $("mComfort").textContent = S.mood.comfort.toFixed(2);
    $("mEnergy").textContent = S.mood.energy.toFixed(2);
    $("mSusp").textContent = S.mood.suspicion.toFixed(2);
    $("bComfort").style.width = (S.mood.comfort * 100) + "%";
    $("bEnergy").style.width = (S.mood.energy * 100) + "%";
    $("bSusp").style.width = (S.mood.suspicion * 100) + "%";
  }
  function renderMemory() {
    $("memRows").innerHTML = "";
    S.memory.forEach(function (m) {
      var row = document.createElement("div"); row.className = "mrow";
      var l = document.createElement("span"); l.className = "lbl"; l.textContent = m.label;
      var tr = document.createElement("span"); tr.className = "track";
      var f = document.createElement("span"); f.className = "fill"; f.style.width = (m.act * 100) + "%";
      tr.appendChild(f);
      var a = document.createElement("span"); a.className = "age";
      a.textContent = fmtTime(S.t - m.born) + " old";
      row.appendChild(l); row.appendChild(tr); row.appendChild(a);
      $("memRows").appendChild(row);
    });
    $("forgotLine").innerHTML = "forgot · " +
      (S.forgot.length ? S.forgot.slice(-3).map(function (f) { return f.label; }).join(" · ")
        : (S.forgotCount ? "…and " + S.forgotCount + " more" : "nothing yet"));
  }
  function renderThoughts() {
    var pre = "";
    if (S.bdi && S.bdi.intention) {
      var go = BDI_GOALS[S.bdi.intention];
      pre = '<div class="thought"><span class="tt">intent</span><span>' +
        (go ? go.label : S.bdi.intention) + " · " + Math.round(S.t - S.bdi.since) + "s</span></div>";
    }
    $("thoughts").innerHTML = pre + S.thoughts.map(function (th) {
      return '<div class="thought"><span class="tt">' + th.time + "</span><span>" + th.text + "</span></div>";
    }).join("");
  }
  function renderLog() {
    $("log").innerHTML = S.log.slice(0, 40).map(function (e) {
      return '<div class="ln ' + (e.kind === "say" ? "say" : "") + '"><span class="t mono">' + e.t +
        "</span><span>" + e.text + "</span></div>";
    }).join("");
  }
  function sample() {
    if (S.t - lastSampleT >= 3 || S.t < 3) {
      lastSampleT = S.t;
      var tw = trustValue();
      S.samples.push({ t: S.t, c: S.mood.comfort, s: S.mood.suspicion, e: S.mood.energy, trust: tw });
      S.trust.trail.push({ t: S.t, v: tw });
    }
  }

  /* ================= live cognitive bridge (brain → body) =================
     Exposes a single public live store the 3D avatar can read each frame.
     The SAME object reference is updated in place every tick, so consumers
     holding window.__COG_LIVE__ always see fresh state. No render/DOM/BDI
     semantics change; existing hooks (__SEAT_LIVE__, __CABIN_PROBE__) stand.
     Subscribers via window.__COG_SUBSCRIBE__(fn) get the store and may
     unsubscribe via the returned cancel function. */
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
  var cogPriors = { rides: 0, trust: null };
  cogLive.priors = cogPriors;
  function publishCog() {
    cogLive.mood.comfort = S.mood.comfort;
    cogLive.mood.energy = S.mood.energy;
    cogLive.mood.suspicion = S.mood.suspicion;
    cogLive.trust = S.trust.score;
    cogLive.intention = S.bdi.intention || null;
    cogLive.ride.speed = S.speed;
    cogLive.ride.g = S.gNow;
    cogLive.ride.jolt = S.joltNow;
    cogLive.ride.rain = S.rain;
    cogLive.ride.phase = S.phase;
    cogLive.ride.t = S.t;
    cogLive.thoughts = S.thoughts.length ? S.thoughts[0].text : "";
    cogLive.speech = S.speech || "";
    var p = S.priors;
    cogPriors.rides = p ? (p.rides || 0) : 0;
    cogPriors.trust = (p && typeof p.trust === "number") ? p.trust : null;
    for (var i = 0; i < cogSubs.length; i++) {
      try { cogSubs[i](cogLive); } catch (e) { /* a bad subscriber must not break the sim */ }
    }
  }
  window.__COG_LIVE__ = cogLive;
  window.__COG_SUBSCRIBE__ = cogSubscribe;

  /* ================= main loop ================= */
  var lastWall = performance.now();
  function frame(now) {
    var da = (now - lastWall) / 1000;
    lastWall = now;
    if (S.running && !S.done) {
      var dt = Math.min(4, da) * S.timeScale;
      simulate(dt);
    }
    renderAll();
    publishCog();
    requestAnimationFrame(frame);
  }
  function simulate(dt) {
    S.t += dt;
    // phases
    if (S.phase === "setup" && S.t >= RIDE_START) {
      S.phase = "ride";
      logLine("sys", "— auto-pilot engaged · departing —");
      $("transportNote").textContent = "ride in progress · you can still adjust the seat";
    }
    if (S.phase === "ride" && S.t >= RIDE_END) { finish(); }

    // events
    EVENTS.forEach(function (ev) {
      if (!fired[ev.t] && S.t >= ev.t) { fired[ev.t] = true; perceive(ev); }
    });

    // speed coasting toward current target
    S.speed += (S.targetSpeed - S.speed) * Math.min(1, dt * 0.05);

    // mood
    var ct = comfortTarget();
    S.mood.comfort += (ct - S.mood.comfort) * Math.min(1, dt * 0.06);
    S.gNow *= Math.exp(-dt * 0.3);
    S.joltNow *= Math.exp(-dt * 0.35);
    /* env-side weather: rain beads while the drizzle event is live */
    if (S.t > 540 && S.t < 570) S.rain = Math.min(1, S.rain + dt * 0.08);
    else S.rain *= Math.exp(-dt * 0.18);
    S.mood.energy = Math.max(0.05, S.mood.energy - dt * 0.00018);
    var bs = PHILL.suspicionBase;
    if (S.mood.suspicion > bs) S.mood.suspicion = Math.max(bs, S.mood.suspicion - dt * 0.004);
    else S.mood.suspicion = Math.min(bs, S.mood.suspicion + dt * 0.003);

    // cognition — BDI loop: perceive → desire → intention → act
    decayMemory(dt);
    bdiReason(dt);
    sample();
  }
  function renderAll() {
    renderClock(); renderSceneFx(); renderSeatScene(); renderDial();
    renderRail(); renderSlide(); renderGauges(); renderMood(); renderMemory();
  }

  /* ================= seat interaction ================= */
  function setRot(r) {
    r = Math.round((((r % 360) + 360) % 360));
    if (r === S.rot) return;
    lastUserInput = S.t;
    S.rot = r; rotChanged = true;
    renderAll();
    logLine("adj", "rotation → " + r + "°");
    if (Math.abs(r - PHILL.targetRot) > PHILL.tolRot && Math.random() < 0.5) {
      speak(pick(THOUGHTS.rotOther));
    } else if (r === 0 && Math.random() < 0.5) { speak(pick(THOUGHTS.rotFwd)); }
  }
  function setHgt(h) {
    h = Math.max(38, Math.min(46, Math.round(h)));
    if (h === S.hgt) return;
    lastUserInput = S.t;
    S.hgt = h;
    renderAll();
    logLine("adj", "height → " + h + " cm");
    if (Math.abs(h - PHILL.targetHgt) > PHILL.tolHgt && Math.random() < 0.6) {
      speak(h < PHILL.targetHgt ? pick(THOUGHTS.seatLow) : pick(THOUGHTS.rotOther));
    } else if (h === PHILL.targetHgt && Math.random() < 0.7) { speak(pick(THOUGHTS.seatGood)); }
  }
  function setSl(s) {
    s = Math.max(-8, Math.min(8, Math.round(s)));
    if (s === S.sl) return;
    lastUserInput = S.t;
    S.sl = s;
    renderAll();
    logLine("adj", "slide → " + (s >= 0 ? "+" : "") + s + " cm");
    if (s < 0 && Math.random() < 0.5) { speak(pick(THOUGHTS.seatLow)); }
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
  dial.addEventListener("pointerdown", function (e) { dragging = true; dial.setPointerCapture && dial.setPointerCapture(e.pointerId); setRot(angleFromEvent(e)); });
  dial.addEventListener("pointermove", function (e) { if (dragging) setRot(angleFromEvent(e)); });
  dial.addEventListener("pointerup", function () { dragging = false; });

  // height rail
  var track = $("hgtTrack");
  function hgtFromEvent(e) {
    var r = track.getBoundingClientRect();
    var y = e.clientY - r.top;
    var H0 = 388, H1 = 300;
    var h = 38 + (H0 - y) / ((H0 - H1) / 8);
    return h;
  }
  var draggingH = false;
  track.addEventListener("pointerdown", function (e) { draggingH = true; track.setPointerCapture && track.setPointerCapture(e.pointerId); setHgt(hgtFromEvent(e)); });
  track.addEventListener("pointermove", function (e) { if (draggingH) setHgt(hgtFromEvent(e)); });
  track.addEventListener("pointerup", function () { draggingH = false; });

  // slide track
  var slTrack = $("slTrack");
  function slFromEvent(e) {
    var r = slTrack.getBoundingClientRect();
    var x = (e.clientX - r.left) / r.width;
    return Math.round(8 * (2 * x - 1));
  }
  var draggingSl = false;
  slTrack.addEventListener("pointerdown", function (e) { draggingSl = true; slTrack.setPointerCapture && slTrack.setPointerCapture(e.pointerId); setSl(slFromEvent(e)); });
  slTrack.addEventListener("pointermove", function (e) { if (draggingSl) setSl(slFromEvent(e)); });
  slTrack.addEventListener("pointerup", function () { draggingSl = false; });

  // keyboard: arrows + space
  window.addEventListener("keydown", function (e) {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === "ArrowLeft") setRot(S.rot - 5);
    else if (e.key === "ArrowRight") setRot(S.rot + 5);
    else if (e.key === "ArrowUp") setHgt(S.hgt + 1);
    else if (e.key === "ArrowDown") setHgt(S.hgt - 1);
    else if (/^[aAdD]$/.test(e.key)) setSl(e.key.toLowerCase() === "a" ? S.sl - 1 : S.sl + 1);
    else if (e.key === " ") { e.preventDefault(); togglePlay(); }
  });

  /* ================= transport ================= */
  function syncPlay() {
    var lbl = S.running ? "❚❚ Pause" : "▶ Play";
    $("btnPlay").textContent = lbl;
    $("topPlay").textContent = lbl;
  }
  function togglePlay() { S.running = !S.running; syncPlay(); }
  function setSpeed(sp) {
    S.timeScale = sp;
    document.querySelectorAll(".speed-group .btn").forEach(function (x) {
      x.classList.toggle("on", +x.getAttribute("data-s") === sp);
    });
  }
  function skipSetup() {
    if (S.phase === "setup") { S.t = RIDE_START + 0.01; logLine("sys", "setup skipped"); }
  }
  $("btnPlay").addEventListener("click", togglePlay);
  $("btnRestart").addEventListener("click", function () { location.reload(); });
  $("btnSkip").addEventListener("click", skipSetup);
  $("topPlay").addEventListener("click", togglePlay);
  $("topRestart").addEventListener("click", function () { location.reload(); });
  $("topSkip").addEventListener("click", skipSetup);
  document.querySelectorAll(".speed-group .btn").forEach(function (b) {
    b.addEventListener("click", function () { setSpeed(+b.getAttribute("data-s")); });
  });
  $("btnReplay").addEventListener("click", function () { location.reload(); });

  /* ================= summary ================= */
  function finish() {
    S.done = true; S.running = false;
    S.phase = "done";
    var avgC = S.samples.reduce(function (a, c) { return a + c.c; }, 0) / Math.max(1, S.samples.length);
    var avgS = S.samples.reduce(function (a, c) { return a + c.s; }, 0) / Math.max(1, S.samples.length);
    var grade = S.trust.score >= 0.62 ? "Phill would take this ride again." :
      S.trust.score >= 0.45 ? "Acceptable — some minutes were iffy." : "He got out a little wary.";
    S.trust.items = evidenceAnswers();
    submitTrust();
    ridePriors(avgC, avgS);
    openTrustQ();
    $("sumGrade").textContent = "avg comfort " + avgC.toFixed(2) + " · avg suspicion " + avgS.toFixed(2) +
      " · trust " + S.trust.score.toFixed(2) + " — " + grade;
    drawSeries($("cvComfort"), "t", "c", 0, RIDE_END, 0, 1, "#C9A227", S.samples);
    drawSeries($("cvSusp"), "t", "s", 0, RIDE_END, 0, 1, "#C9A227", S.samples);
    drawSeries($("cvSusp"), "t", "v", 0, RIDE_END, 0, 1, "#6BD5C0", S.trust.trail, false);
    $("sumMem").innerHTML = S.memory.map(function (m) {
      return '<li><span class="cap">' + m.label + "</span> · activation " + m.act.toFixed(2) + "</li>";
    }).join("") || "<li>—</li>";
    $("sumForg").innerHTML = S.forgot.map(function (m) {
      return '<li><span class="rem">' + m.label + "</span> · forgot it " + m.age + " s in</li>";
    }).join("") || "<li>—</li>";
    $("summary").classList.add("show");
    $("btnPlay").disabled = true;

    $("topPlay").disabled = true;    logLine("sys", "— ride complete —");
    logLine("trust", "questionnaire · trust " + S.trust.score.toFixed(2) + " · priors saved for next ride");
  }
  function drawSeries(cv, kx, ky, x0, x1, y0, y1, st, data, clear) {
    var g = cv.getContext("2d");
    var W = cv.width, H = cv.height;
    var src = data || S.samples;
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

  /* ================= static svg build ================= */
  function buildDialTicks() {
    var g = $("dialTicks");
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
    var H0 = 388, H1 = 300;
    g.innerHTML = "";
    for (var h = 38; h <= 46; h++) {
      var y = H0 - (h - 38) * ((H0 - H1) / 8);
      g.innerHTML += '<i style="top:' + (y - 4) + 'px">' + h + "</i>";
    }
  }
  function buildTlEvents() {
    var W = $("tlTrack").getBoundingClientRect().width || 800;
    $("tlEvents").innerHTML = EVENTS.map(function (ev) {
      return '<div class="tl-event" style="left:' + (ev.t / RIDE_END * 100) + '%"></div>';
    }).join("");
  }

  /* ================= lavish feedback ================= */
  function setupLavish() {
    var has = typeof window.lavish !== "undefined";
    if (has) {
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
  loadPriors();
  buildDialTicks(); buildRailTicks();
  // initial setup dialogue — "Evening again…" if last ride left priors behind
  if (S.priors && S.priors.rides) {
    speak("Evening again. Last ride shaped me a little — " +
      (S.priors.trust >= 0.6 ? "the cabin earned some trust." : S.priors.trust >= 0.45 ? "still cautious, but willing." : "I left wary. Let's see what changes."),
      true);
  } else {
    speak("Evening. Right, driver's seat — wheel dead ahead. Give me a moment to sit in properly.", true);
  }
  setTimeout(function () {
    speak("Fresh out of the factory feel. Raise the seat a touch if you like, I sit tall.", true);
  }, 2600);
  S.nextSpeak = 22 + Math.random() * 10;
  renderAll(); renderMemory(); renderThoughts(); renderLog();
  // trust questionnaire wiring (mind-owned; env markup kept additive)
  $("tqSubmit").addEventListener("click", function () {
    submitTrust();
    var q = $("trustQ");
    if (q) q.style.display = "none";
    speak($("tqNote").textContent ? String($("tqNote").textContent).replace(/^[^“]*“/, "“") : finalRemark(), true);
  });
  $("tqClose").addEventListener("click", function () {
    var q = $("trustQ");
    if (q) q.style.display = "none";
  });
  setupLavish();
  window.addEventListener("resize", function () { sizeCanvas(); buildTlEvents(); });
  setTimeout(function () { sizeCanvas(); buildTlEvents(); }, 60);
  publishCog();
  requestAnimationFrame(frame);
})();
export {};
