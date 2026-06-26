'use strict';

// ─── Elements ────────────────────────────────────────────────────────────────
const scene   = document.getElementById('scene');
const faceEl  = document.getElementById('face');
const eyesEl  = document.getElementById('eyes');
const eyeL    = document.getElementById('eye-left');
const eyeR    = document.getElementById('eye-right');

const innerL  = eyeL.querySelector('.eye-inner');
const innerR  = eyeR.querySelector('.eye-inner');
const inners  = [innerL, innerR];

const lidTopL = eyeL.querySelector('.lid-top');
const lidTopR = eyeR.querySelector('.lid-top');
const lidBotL = eyeL.querySelector('.lid-bottom');
const lidBotR = eyeR.querySelector('.lid-bottom');

const masks   = document.querySelectorAll('.eye-mask');
const bodies  = document.querySelectorAll('.eye-body');

// .eye wrappers are driven entirely by JS lerp — kill CSS transition
eyeL.style.transition = 'none';
eyeR.style.transition = 'none';

// Inject bright catchlight + sheen into each eye (glassy depth, never dark)
function addEyeDetail(eye) {
  const mask = eye.querySelector('.eye-mask');
  const spec = document.createElement('div'); spec.className = 'eye-spec';
  const sheen = document.createElement('div'); sheen.className = 'eye-sheen';
  mask.appendChild(spec);
  mask.appendChild(sheen);
  return spec;
}
const specL = addEyeDetail(eyeL);
const specR = addEyeDetail(eyeR);

// Full-screen layer for ripples / sparkles / Zzz
const fxLayer = document.createElement('div');
fxLayer.id = 'fx-layer';
document.body.appendChild(fxLayer);

// ─── Animated state (lerped each frame) ──────────────────────────────────────
const gaze = { x: 0, y: 0 }, gazeTgt = { x: 0, y: 0 };
let sclL = 1, sclR = 1, sclLT = 1, sclRT = 1;        // per-eye scale
let dyL = 0, dyR = 0, dyLT = 0, dyRT = 0;            // per-eye vertical offset
let beat = 1;                                         // global heartbeat multiplier

let currentMood   = 'DEFAULT';
let blinking      = false;
let lastBlink     = 0;        // throttle so blinks never stack/flutter
let glitching     = false;
let pointerDown   = false;
let behaviorStop  = null;     // cleanup fn for active behavior
let booting       = true;     // power-on sequence in progress
let asleep        = false;    // standby sleep state
let lastInteraction = performance.now();
const T0 = performance.now();
let prevGX = 0, prevGY = 0;   // for afterimage smear

const MAX_X = 30, MAX_Y = 15;

// ─── SFX (procedural Web Audio — no files) ───────────────────────────────────
const SFX = {
  ctx: null, master: null, muted: false, _booted: false,

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(this.ctx.destination);
  },
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },

  tone({ freq = 440, dur = 0.12, type = 'sine', vol = 0.3, glideTo = null, attack = 0.005, release = 0.06 }) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, glideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + release);
    osc.connect(g); g.connect(this.master);
    osc.start(t); osc.stop(t + dur + release + 0.02);
  },
  noise({ dur = 0.15, vol = 0.2, freq = 1200, type = 'highpass' }) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const filt = this.ctx.createBiquadFilter(); filt.type = type; filt.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt); filt.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur);
  },

  blinkS()    { this.tone({ freq: 680, dur: 0.035, type: 'square',   vol: 0.05, glideTo: 520 }); },
  tapS()      { this.tone({ freq: 520, dur: 0.10,  type: 'triangle', vol: 0.22, glideTo: 820 }); },
  winkS()     { this.tone({ freq: 900, dur: 0.07,  type: 'square',   vol: 0.14, glideTo: 660 }); },
  surprised() { this.tone({ freq: 380, dur: 0.24,  type: 'sawtooth', vol: 0.18, glideTo: 1300 }); },
  moodS(i = 0) {
    const base = 440 + (i % 5) * 70;
    this.tone({ freq: base, dur: 0.08, type: 'sine', vol: 0.12 });
    setTimeout(() => this.tone({ freq: base * 1.5, dur: 0.10, type: 'sine', vol: 0.10 }), 95);
  },
  glitchS() {
    this.noise({ dur: 0.10, vol: 0.16, freq: 700, type: 'bandpass' });
    this.tone({ freq: 120 + Math.random() * 700, dur: 0.06, type: 'sawtooth', vol: 0.14, glideTo: 60 });
  },
  swoosh()    { this.noise({ dur: 0.18, vol: 0.12, freq: 700, type: 'highpass' }); },
  boot() {
    this.tone({ freq: 300, dur: 0.18, type: 'sine', vol: 0.18, glideTo: 900 });
    setTimeout(() => this.tone({ freq: 900, dur: 0.12, type: 'sine', vol: 0.12 }), 130);
  },
  rippleS()   { this.tone({ freq: 440, dur: 0.16, type: 'sine', vol: 0.10, glideTo: 1100 }); },
  sparkleS()  {
    this.tone({ freq: 1200, dur: 0.06, type: 'triangle', vol: 0.10, glideTo: 1900 });
    setTimeout(() => this.tone({ freq: 1700, dur: 0.06, type: 'triangle', vol: 0.07, glideTo: 2300 }), 70);
  },
  yawnS()     { this.tone({ freq: 240, dur: 0.5, type: 'sine', vol: 0.14, glideTo: 520, attack: 0.12, release: 0.2 }); },
  snoreS()    { this.tone({ freq: 90,  dur: 0.55, type: 'sawtooth', vol: 0.07, glideTo: 60, attack: 0.15 }); },
  browS()     { this.tone({ freq: 700, dur: 0.05, type: 'square', vol: 0.06, glideTo: 1000 }); },
};

try { SFX.muted = localStorage.getItem('roboMuted') === '1'; } catch (e) {}

// ─── Low-level transform helpers ─────────────────────────────────────────────
function setInner(transform, ms, ease = 'ease-out') {
  inners.forEach(el => {
    el.style.transition = `transform ${ms}ms ${ease}`;
    el.style.transform  = transform;
  });
}
function setInnerOne(el, transform, ms, ease = 'ease-out') {
  el.style.transition = `transform ${ms}ms ${ease}`;
  el.style.transform  = transform;
}
function setLidTop(el, y, rot, ms = 420) {
  el.style.transition = `transform ${ms}ms cubic-bezier(0.34,1.2,0.64,1)`;
  el.style.transform  = `translateY(${y}%) rotate(${rot}deg)`;
}
function setLidBot(el, y, ms = 420) {
  el.style.transition = `transform ${ms}ms cubic-bezier(0.34,1.2,0.64,1)`;
  el.style.transform  = `translateY(${y}%)`;
}
function setRadius(css) {
  const v = css || 'var(--r)';
  masks.forEach(m => m.style.borderRadius = v);
  bodies.forEach(b => b.style.borderRadius = v);
}

// ─── BLINK (smooth scaleY collapse) ──────────────────────────────────────────
function blink(closeMs = 95, holdMs = 28, openMs = 185, force = false) {
  if (blinking || booting) return;
  const now = performance.now();
  if (!force && now - lastBlink < 650) return;   // min gap → no fluttering
  lastBlink = now;
  blinking = true;
  setInner('scaleY(0.03)', closeMs, 'cubic-bezier(0.55,0,0.75,0.4)');  // smooth close
  setTimeout(() => {
    setInner('scaleY(1)', openMs, 'cubic-bezier(0.16,1,0.3,1)');       // gentle settle, no overshoot
    setTimeout(() => { blinking = false; }, openMs + 20);
  }, closeMs + holdMs);
}
function winkOne(el, closeMs = 80, openMs = 165) {
  SFX.winkS();
  setInnerOne(el, 'scaleY(0.02)', closeMs, 'ease-in');
  setTimeout(() => setInnerOne(el, 'scaleY(1)', openMs, 'cubic-bezier(0.22,1.4,0.36,1)'), closeMs + 14);
}
function squish() {
  setInner('scaleY(0.7) scaleX(1.08)', 65, 'ease-in');
  setTimeout(() => setInner('scaleY(1) scaleX(1)', 230, 'cubic-bezier(0.34,1.7,0.64,1)'), 70);
}

// Power-on: eyes start as a thin bright line, then snap open with a flicker
function bootSequence() {
  booting = true;
  setInner('scaleY(0.02) scaleX(1.06)', 0);     // instant collapse to a line
  faceEl.classList.add('boot-flicker');
  setTimeout(() => setInner('scaleY(1) scaleX(1)', 380, 'cubic-bezier(0.16,1,0.3,1)'), 170);
  setTimeout(() => { faceEl.classList.remove('boot-flicker'); booting = false; }, 580);
}
function scheduleBlink() {
  setTimeout(() => {
    if (!glitching && !asleep) {
      blink();
      if (!MUSIC.playing) SFX.blinkS();
    }
    scheduleBlink();
  }, 2400 + Math.random() * 4200);
}

// ─── Render loop ─────────────────────────────────────────────────────────────
function animLoop() {
  gaze.x += (gazeTgt.x - gaze.x) * 0.045;   // gentler glide
  gaze.y += (gazeTgt.y - gaze.y) * 0.045;
  sclL   += (sclLT - sclL) * 0.14;
  sclR   += (sclRT - sclR) * 0.14;
  dyL    += (dyLT  - dyL)  * 0.14;
  dyR    += (dyRT  - dyR)  * 0.14;

  // Music reactivity: pulse the eyes with overall level + beat envelope
  MUSIC.update();
  if (MUSIC.playing) beat = 1 + MUSIC.level * 0.10 + MUSIC.beatEnv * 0.18;

  // Idle breathing — constant gentle float + scale so the face is never frozen
  const t = (performance.now() - T0) / 1000;
  const bf = asleep ? 0.6 : 1.3;                 // breathe slower while asleep
  const breatheY  = Math.sin(t * bf) * (asleep ? 7 : 5);
  const breatheSc = 1 + Math.sin(t * bf) * 0.014;

  // Skip restyling the eyes while sliding or on the clock page (avoids repaint of a moving layer)
  if (pageIndex === 1 && !swiping) {
    eyeL.style.transform = `translate(${gaze.x}px,${gaze.y + dyL + breatheY}px) scale(${sclL * beat * breatheSc})`;
    eyeR.style.transform = `translate(${gaze.x}px,${gaze.y + dyR + breatheY}px) scale(${sclR * beat * breatheSc})`;

    // Catchlight parallax — highlight drifts opposite to gaze (fakes a sphere)
    const px = -gaze.x * 0.28, py = -gaze.y * 0.28;
    specL.style.transform = specR.style.transform = `translate(${px}px,${py}px)`;

    // Afterimage smear on fast jumps
    const sp = Math.hypot(gaze.x - prevGX, gaze.y - prevGY);
    if (sp > 6) {
      const b = Math.min(sp * 0.5, 7);
      innerL.style.filter = innerR.style.filter = `blur(${b}px)`;
    } else if (innerL.style.filter) {
      innerL.style.filter = innerR.style.filter = '';
    }
  }
  prevGX = gaze.x; prevGY = gaze.y;
  requestAnimationFrame(animLoop);
}

// ─── Idle gaze + micro-saccades ──────────────────────────────────────────────
function idleDrift() {
  if (!glitching && !pointerDown && !behaviorStop && !asleep) {
    if (Math.random() < 0.22) { gazeTgt.x = 0; gazeTgt.y = 0; }
    else {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random());
      gazeTgt.x = Math.cos(a) * r * MAX_X;
      gazeTgt.y = Math.sin(a) * r * MAX_Y;
    }
  }
  setTimeout(idleDrift, 1600 + Math.random() * 3200);   // rest longer between moves
}
function microSaccade() {
  // subtle, occasional dart — only sometimes, small, slow return
  if (!glitching && !pointerDown && !behaviorStop && !asleep && Math.random() < 0.5) {
    const ox = gazeTgt.x, oy = gazeTgt.y;
    gazeTgt.x = ox + (Math.random() - 0.5) * 3;
    gazeTgt.y = oy + (Math.random() - 0.5) * 2;
    setTimeout(() => { gazeTgt.x = ox; gazeTgt.y = oy; }, 130 + Math.random() * 70);
  }
  setTimeout(microSaccade, 2600 + Math.random() * 4000);
}

// ─── Playful idle micro-acts ─────────────────────────────────────────────────
function browFlick() {
  SFX.browS();
  sclLT = 1.12; sclRT = 1.12;                 // quick eye-widen
  setTimeout(() => { sclLT = 1; sclRT = 1; }, 220);
}
function lookAround() {
  const seq = [[-MAX_X * 0.8, 0], [MAX_X * 0.8, 0], [0, 0]];
  seq.forEach(([x, y], i) => setTimeout(() => { gazeTgt.x = x; gazeTgt.y = y; }, i * 450));
}
function headTilt() {
  dyLT = -10; dyRT = 8;
  setTimeout(() => { dyLT = 0; dyRT = 0; }, 700);
}
function idleAct() {
  if (!glitching && !pointerDown && !behaviorStop && !asleep && !booting &&
      pageIndex === 1 && currentMood === 'DEFAULT') {
    const r = Math.random();
    if (r < 0.20)      winkOne(Math.random() < 0.5 ? innerL : innerR);
    else if (r < 0.42) browFlick();
    else if (r < 0.64) lookAround();
    else if (r < 0.82) headTilt();
    else { blink(70, 0, 120); setTimeout(() => { blinking = false; blink(70, 0, 120, true); }, 300); }
  }
  setTimeout(idleAct, 4000 + Math.random() * 5000);
}

// ─── Sleep & wake ────────────────────────────────────────────────────────────
const SLEEP_MS = 45000;
let sleepTimer = null;

function checkSleep() {
  if (!asleep && !pointerDown && !MUSIC.playing && !glitching &&
      pageIndex === 1 && performance.now() - lastInteraction > SLEEP_MS) {
    goSleep();
  }
  setTimeout(checkSleep, 2000);
}
function goSleep() {
  asleep = true;
  document.body.classList.add('asleep');
  clearTimeout(moodTimer);
  stopBehavior();
  currentMood = 'DEFAULT';
  setRadius('');
  sclLT = 1; sclRT = 1; dyLT = 0; dyRT = 0;
  setLidTop(lidTopL, -30, 0, 900); setLidTop(lidTopR, -30, 0, 900);   // ~80% closed
  setLidBot(lidBotL, 150); setLidBot(lidBotR, 150);
  gazeTgt.x = 0; gazeTgt.y = 6;
  sleepLoop();
}
function sleepLoop() {
  if (!asleep) return;
  spawnZzz();
  SFX.snoreS();
  gazeTgt.x = (Math.random() < 0.5 ? -1 : 1) * 6; gazeTgt.y = 6;
  sleepTimer = setTimeout(sleepLoop, 3200 + Math.random() * 1600);
}
function wake() {
  if (!asleep) return;
  asleep = false;
  document.body.classList.remove('asleep');
  clearTimeout(sleepTimer);
  setLidTop(lidTopL, -160, 0, 300); setLidTop(lidTopR, -160, 0, 300);
  SFX.yawnS();
  setInner('scaleY(1.18) scaleX(0.96)', 260, 'cubic-bezier(0.22,1.2,0.36,1)');   // yawn-stretch
  setTimeout(() => squish(), 280);
  gazeTgt.x = 0; gazeTgt.y = 0;
  applyMood('HAPPY');
  setTimeout(() => applyMood('DEFAULT', { scheduleNext: true }), 1600);
}

// ─── FX spawners (ripple / sparkles / Zzz) ───────────────────────────────────
function spawnRipple(x, y) {
  const r = document.createElement('div');
  r.className = 'ripple';
  r.style.left = x + 'px'; r.style.top = y + 'px';
  fxLayer.appendChild(r);
  r.addEventListener('animationend', () => r.remove());
}
function spawnZzz() {
  const z = document.createElement('div');
  z.className = 'zzz';
  z.textContent = 'z';
  const rect = eyesEl.getBoundingClientRect();
  z.style.left = (rect.right - 24) + 'px';
  z.style.top  = (rect.top + 8) + 'px';
  z.style.fontSize = (16 + Math.random() * 10) + 'px';
  fxLayer.appendChild(z);
  z.addEventListener('animationend', () => z.remove());
}
function spawnSparkles(n = 5) {
  const rect = eyesEl.getBoundingClientRect();
  for (let i = 0; i < n; i++) {
    setTimeout(() => {
      const s = document.createElement('div');
      s.className = 'sparkle';
      s.textContent = Math.random() < 0.6 ? '♥' : '✦';
      s.style.left = (rect.left + Math.random() * rect.width) + 'px';
      s.style.top  = (rect.top + rect.height * 0.4 + Math.random() * rect.height * 0.3) + 'px';
      s.style.fontSize = (16 + Math.random() * 14) + 'px';
      fxLayer.appendChild(s);
      s.addEventListener('animationend', () => s.remove());
    }, i * 120);
  }
  SFX.sparkleS();
}
function eyeRoll(cb) {
  let a = 0;
  const id = setInterval(() => {
    a += 0.4;
    gazeTgt.x = Math.cos(a - Math.PI / 2) * MAX_X;
    gazeTgt.y = Math.sin(a - Math.PI / 2) * MAX_Y;
    if (a >= Math.PI * 2) { clearInterval(id); gazeTgt.x = 0; gazeTgt.y = 0; if (cb) cb(); }
  }, 30);
}
function buildStars() {
  const cp = document.getElementById('clock-page');
  for (let i = 0; i < 14; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    s.style.left = Math.random() * 100 + '%';
    s.style.top  = Math.random() * 100 + '%';
    s.style.setProperty('--tw', (3 + Math.random() * 4) + 's');
    s.style.setProperty('--dr', (20 + Math.random() * 30) + 's');
    s.style.animationDelay = (-Math.random() * 5) + 's';
    cp.insertBefore(s, cp.firstChild);     // behind the clock text
  }
}

// ─── EXPRESSIONS ─────────────────────────────────────────────────────────────
// lidTop y: -160 hidden · -78≈light · -74≈medium · -66≈heavy · rot ± for diagonal
// lidBot y:  150 hidden · ~78 smile · ~83 squint
const MOODS = {
  DEFAULT:    {},
  HAPPY:      { bright: 1, radius: 'var(--r) var(--r) calc(var(--eh)*0.5) calc(var(--eh)*0.5)' },
  EXCITED:    { bright: 1, scl: [1.1, 1.1], behavior: 'bounce' },
  LOVE:       { bright: 1, radius: '50% 50% 45% 45%', behavior: 'heartbeat' },
  TIRED:      { top: [[-78,-13],[-78,13]], gazeDown: 6 },
  SLEEPY:     { top: [[-66,-5],[-66,5]], gazeDown: 9, slow: 1 },
  ANGRY:      { top: [[-74,15],[-74,-15]] },
  SAD:        { top: [[-76,-16],[-76,16]], gazeDown: 8 },
  SUSPICIOUS: { top: [[-58,0],[-58,0]] },
  FOCUSED:    { top: [[-62,0],[-62,0]] },
  SURPRISED:  { radius: 'calc(var(--r)*1.6)', scl: [1.14, 1.14], bright: 1 },
  CURIOUS:    { scl: [1.18, 0.9], dy: [-10, 6] },
  CONFUSED:   { dy: [-12, 11], top: [[-150,0],[-82,6]] },
  DIZZY:      { behavior: 'dizzy' },
  SCAN:       { behavior: 'scan' },
  SCARED:     { scl: [0.82, 0.82], behavior: 'scared' },
  GLITCHY:    { behavior: 'glitch' },
};

// Weighted pool — expressive ones common, special/rare ones sprinkled in
const POOL = [
  'DEFAULT','DEFAULT',
  'HAPPY','HAPPY','EXCITED','LOVE',
  'TIRED','SLEEPY','ANGRY','SAD','SUSPICIOUS','FOCUSED',
  'SURPRISED','CURIOUS','CONFUSED',
  'DIZZY','SCAN','SCARED',
  'GLITCHY','GLITCHY',
];

let moodTimer = null;

function stopBehavior() {
  if (behaviorStop) { behaviorStop(); behaviorStop = null; }
  beat = 1;
}

function applyMood(name, { scheduleNext = false } = {}) {
  const m = MOODS[name] || {};
  currentMood = name;

  stopBehavior();

  // Reset lids/shape to neutral, then apply overrides
  const top = m.top || [[-160, 0], [-160, 0]];
  setLidTop(lidTopL, top[0][0], top[0][1]);
  setLidTop(lidTopR, top[1][0], top[1][1]);
  setLidBot(lidBotL, m.lidBot ?? 150);
  setLidBot(lidBotR, m.lidBot ?? 150);
  setRadius(m.radius || '');

  sclLT = m.scl ? m.scl[0] : 1;
  sclRT = m.scl ? m.scl[1] : 1;
  dyLT  = m.dy  ? m.dy[0]  : 0;
  dyRT  = m.dy  ? m.dy[1]  : 0;

  if (m.gazeDown) gazeTgt.y = m.gazeDown;
  faceEl.classList.toggle('bright', !!m.bright);

  if (!m.behavior) setTimeout(() => blink(), 130);

  if (m.behavior === 'bounce')    behaviorBounce();
  if (m.behavior === 'heartbeat') behaviorHeartbeat();
  if (m.behavior === 'dizzy')     behaviorDizzy();
  if (m.behavior === 'scan')      behaviorScan();
  if (m.behavior === 'scared')    behaviorScared();
  if (m.behavior === 'glitch')    setTimeout(runGlitch, 150);

  // LOVE → floating hearts/sparkles (chained onto behaviorStop cleanup)
  if (name === 'LOVE') {
    spawnSparkles();
    const sid = setInterval(() => spawnSparkles(4), 1500);
    const prevStop = behaviorStop;
    behaviorStop = () => { clearInterval(sid); if (prevStop) prevStop(); };
  }

  if (scheduleNext) scheduleMoodChange();
}

function scheduleMoodChange() {
  clearTimeout(moodTimer);
  moodTimer = setTimeout(() => {
    if (asleep) return;                          // don't cycle moods while sleeping
    let pick;
    do { pick = POOL[Math.floor(Math.random() * POOL.length)]; }
    while (pick === currentMood);
    if (pick !== 'GLITCHY') SFX.moodS(Math.floor(Math.random() * 5));
    const go = () => applyMood(pick, { scheduleNext: true });
    if (Math.random() < 0.15) {
      eyeRoll(go);                               // occasional full eye-roll transition
    } else {
      sclLT = 0.9; sclRT = 0.9;                  // anticipation shrink → pop
      setTimeout(go, 130);
    }
  }, 7000 + Math.random() * 10000);
}

// ─── BEHAVIORS (cleanup via behaviorStop) ────────────────────────────────────
function behaviorHeartbeat() {
  let t = 0;
  const id = setInterval(() => {
    t += 0.18;
    beat = 1 + Math.sin(t) * 0.06 + (Math.sin(t * 2) > 0.85 ? 0.05 : 0);
  }, 40);
  behaviorStop = () => { clearInterval(id); beat = 1; };
}
function behaviorBounce() {
  const id = setInterval(() => { if (!blinking) squish(); }, 1100);
  behaviorStop = () => clearInterval(id);
}
function behaviorDizzy() {
  let a = 0;
  const id = setInterval(() => {
    a += 0.16;
    gazeTgt.x = Math.cos(a) * MAX_X;
    gazeTgt.y = Math.sin(a) * MAX_Y;
  }, 40);
  behaviorStop = () => { clearInterval(id); gazeTgt.x = 0; gazeTgt.y = 0; };
}
function behaviorScan() {
  let dir = 1;
  const id = setInterval(() => { gazeTgt.x = dir * MAX_X; dir *= -1; }, 750);
  behaviorStop = () => { clearInterval(id); gazeTgt.x = 0; };
}
function behaviorScared() {
  const id = setInterval(() => {
    gazeTgt.x = (Math.random() - 0.5) * MAX_X * 2;
    gazeTgt.y = (Math.random() - 0.5) * MAX_Y * 2;
    if (Math.random() < 0.3) { blinking = false; blink(45, 0, 70, true); }
  }, 200);
  behaviorStop = () => { clearInterval(id); gazeTgt.x = 0; gazeTgt.y = 0; };
}

// ─── GLITCH EFFECTS ──────────────────────────────────────────────────────────
const noiseCanvas = document.createElement('canvas');
noiseCanvas.style.cssText =
  'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:50;opacity:0;image-rendering:pixelated;transition:opacity .04s';
document.body.appendChild(noiseCanvas);

function renderNoise(alpha = 0.35) {
  noiseCanvas.width  = Math.floor(window.innerWidth  / 3);
  noiseCanvas.height = Math.floor(window.innerHeight / 3);
  const ctx = noiseCanvas.getContext('2d');
  const img = ctx.createImageData(noiseCanvas.width, noiseCanvas.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() > 0.5 ? 255 : 0;
    img.data[i] = img.data[i+1] = img.data[i+2] = v;
    img.data[i+3] = Math.random() < 0.3 ? alpha * 255 : 0;
  }
  ctx.putImageData(img, 0, 0);
}
function clearGlitch() {
  faceEl.style.filter = ''; faceEl.style.transform = ''; faceEl.style.opacity = '1';
  scene.style.filter = '';
  noiseCanvas.style.opacity = '0';
  setInner('scaleY(1)', 90);
}

function gRGB(done) {
  const a = 4 + Math.random() * 11;
  faceEl.style.filter = `drop-shadow(${-a}px 0 0 rgba(255,0,60,.9)) drop-shadow(${a}px 0 0 rgba(0,120,255,.9))`;
  setTimeout(() => { faceEl.style.filter = ''; done(); }, 70 + Math.random() * 130);
}
function gJump(done) {
  const ox = gaze.x, oy = gaze.y;
  gaze.x = gazeTgt.x = (Math.random()-0.5)*70;
  gaze.y = gazeTgt.y = (Math.random()-0.5)*30;
  setTimeout(() => { gaze.x = gazeTgt.x = ox; gaze.y = gazeTgt.y = oy; done(); }, 55 + Math.random()*80);
}
function gNoise(done) {
  renderNoise(); noiseCanvas.style.opacity = '1';
  setTimeout(() => { noiseCanvas.style.opacity = '0'; done(); }, 80 + Math.random()*180);
}
function gRapidBlink(done) {
  let i = 0, n = 3 + Math.floor(Math.random()*4);
  (function nx(){ if (i++ >= n) return done(); blinking = false; blink(45,0,60,true); setTimeout(nx, 130); })();
}
function gWarp(done) {
  setInner(`scale(${0.6+Math.random()*0.8},${0.5+Math.random()*0.9})`, 45, 'ease-in');
  setTimeout(() => { setInner('scaleY(1)', 110, 'cubic-bezier(0.22,1.4,0.36,1)'); setTimeout(done, 120); }, 55);
}
function gInvert(done) {
  scene.style.filter = 'invert(1)';
  setTimeout(() => { scene.style.filter = ''; done(); }, 45 + Math.random()*80);
}
function gSplit(done) {
  const o = 18 + Math.random()*24;
  dyL -= o; dyR += o;
  setTimeout(() => { dyL += o; dyR -= o; done(); }, 65 + Math.random()*90);
}
function gShake(done) {
  let e = 0, total = 280 + Math.random()*180;
  const id = setInterval(() => {
    faceEl.style.transform = `translate(${(Math.random()-0.5)*16}px,${(Math.random()-0.5)*8}px)`;
    if ((e += 35) >= total) { clearInterval(id); faceEl.style.transform = ''; done(); }
  }, 35);
}
function gFlicker(done) {
  let i = 0, n = (4 + Math.floor(Math.random()*4)) * 2;
  (function tick(){ faceEl.style.opacity = i%2 ? '1':'0'; if (++i > n){ faceEl.style.opacity='1'; return done(); } setTimeout(tick, 25 + Math.random()*35); })();
}
const FX = [gRGB, gJump, gNoise, gRapidBlink, gWarp, gInvert, gSplit, gShake, gFlicker];

function runGlitch() {
  if (currentMood !== 'GLITCHY') return;
  glitching = true;
  let i = 0, n = 5 + Math.floor(Math.random()*5);
  (function next(){
    if (i++ >= n || currentMood !== 'GLITCHY') {
      glitching = false; clearGlitch();
      if (currentMood === 'GLITCHY') applyMood('DEFAULT', { scheduleNext: true });
      return;
    }
    if (Math.random() < 0.6) SFX.glitchS();
    FX[Math.floor(Math.random()*FX.length)](() => setTimeout(next, 40 + Math.random()*130));
  })();
}

// ─── PAGER (swipe between eyes & clock) ──────────────────────────────────────
const pager = document.getElementById('pager');
const dots  = Array.from(document.querySelectorAll('#dots .dot'));
const PAGES = 3;
let pageIndex = 1;               // [0]=clock, [1]=eyes (default), [2]=music
let gx = 0, gy = 0, gt = 0, gMode = null;
let lastTap = 0, touchReset = null, longPress = null;
let swiping = false, swipeClearT = null;   // pause heavy glow anims while sliding

const pageW = () => window.innerWidth;
function updateDots() { dots.forEach((d, i) => d.classList.toggle('on', i === pageIndex)); }
function updatePageClass() {
  document.body.classList.toggle('page-clock', pageIndex === 0);
  document.body.classList.toggle('page-eyes',  pageIndex === 1);
  document.body.classList.toggle('page-music', pageIndex === 2);
}
function setSwiping(v) {
  if (swiping === v) return;
  swiping = v;
  document.body.classList.toggle('swiping', v);
}
function snapTo(i) {
  const target = Math.max(0, Math.min(PAGES - 1, i));
  if (target !== pageIndex) SFX.swoosh();
  pageIndex = target;
  setSwiping(true);
  pager.style.transition = 'transform 0.38s cubic-bezier(0.22,0.61,0.36,1)';
  pager.style.transform  = `translateX(${-pageIndex * pageW()}px)`;
  updateDots();
  updatePageClass();
  clearTimeout(swipeClearT);
  swipeClearT = setTimeout(() => setSwiping(false), 430);  // > transition duration
}
function dragTo(px) {
  pager.style.transition = 'none';
  pager.style.transform  = `translateX(${px}px)`;
}

function lookAt(cx, cy) {
  const mx = window.innerWidth / 2, my = window.innerHeight / 2;
  gazeTgt.x = Math.max(-MAX_X, Math.min(MAX_X, (cx - mx) * 0.09));
  gazeTgt.y = Math.max(-MAX_Y, Math.min(MAX_Y, (cy - my) * 0.09));
}

document.addEventListener('pointerdown', e => {
  lastInteraction = performance.now();
  if (asleep) wake();
  if (e.target.closest('#portrait-msg') || e.target.closest('#dots') ||
      e.target.closest('#mute') || e.target.closest('.music-controls') ||
      e.target.closest('#palette') || e.target.closest('#swatches')) return;
  pointerDown = true;
  gx = e.clientX; gy = e.clientY; gt = Date.now(); gMode = null;
  longPress = setTimeout(() => {              // long-press → wink (eyes page only)
    if (pointerDown && gMode !== 'swipe' && pageIndex === 1)
      winkOne(e.clientX < window.innerWidth / 2 ? innerL : innerR);
  }, 600);
});

document.addEventListener('pointermove', e => {
  if (!pointerDown) return;
  const dx = e.clientX - gx, dy = e.clientY - gy;
  if (gMode === null) {
    if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy)) { gMode = 'swipe'; clearTimeout(longPress); }
    else if (Math.abs(dx) > 6 || Math.abs(dy) > 6) gMode = 'look';
  }
  if (gMode === 'swipe') {
    setSwiping(true);
    let off = -pageIndex * pageW() + dx;
    const min = -(PAGES - 1) * pageW(), max = 0;
    if (off > max) off = max + (off - max) * 0.35;   // rubber-band edges
    if (off < min) off = min + (off - min) * 0.35;
    dragTo(off);
  } else if (gMode === 'look' && pageIndex === 1) {
    lookAt(e.clientX, e.clientY);
  }
});

function endPointer(e) {
  if (!pointerDown) return;
  pointerDown = false;
  clearTimeout(longPress);
  const dx = e.clientX - gx, dy = e.clientY - gy, dt = Date.now() - gt;

  if (gMode === 'swipe') {
    const thresh = pageW() * 0.22, fast = Math.abs(dx) > 60 && dt < 320;
    if (dx < 0 && (dx < -thresh || fast))      snapTo(pageIndex + 1);  // swipe left → eyes/next
    else if (dx > 0 && (dx > thresh || fast))  snapTo(pageIndex - 1);  // swipe right → clock
    else                                       snapTo(pageIndex);
    return;
  }
  if (pageIndex !== 1) return;                 // taps only matter on the eyes page

  if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {                 // TAP
    const now = Date.now();
    if (now - lastTap < 340) {                                  // double-tap → SURPRISED
      lastTap = 0;
      SFX.surprised();
      spawnRipple(e.clientX, e.clientY);
      applyMood('SURPRISED'); squish();
      clearTimeout(touchReset);
      touchReset = setTimeout(() => applyMood('DEFAULT', { scheduleNext: true }), 2500);
    } else {                                                    // single tap → look + HAPPY
      lastTap = now;
      SFX.tapS();
      SFX.rippleS();
      spawnRipple(e.clientX, e.clientY);
      lookAt(e.clientX, e.clientY);          // glide toward the tap (no instant snap)
      squish(); applyMood('HAPPY');
      clearTimeout(touchReset);
      touchReset = setTimeout(() => applyMood('DEFAULT', { scheduleNext: true }), 4500);
    }
  } else {                                                      // was a look-drag
    setTimeout(() => blink(60, 0, 120), 80);
    clearTimeout(touchReset);
    touchReset = setTimeout(() => applyMood('DEFAULT', { scheduleNext: true }), 4500);
  }
}
document.addEventListener('pointerup', endPointer);
document.addEventListener('pointercancel', endPointer);

document.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft')  snapTo(pageIndex - 1);
  if (e.key === 'ArrowRight') snapTo(pageIndex + 1);
});

// ── Block iOS Safari double-tap-to-zoom and pinch-zoom ──
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - lastTouchEnd <= 350) e.preventDefault();   // 2nd quick tap → no zoom
  lastTouchEnd = now;
}, { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());   // no pinch zoom
document.addEventListener('dblclick', (e) => e.preventDefault());
dots.forEach((d, i) => d.addEventListener('click', () => snapTo(i)));
window.addEventListener('resize', () => dragTo(-pageIndex * pageW()));

// ─── AUDIO UNLOCK + MUTE TOGGLE ──────────────────────────────────────────────
const muteBtn = document.getElementById('mute');
const ICON_SOUND_ON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>';
const ICON_SOUND_OFF =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M11 5 6 9H2v6h4l5 4z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>';
function updateMuteIcon() {
  muteBtn.innerHTML = SFX.muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
  muteBtn.classList.toggle('muted', SFX.muted);
}
function unlockAudio() {
  SFX.init();
  SFX.resume();
  if (!SFX._booted) { SFX._booted = true; SFX.boot(); }
}
document.addEventListener('pointerdown', unlockAudio);
document.addEventListener('keydown', unlockAudio);

muteBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  SFX.init(); SFX.resume();
  SFX.muted = !SFX.muted;
  try { localStorage.setItem('roboMuted', SFX.muted ? '1' : '0'); } catch (err) {}
  updateMuteIcon();
  if (!SFX.muted) SFX.tapS();
});
updateMuteIcon();

// ─── COLOR PALETTE ───────────────────────────────────────────────────────────
const paletteBtn = document.getElementById('palette');
const swatchEls  = Array.from(document.querySelectorAll('.sw'));

function applyColor(col, glow, save = true) {
  document.documentElement.style.setProperty('--col', col);
  document.documentElement.style.setProperty('--glow', glow);
  swatchEls.forEach(s => s.classList.toggle('active', s.dataset.col.toLowerCase() === col.toLowerCase()));
  if (save) { try { localStorage.setItem('roboColor', JSON.stringify({ col, glow })); } catch (e) {} }
}

paletteBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  document.body.classList.toggle('palette-open');
});
swatchEls.forEach(s => s.addEventListener('click', (e) => {
  e.stopPropagation();
  applyColor(s.dataset.col, s.dataset.glow);
  document.body.classList.remove('palette-open');
  SFX.tapS();
}));
// close the palette when tapping elsewhere
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#palette') && !e.target.closest('#swatches'))
    document.body.classList.remove('palette-open');
});

// restore saved color (default white)
try {
  const saved = JSON.parse(localStorage.getItem('roboColor'));
  if (saved && saved.col) applyColor(saved.col, saved.glow, false);
  else applyColor('#ffffff', '255,255,255', false);
} catch (e) { applyColor('#ffffff', '255,255,255', false); }

// ─── CLOCK (Bangkok · GMT+7) ─────────────────────────────────────────────────
const clH = document.getElementById('cl-h');
const clM = document.getElementById('cl-m');
const clS = document.getElementById('cl-s');
const clDate = document.getElementById('cl-date');
const colonEl = document.querySelector('.clock-time .colon');

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const dateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Bangkok', weekday: 'long', day: 'numeric', month: 'long',
});

let prevH = '', prevM = '';
function flipDigit(el, val) {
  el.textContent = val;
  el.classList.remove('flip');
  void el.offsetWidth;          // restart the animation
  el.classList.add('flip');
}

function updateClock() {
  if (swiping) return;   // don't repaint the glowing text mid-slide
  const now = new Date();
  const p = {};
  for (const part of timeFmt.formatToParts(now)) p[part.type] = part.value;
  const hour = p.hour === '24' ? '00' : p.hour;   // guard against 24:00 edge

  if (hour !== prevH)   { flipDigit(clH, hour);   prevH = hour; }   else clH.textContent = hour;
  if (p.minute !== prevM) { flipDigit(clM, p.minute); prevM = p.minute; } else clM.textContent = p.minute;
  clS.textContent = p.second;
  clDate.textContent = dateFmt.format(now);

  if (colonEl) colonEl.style.opacity = (parseInt(p.second, 10) % 2) ? '0.85' : '0.22';   // tick blink
}

// ─── MUSIC (play a file in-app, eyes react to it) ────────────────────────────
const mtitle = document.getElementById('mtitle');
const mload  = document.getElementById('m-load');
const mplay  = document.getElementById('m-play');
const mfile  = document.getElementById('m-file');
const viz    = document.getElementById('viz');

// Build visualizer bars
const VIZ_BARS = 28;
for (let i = 0; i < VIZ_BARS; i++) {
  const b = document.createElement('div');
  b.className = 'bar';
  viz.appendChild(b);
}
const vizBars = Array.from(viz.children);

const MUSIC = {
  el: null, src: null, analyser: null, data: null, url: null,
  playing: false, level: 0, bass: 0, bassAvg: 0, beatEnv: 0, lastBeat: 0,

  ensure() {
    SFX.init(); SFX.resume();
    if (!SFX.ctx) return false;
    if (!this.el) {
      this.el = new Audio();
      this.el.addEventListener('ended', () => { this.playing = false; this._sync(); });
    }
    if (!this.analyser) {
      this.analyser = SFX.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;
      this.data = new Uint8Array(this.analyser.frequencyBinCount);
      this.src  = SFX.ctx.createMediaElementSource(this.el);
      this.src.connect(this.analyser);
      this.analyser.connect(SFX.ctx.destination);
    }
    return true;
  },
  load(file) {
    if (!this.ensure()) return;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(file);
    this.el.src = this.url;
    mtitle.textContent = file.name.replace(/\.[^.]+$/, '');
    mplay.disabled = false;
    this.play();
  },
  play() {
    if (!this.ensure() || !this.el.src) return;
    SFX.resume();
    this.el.play().then(() => { this.playing = true; this._sync(); }).catch(() => {});
  },
  pause() {
    if (this.el) this.el.pause();
    this.playing = false;
    beat = 1;
    this._sync();
  },
  toggle() { this.playing ? this.pause() : this.play(); },
  _sync() {
    mplay.textContent = this.playing ? '❚❚' : '▶';   // ❚❚ / ▶
    document.body.classList.toggle('music-on', this.playing);
  },
  update() {
    if (!this.analyser || !this.playing) {
      this.level += (0 - this.level) * 0.1;
      this.beatEnv *= 0.85;
      return;
    }
    this.analyser.getByteFrequencyData(this.data);

    let sum = 0;
    for (let i = 0; i < this.data.length; i++) sum += this.data[i];
    const lvl = sum / this.data.length / 255;
    this.level += (lvl - this.level) * 0.25;

    let b = 0;
    for (let i = 1; i <= 6; i++) b += this.data[i];
    this.bass = b / 6 / 255;
    this.bassAvg += (this.bass - this.bassAvg) * 0.1;

    const now = performance.now();
    if (this.bass > this.bassAvg * 1.3 && this.bass > 0.22 && now - this.lastBeat > 230) {
      this.lastBeat = now;
      this.beatEnv = 1;
    }
    this.beatEnv *= 0.86;

    if (pageIndex === 2) this._drawBars();
  },
  _drawBars() {
    const step = Math.floor(this.data.length / vizBars.length);
    for (let i = 0; i < vizBars.length; i++) {
      let v = 0;
      for (let j = 0; j < step; j++) v += this.data[i * step + j];
      v = v / step / 255;
      vizBars[i].style.height = (6 + v * 94) + '%';
    }
  },
};

mload.addEventListener('click', (e) => { e.stopPropagation(); mfile.click(); });
mplay.addEventListener('click', (e) => { e.stopPropagation(); MUSIC.toggle(); });
mfile.addEventListener('change', (e) => { if (e.target.files[0]) MUSIC.load(e.target.files[0]); });

// ─── BOOT ────────────────────────────────────────────────────────────────────
applyMood('DEFAULT');
bootSequence();                 // power-on the eyes (CRT turn-on)
animLoop();
scheduleBlink();
idleDrift();
setTimeout(microSaccade, 1500 + Math.random()*1000);
setTimeout(scheduleMoodChange, 8000);
setTimeout(idleAct, 4000 + Math.random()*3000);
setTimeout(checkSleep, 5000);
buildStars();

updateClock();
setInterval(updateClock, 1000);
dragTo(-pageIndex * pageW());   // position on the eyes page without animating
updateDots();
updatePageClass();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
