import * as THREE from 'three';
import { io } from 'socket.io-client';

// Backend URL. Defaults to the local dev server; set VITE_SERVER_URL to point elsewhere.
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3000';

// Matches the server tick; sending every mousemove would flood the socket.
const INPUT_HZ = 30;

// How far render values close the gap to the authoritative ones each frame.
const LERP_AMOUNT = 0.3;

// --- Camera -----------------------------------------------------------------
// The camera sits back and above. It pulls back only slightly as the shark
// grows, so a big shark looks big and never gets a god-view of the arena.
const CAMERA_REFERENCE_RADIUS = 20;
const CAMERA_HEIGHT = 280;
const CAMERA_BACK = 280;
const CAMERA_FOV = 50;

// Pull-back per unit of growth past the reference radius, and its ceiling.
const CAMERA_GROWTH_DAMPING = 0.22;
const CAMERA_MAX_SCALE = 1.85;

// --- World ------------------------------------------------------------------
const VOID_COLOR = 0x041e34; // deep ocean abyss, beyond the arena
const FLOOR_COLOR = 0x073b5e; // rich marine blue
const GRID_COLOR = 0x136da3; // aqua grid lines
const WALL_COLOR = 0xff2244; // lethal, so it reads as a hazard
// The border is a flat, thick red line on the floor rather than a tall wall.
const WALL_HEIGHT = 2;
const WALL_THICKNESS = 24;
const GRID_DIVISIONS = 20;
const FOOD_HEIGHT = 7;

// Sharks float this many radii above the floor. The plump body hangs about
// 0.49 radii below its centre, so this keeps the belly off the water.
const SHARK_FLOAT = 0.55;

// Rising ambient bubbles, all drawn by one InstancedMesh.
const BUBBLE_COUNT = 160;
const BUBBLE_MIN_Y = 5;
const BUBBLE_MAX_Y = 240;

// Minimap backing size, in canvas pixels.
const MINIMAP_SIZE = 150;

// A shark under the starting score is visibly frail: its radius is clamped up
// to MIN_RADIUS so it looks full size, and without this cue being eaten by
// something apparently your own size reads as a bug.
const WEAK_SCORE = 10;
const WEAK_OPACITY = 0.4;

// Tail animation. Frequency is radians per millisecond; dashing doubles it.
const WAG_FREQUENCY = 0.01;
const TAIL_MAX_ANGLE = 0.5;

// Death cinematic.
const CINEMATIC_FADE_MS = 3000;
const CINEMATIC_MAX_FADE = 0.85;
const CINEMATIC_TITLE_MS = 800;
const CINEMATIC_TOTAL_MS = 3500;

// --- DOM --------------------------------------------------------------------
const canvas = document.querySelector('#game');
const lobby = document.querySelector('#lobby');
const lobbyPanel = document.querySelector('#lobby-panel');
const lobbyMessage = document.querySelector('#lobby-message');
const nameInput = document.querySelector('#nickname');
const colorInput = document.querySelector('#sharkColorInput');
const colorPickerBtn = document.querySelector('#colorPickerBtn');
const colorSwatch = document.querySelector('#colorSwatch');
const colorPopover = document.querySelector('#colorPopover');
const closeColorPopoverBtn = document.querySelector('#closeColorPopoverBtn');
const swatchButtons = [...colorPopover.querySelectorAll('.swatch')];
const lobbyBgmBtn = document.querySelector('#lobbyBgmBtn');
const lobbySfxBtn = document.querySelector('#lobbySfxBtn');
const hudAudioControls = document.querySelector('#hudAudioControls');
const hudBgmBtn = document.querySelector('#hudBgmBtn');
const hudSfxBtn = document.querySelector('#hudSfxBtn');
const playButton = document.querySelector('#play');
const nameplateLayer = document.querySelector('#nameplates');
const leaderboardEl = document.querySelector('#leaderboard');
const leaderboardRows = document.querySelector('#leaderboard-rows');
const statsEl = document.querySelector('#stats');
const statSize = document.querySelector('#stat-size');
const statRank = document.querySelector('#stat-rank');
const gameoverEl = document.querySelector('#gameover');
const gameoverCause = document.querySelector('#gameover-cause');
const gameoverSize = document.querySelector('#gameover-size');

// --- Sound ------------------------------------------------------------------

// Everything is synthesised with Web Audio, so there are no asset files. The
// context can only start after a user gesture, so it is created lazily.
const SFX_HEARING_RANGE = 900;
const BGM_PREF_KEY = 'happyshark.bgm';
const SFX_PREF_KEY = 'happyshark.sfx';
const CHIME_NOTES = [261.6, 293.7, 329.6, 392.0, 440.0, 523.3];
const CHIME_INTERVAL_MS = 1800;

// Session-scoped: every new visit starts with music and sound on, and a toggle
// only sticks for the rest of that tab's session.
function loadAudioPref(key) {
  try {
    const value = sessionStorage.getItem(key);
    return value === null ? true : value === '1';
  } catch {
    return true;
  }
}

function saveAudioPref(key, enabled) {
  try {
    sessionStorage.setItem(key, enabled ? '1' : '0');
  } catch {
    /* storage is best effort */
  }
}

const SoundManager = (() => {
  let ctx = null;
  let bgmBus = null;
  let sfxBus = null;
  let noiseBuffer = null;
  // Whichever BGM is playing right now, as { mode, stop }.
  let bgm = null;
  let bgmMode = 'lobby';
  let dash = null;
  let dashActive = false;
  let lastBumpAt = 0;

  let bgmEnabled = loadAudioPref(BGM_PREF_KEY);
  let sfxEnabled = loadAudioPref(SFX_PREF_KEY);

  const running = () => ctx !== null && ctx.state === 'running';
  const sfxReady = () => sfxEnabled && running();

  function unlock() {
    if (!ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;

      ctx = new Ctx();
      const master = ctx.createGain();
      master.connect(ctx.destination);

      bgmBus = ctx.createGain();
      bgmBus.gain.value = bgmEnabled ? 1 : 0;
      bgmBus.connect(master);

      sfxBus = ctx.createGain();
      sfxBus.connect(master);

      // One second of white noise, reused by every noisy effect.
      noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

      ctx.onstatechange = syncBgm;
    }

    if (ctx.state === 'suspended') ctx.resume();
    syncBgm();
  }

  /** A pitched blip with a fast attack and an exponential decay. */
  function tone(type, from, to, duration, gain, delay = 0, dest = sfxBus) {
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.01, duration / 4));
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    osc.connect(env).connect(dest);
    osc.start(t);
    osc.stop(t + duration + 0.03);
  }

  /** A filtered burst of noise. */
  function noise(filterType, frequency, duration, gain, delay = 0) {
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = frequency;

    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    src.connect(filter).connect(env).connect(sfxBus);
    src.start(t);
    src.stop(t + duration + 0.03);
  }

  // --- Background music ---
  // Each starter builds its node graph and returns a function that tears it down.

  /** Lobby: a warm low-pass pad with a pentatonic chime every 1.8s. */
  function startLobbyBgm() {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 520;

    const gain = ctx.createGain();
    gain.gain.value = 0.035;
    filter.connect(gain).connect(bgmBus);

    const low = ctx.createOscillator();
    low.type = 'triangle';
    low.frequency.value = 110;
    const fifth = ctx.createOscillator();
    fifth.type = 'sine';
    fifth.frequency.value = 164.8;

    low.connect(filter);
    fifth.connect(filter);
    low.start();
    fifth.start();

    const chimeTimer = setInterval(pluckChime, CHIME_INTERVAL_MS);

    return () => {
      low.stop();
      fifth.stop();
      gain.disconnect();
      clearInterval(chimeTimer);
    };
  }

  /** In game: a slow underwater current rush plus sparse bubble blips. */
  function startGameBgm() {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.8;
    filter.frequency.value = 165;

    // A very slow LFO sweeps the band, which is what makes it read as a current.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.14;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 75;
    lfo.connect(lfoGain).connect(filter.frequency);

    const gain = ctx.createGain();
    gain.gain.value = 0.038;

    src.connect(filter).connect(gain).connect(bgmBus);
    src.start();
    lfo.start();

    let bubbleTimer = null;
    const scheduleBubbles = () => {
      bubbleTimer = setTimeout(() => {
        if (running()) {
          const count = 2 + Math.floor(Math.random() * 2);
          for (const offset of [0, 0.09, 0.19].slice(0, count)) {
            tone('sine', 260, 540, 0.06, 0.022, offset, bgmBus);
          }
        }
        scheduleBubbles();
      }, 1100 + Math.random() * 1100);
    };
    scheduleBubbles();

    return () => {
      src.stop();
      lfo.stop();
      gain.disconnect();
      clearTimeout(bubbleTimer);
    };
  }

  function pluckChime() {
    if (!running() || !bgmEnabled) return;

    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = CHIME_NOTES[Math.floor(Math.random() * CHIME_NOTES.length)];

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.045, t + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);

    osc.connect(env).connect(bgmBus);
    osc.start(t);
    osc.stop(t + 1.65);
  }

  /** Starts, stops or swaps the BGM so it matches the toggle and the mode. */
  function syncBgm() {
    if (!ctx) return;
    // Nodes may be built while the context is still resuming; they start
    // sounding the moment it runs, so there is no need to wait for 'running'.
    const wanted = bgmEnabled && ctx.state !== 'closed' ? bgmMode : null;

    bgmBus.gain.cancelScheduledValues(ctx.currentTime);
    bgmBus.gain.setValueAtTime(wanted ? 1 : 0, ctx.currentTime);

    if (bgm && bgm.mode === wanted) return;

    if (bgm) bgm.stop();
    bgm = null;

    if (wanted) {
      bgm = { mode: wanted, stop: wanted === 'game' ? startGameBgm() : startLobbyBgm() };
    }
  }

  function setBgmMode(mode) {
    bgmMode = mode === 'game' ? 'game' : 'lobby';
    syncBgm();
  }

  /**
   * Called synchronously from the Play gesture: creates/resumes the context
   * and builds the ocean soundscape inside the same user activation.
   */
  function startGameAudioImmediate() {
    unlock();
    setBgmMode('game');
  }

  // --- Dash whoosh ---

  function ensureDashLoop() {
    if (dash) return;

    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 850;
    filter.Q.value = 0.8;

    // A slow LFO swells the whoosh in time with the tail beats.
    const pulse = ctx.createGain();
    pulse.gain.value = 0.65;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 6;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.35;
    lfo.connect(lfoDepth).connect(pulse.gain);

    const level = ctx.createGain();
    level.gain.value = 0;

    src.connect(filter).connect(pulse).connect(level).connect(sfxBus);
    src.start();
    lfo.start();

    dash = { level };
  }

  function setDashLoop(active) {
    const next = active && sfxReady();
    if (next === dashActive) return;
    dashActive = next;

    if (!running()) return;
    ensureDashLoop();
    dash.level.gain.setTargetAtTime(next ? 0.09 : 0, ctx.currentTime, 0.08);
  }

  // --- SFX ---

  function playClick() {
    if (!sfxReady()) return;
    tone('sine', 520, 780, 0.08, 0.08);
  }

  function playEatPellet() {
    if (!sfxReady()) return;
    const v = 1 + (Math.random() - 0.5) * 0.2;
    tone('sine', 380 * v, 680 * v, 0.09, 0.09);
  }

  function playEatFish() {
    if (!sfxReady()) return;
    tone('sine', 520, 520, 0.12, 0.14);
    tone('sine', 780, 780, 0.16, 0.14, 0.06);
    noise('highpass', 3200, 0.06, 0.06);
  }

  function playBump() {
    if (!sfxReady()) return;
    const now = performance.now();
    if (now - lastBumpAt < 180) return;
    lastBumpAt = now;

    tone('triangle', 130, 48, 0.14, 0.16);
    noise('lowpass', 900, 0.12, 0.08);
  }

  function playChomp() {
    if (!sfxReady()) return;
    tone('triangle', 220, 55, 0.22, 0.22);
    tone('sine', 440, 660, 0.16, 0.12, 0.06);
  }

  function playDeath() {
    if (!sfxReady()) return;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(32, t + 0.9);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1400, t);
    filter.frequency.exponentialRampToValueAtTime(120, t + 0.9);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.25, t + 0.03);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);

    osc.connect(filter).connect(env).connect(sfxBus);
    osc.start(t);
    osc.stop(t + 0.95);
  }

  // --- Toggles ---

  function syncButtons() {
    lobbyBgmBtn.textContent = `🎵 BGM: ${bgmEnabled ? 'ON' : 'OFF'}`;
    lobbySfxBtn.textContent = `${sfxEnabled ? '🔊' : '🔇'} SFX: ${sfxEnabled ? 'ON' : 'OFF'}`;
    lobbyBgmBtn.classList.toggle('off', !bgmEnabled);
    lobbySfxBtn.classList.toggle('off', !sfxEnabled);

    hudBgmBtn.classList.toggle('off', !bgmEnabled);
    hudSfxBtn.textContent = sfxEnabled ? '🔊' : '🔇';
    hudSfxBtn.classList.toggle('off', !sfxEnabled);

    for (const btn of [lobbyBgmBtn, hudBgmBtn]) btn.setAttribute('aria-pressed', String(bgmEnabled));
    for (const btn of [lobbySfxBtn, hudSfxBtn]) btn.setAttribute('aria-pressed', String(sfxEnabled));
  }

  function toggleBgm() {
    bgmEnabled = !bgmEnabled;
    saveAudioPref(BGM_PREF_KEY, bgmEnabled);
    syncBgm();
    syncButtons();
  }

  function toggleSfx() {
    sfxEnabled = !sfxEnabled;
    saveAudioPref(SFX_PREF_KEY, sfxEnabled);
    if (!sfxEnabled) setDashLoop(false);
    syncButtons();
  }

  syncButtons();

  return {
    unlock,
    setBgmMode,
    startGameAudioImmediate,
    toggleBgm,
    toggleSfx,
    setDashLoop,
    playClick,
    playEatPellet,
    playEatFish,
    playBump,
    playChomp,
    playDeath,
  };
})();

// Browsers only let audio start from a user gesture.
window.addEventListener('pointerdown', SoundManager.unlock);
window.addEventListener('keydown', SoundManager.unlock);

for (const [btn, toggle] of [
  [lobbyBgmBtn, SoundManager.toggleBgm],
  [hudBgmBtn, SoundManager.toggleBgm],
  [lobbySfxBtn, SoundManager.toggleSfx],
  [hudSfxBtn, SoundManager.toggleSfx],
]) {
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggle();
    SoundManager.playClick();
    // Drop focus so Space keeps meaning "dash" rather than re-clicking this.
    btn.blur();
  });
}

// The window's mousedown handler starts a dash; HUD clicks must never reach it.
for (const btn of [hudBgmBtn, hudSfxBtn]) {
  btn.addEventListener('mousedown', (event) => event.stopPropagation());
}

// --- Three.js ---------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(VOID_COLOR, 1);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(VOID_COLOR, 2200, 9000);

const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 1, 30000);

scene.add(new THREE.AmbientLight(0x8be0ff, 1.5));

// Directional lights are infinitely distant, so only the direction matters:
// this one rakes across the water and gives the shark bodies a lit top and a
// shaded flank, which is what sells the 2.5D depth.
const sun = new THREE.DirectionalLight(0xfff7e8, 2.3);
sun.position.set(0.45, 1, 0.3);
scene.add(sun);

// Context loss would otherwise fail silently and leave a frozen picture.
canvas.addEventListener(
  'webglcontextlost',
  (event) => {
    event.preventDefault();
    console.error('[webgl] context lost');
  },
  false,
);
canvas.addEventListener('webglcontextrestored', () => console.warn('[webgl] context restored'));

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

resize();
window.addEventListener('resize', resize);

// --- Arena ------------------------------------------------------------------

/**
 * Server coordinates are a 2D plane; Three.js uses the horizontal XZ plane for
 * it, so server (x, y) maps to (x, 0, y) and height is free for the 2.5D look.
 */
let world = { width: 5000, height: 5000 };
let foodRadius = 5;

const arena = new THREE.Group();
scene.add(arena);

function buildArena() {
  // Rebuilt if the server ever reports different dimensions.
  for (const child of [...arena.children]) {
    arena.remove(child);
    child.geometry?.dispose();
    if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
    else child.material?.dispose();
  }

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(world.width, world.height),
    new THREE.MeshStandardMaterial({ color: FLOOR_COLOR, roughness: 0.85, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(world.width / 2, 0, world.height / 2);
  arena.add(floor);

  // The grid is what makes motion and perspective legible: under the tilted
  // camera a square grid reads as a receding parallelogram.
  const grid = new THREE.GridHelper(
    Math.max(world.width, world.height),
    GRID_DIVISIONS,
    GRID_COLOR,
    GRID_COLOR,
  );
  grid.position.set(world.width / 2, 0.8, world.height / 2);
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  arena.add(grid);

  // Four flat strips. Unlit, so the lethal boundary is the same crisp red
  // whatever the lighting does.
  const wallMaterial = new THREE.MeshBasicMaterial({ color: WALL_COLOR });

  const spans = [
    { w: world.width + WALL_THICKNESS * 2, d: WALL_THICKNESS, x: world.width / 2, z: 0 },
    { w: world.width + WALL_THICKNESS * 2, d: WALL_THICKNESS, x: world.width / 2, z: world.height },
    { w: WALL_THICKNESS, d: world.height, x: 0, z: world.height / 2 },
    { w: WALL_THICKNESS, d: world.height, x: world.width, z: world.height / 2 },
  ];

  for (const span of spans) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(span.w, WALL_HEIGHT, span.d), wallMaterial);
    wall.position.set(span.x, 1.0, span.z);
    arena.add(wall);
  }
}

buildArena();

// --- Food -------------------------------------------------------------------

// A single InstancedMesh replaces hundreds of individual Mesh objects, dropping
// food draw calls to 1. Capacity is pre-allocated; `count` tracks live pellets.
// Matches the server's FOOD_HARD_CAP so no pellet goes unrendered.
const FOOD_INSTANCE_CAPACITY = 1500;
const pelletGeometry = new THREE.SphereGeometry(1, 8, 6);
const pelletMaterial = new THREE.MeshStandardMaterial({
  roughness: 0.4,
  vertexColors: false,
});

const foodInstancedMesh = new THREE.InstancedMesh(
  pelletGeometry,
  pelletMaterial,
  FOOD_INSTANCE_CAPACITY,
);
foodInstancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
foodInstancedMesh.instanceColor = new THREE.InstancedBufferAttribute(
  new Float32Array(FOOD_INSTANCE_CAPACITY * 3),
  3,
);
foodInstancedMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
foodInstancedMesh.count = 0;
foodInstancedMesh.frustumCulled = false;
scene.add(foodInstancedMesh);

/**
 * Dried fish left behind by dead and bumped sharks. A flattened diamond body
 * (nose at +x) plus a forked tail fin, built as raw triangles with outward
 * winding so computeVertexNormals gives a faceted, jerky-like look.
 */
function buildFishGeometry() {
  const nose = [9, 0, 0];
  const back = [-7, 0, 0];
  // Ring around the widest point, ordered top, right, bottom, left.
  const ring = [
    [1, 1.8, 0],
    [1, 0, 4.5],
    [1, -1.8, 0],
    [1, 0, -4.5],
  ];

  const triangles = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    triangles.push(nose, a, b);
    triangles.push(back, b, a);
  }

  // Forked tail: two blades meeting at a notch, in the y = 0 plane.
  const root = [-6.5, 0, 0];
  const notch = [-10.5, 0, 0];
  triangles.push(root, [-13, 0, -5.5], notch);
  triangles.push(root, notch, [-13, 0, 5.5]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(triangles.flat(), 3));
  geo.computeVertexNormals();
  return geo;
}

const fishInstancedMesh = new THREE.InstancedMesh(
  buildFishGeometry(),
  // Double-sided so the flat tail fin reads from either side.
  new THREE.MeshStandardMaterial({
    color: 0xf5a642,
    roughness: 0.55,
    metalness: 0.1,
    side: THREE.DoubleSide,
  }),
  FOOD_INSTANCE_CAPACITY,
);
fishInstancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
fishInstancedMesh.count = 0;
fishInstancedMesh.frustumCulled = false;
scene.add(fishInstancedMesh);

// Retained for backward-compat with the dev handle; tracks nothing visual now.
const foodMeshes = new Map();

const _foodMatrix = new THREE.Matrix4();
const _foodColor = new THREE.Color();
const _foodScale = new THREE.Vector3();
const _fishPosition = new THREE.Vector3();
const _fishEuler = new THREE.Euler();
const _fishQuaternion = new THREE.Quaternion();
const _fishScale = new THREE.Vector3(1.15, 1.15, 1.15);

// Length of the pop-out arc for freshly dropped fish.
const FISH_POP_MS = 330;

// --- Shockwave rings --------------------------------------------------------

const SHOCKWAVE_MS = 340;
const shockwaveGeometry = new THREE.RingGeometry(8, 13, 32);
shockwaveGeometry.rotateX(-Math.PI / 2); // lie flat on the water
const shockwaves = [];

/** An expanding, fading ring at an impact point: blue for bumps, orange for kills. */
function spawnShockwave(x, y, color) {
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(shockwaveGeometry, material);
  mesh.position.set(x, 2.5, y);
  scene.add(mesh);
  shockwaves.push({ mesh, bornAt: performance.now() });
}

function updateShockwaves(now) {
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    const wave = shockwaves[i];
    const t = (now - wave.bornAt) / SHOCKWAVE_MS;

    if (t >= 1) {
      scene.remove(wave.mesh);
      wave.mesh.material.dispose();
      shockwaves.splice(i, 1);
      continue;
    }

    wave.mesh.scale.setScalar(1 + t * 5.5);
    wave.mesh.material.opacity = 0.75 * (1 - t);
  }
}

/** Rebuild every food instance from `localGameState.food`, split by kind. */
function syncFoodInstances(now) {
  const food = localGameState.food;
  let pellets = 0;
  let fish = 0;

  for (const item of food) {
    if (item.kind === 'fish') {
      if (fish >= FOOD_INSTANCE_CAPACITY) continue;

      let fx = item.x;
      let fz = item.y;
      let fy = 6 + Math.sin(now * 0.004 + item.x) * 1.5;

      // Pop-out: ease from the impact point to the landing spot along an arc.
      if (item.clientBornAt && now - item.clientBornAt < FISH_POP_MS) {
        const t = (now - item.clientBornAt) / FISH_POP_MS;
        const e = 1 - Math.pow(1 - t, 3);
        fx = item.originX + (item.x - item.originX) * e;
        fz = item.originY + (item.y - item.originY) * e;
        fy += Math.sin(t * Math.PI) * 32;
      }

      _fishPosition.set(fx, fy, fz);
      // YXZ: tilt about the fish's own X first, then spin it about Y.
      _fishEuler.set(0.25, item.rot || 0, 0, 'YXZ');
      _fishQuaternion.setFromEuler(_fishEuler);
      _foodMatrix.compose(_fishPosition, _fishQuaternion, _fishScale);
      fishInstancedMesh.setMatrixAt(fish, _foodMatrix);
      fish += 1;
    } else {
      if (pellets >= FOOD_INSTANCE_CAPACITY) continue;

      _foodMatrix.makeTranslation(item.x, FOOD_HEIGHT, item.y);
      _foodMatrix.scale(_foodScale.setScalar(foodRadius));
      foodInstancedMesh.setMatrixAt(pellets, _foodMatrix);

      _foodColor.set(item.color);
      foodInstancedMesh.setColorAt(pellets, _foodColor);
      pellets += 1;
    }
  }

  foodInstancedMesh.count = pellets;
  foodInstancedMesh.instanceMatrix.needsUpdate = true;
  if (foodInstancedMesh.instanceColor) foodInstancedMesh.instanceColor.needsUpdate = true;

  fishInstancedMesh.count = fish;
  fishInstancedMesh.instanceMatrix.needsUpdate = true;
}

// Legacy helpers kept thin — actual rendering now goes through syncFoodInstances.
function addPellet(_pellet) {}
function removePellet(_id) {}
function clearFood() {}

// --- Bubbles ----------------------------------------------------------------

const bubbleGeo = new THREE.SphereGeometry(1, 10, 8);
const bubbleMat = new THREE.MeshBasicMaterial({
  color: 0xb8f2ff,
  transparent: true,
  opacity: 0.28,
  depthWrite: false,
});
const bubbleInstancedMesh = new THREE.InstancedMesh(bubbleGeo, bubbleMat, BUBBLE_COUNT);
bubbleInstancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
bubbleInstancedMesh.frustumCulled = false;
scene.add(bubbleInstancedMesh);

const bubbles = Array.from({ length: BUBBLE_COUNT }, () => ({
  x: randomBetween(0, world.width),
  y: randomBetween(BUBBLE_MIN_Y, BUBBLE_MAX_Y),
  z: randomBetween(0, world.height),
  speed: randomBetween(12, 40),
  size: randomBetween(2, 6),
  phase: Math.random() * Math.PI * 2,
}));

const _bubbleMatrix = new THREE.Matrix4();

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function updateBubbles(now, dt) {
  for (let i = 0; i < BUBBLE_COUNT; i++) {
    const b = bubbles[i];
    b.y += b.speed * dt;
    if (b.y > BUBBLE_MAX_Y) b.y = BUBBLE_MIN_Y;

    const wobble = Math.sin(now * 0.002 + b.phase) * 6;
    _bubbleMatrix.makeScale(b.size, b.size, b.size);
    _bubbleMatrix.setPosition(b.x + wobble, b.y, b.z);
    bubbleInstancedMesh.setMatrixAt(i, _bubbleMatrix);
  }

  bubbleInstancedMesh.instanceMatrix.needsUpdate = true;
}

// --- Sharks -----------------------------------------------------------------

// Authored in units of the authoritative radius with the snout along +X, so
// scaling the group by `radius` sizes the model to its hitbox. Geometries are
// shared by every shark, including the lobby preview.
const bodyGeometry = new THREE.SphereGeometry(1, 32, 24);
bodyGeometry.scale(0.72, 0.48, 0.52); // plump, smooth chubby body

const snoutGeometry = new THREE.SphereGeometry(1, 24, 18);
snoutGeometry.scale(0.45, 0.36, 0.44); // rounded cute nose

const bellyGeometry = new THREE.SphereGeometry(1, 28, 20);
bellyGeometry.scale(0.64, 0.34, 0.46); // soft cream belly

const dorsalGeometry = new THREE.ConeGeometry(0.24, 0.52, 20);
dorsalGeometry.scale(1.15, 1, 0.28); // smooth rounded dorsal fin

const pectoralGeometry = new THREE.SphereGeometry(1, 18, 14);
pectoralGeometry.scale(0.22, 0.07, 0.42); // smooth paddle fin

const peduncleGeometry = new THREE.SphereGeometry(1, 20, 16);
peduncleGeometry.scale(0.36, 0.22, 0.24);

const flukeGeometry = new THREE.SphereGeometry(1, 18, 14);
flukeGeometry.scale(0.18, 0.42, 0.08); // smooth rounded tail fin lobes

const eyeGeometry = new THREE.SphereGeometry(0.105, 16, 14);
const pupilHighlightGeometry = new THREE.SphereGeometry(0.042, 12, 10);
const blushGeometry = new THREE.SphereGeometry(0.08, 12, 10);
blushGeometry.scale(0.9, 0.55, 0.35);

const sharks = new Map();

/**
 * Builds one procedural shark. The tail lives on its own pivot so it can be
 * swung without touching the body, and every material is owned by this shark
 * so colour and opacity can be set per player.
 */
function buildSharkRig(colorHex) {
  const group = new THREE.Group();

  const skin = new THREE.MeshStandardMaterial({
    color: new THREE.Color(colorHex),
    roughness: 0.38,
    metalness: 0.05,
  });
  const bellyMat = new THREE.MeshStandardMaterial({ color: 0xf4f9ff, roughness: 0.5 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111622, roughness: 0.1 });
  const highlightMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const blushMat = new THREE.MeshBasicMaterial({ color: 0xff8da6 });

  const body = new THREE.Mesh(bodyGeometry, skin);
  group.add(body);

  const snout = new THREE.Mesh(snoutGeometry, skin);
  snout.position.set(0.36, -0.02, 0);
  group.add(snout);

  const belly = new THREE.Mesh(bellyGeometry, bellyMat);
  belly.position.set(0.06, -0.15, 0);
  group.add(belly);

  const dorsal = new THREE.Mesh(dorsalGeometry, skin);
  dorsal.position.set(-0.04, 0.48, 0);
  dorsal.rotation.z = 0.28; // leans back
  group.add(dorsal);

  for (const side of [1, -1]) {
    // Pectoral fins: a pivot carries the sweep, the paddle points outward.
    const pivot = new THREE.Group();
    pivot.position.set(0.08, -0.14, side * 0.34);
    pivot.rotation.y = -0.35 * side;
    pivot.rotation.x = 0.25 * side;

    const fin = new THREE.Mesh(pectoralGeometry, skin);
    fin.position.set(0, 0, side * 0.22);
    pivot.add(fin);
    group.add(pivot);

    const eye = new THREE.Mesh(eyeGeometry, eyeMat);
    eye.position.set(0.48, 0.12, side * 0.37);
    group.add(eye);

    const highlight = new THREE.Mesh(pupilHighlightGeometry, highlightMat);
    highlight.position.set(0.56, 0.16, side * 0.4);
    group.add(highlight);

    const blush = new THREE.Mesh(blushGeometry, blushMat);
    blush.position.set(0.38, -0.03, side * 0.44);
    group.add(blush);
  }

  // Tail pivot at the back of the body: rotating this about Y is the wag.
  const tail = new THREE.Group();
  tail.position.x = -0.58;

  const peduncle = new THREE.Mesh(peduncleGeometry, skin);
  peduncle.position.set(-0.12, 0, 0);
  tail.add(peduncle);

  const upperFluke = new THREE.Mesh(flukeGeometry, skin);
  upperFluke.position.set(-0.34, 0.22, 0);
  upperFluke.rotation.z = 0.48;
  tail.add(upperFluke);

  const lowerFluke = new THREE.Mesh(flukeGeometry, skin);
  lowerFluke.position.set(-0.32, -0.18, 0);
  lowerFluke.rotation.z = -0.52;
  tail.add(lowerFluke);

  group.add(tail);

  return {
    group,
    tail,
    skinMaterial: skin,
    materials: [skin, bellyMat, eyeMat, highlightMat, blushMat],
  };
}

function createShark(player) {
  const rig = buildSharkRig(player.color);
  scene.add(rig.group);

  // Nameplate reads "Name [size]": white name, gold size.
  const plate = document.createElement('span');
  const plateName = document.createElement('span');
  const plateScore = document.createElement('span');
  plateScore.className = 'score';
  plate.append(plateName, ' ', plateScore);
  nameplateLayer.append(plate);

  return {
    ...rig,
    plate,
    plateName,
    plateScore,
    lastDisplayedName: null,
    lastDisplayedScore: null,
    weak: null,
  };
}

function removeShark(id) {
  const shark = sharks.get(id);
  if (!shark) return;

  scene.remove(shark.group);
  shark.materials.forEach((m) => m.dispose());
  shark.plate.remove();
  sharks.delete(id);
}

function clearSharks() {
  for (const id of [...sharks.keys()]) removeShark(id);
}

// --- Lobby preview ----------------------------------------------------------

// A second, tiny renderer that shows the player's shark in their chosen colour.
const previewCanvas = document.querySelector('#lobbyPreviewCanvas');
const previewRenderer = new THREE.WebGLRenderer({
  canvas: previewCanvas,
  alpha: true,
  antialias: true,
});
previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
previewRenderer.setSize(240, 145, false);
previewRenderer.setClearColor(0x000000, 0);

const previewScene = new THREE.Scene();
const previewCamera = new THREE.PerspectiveCamera(38, 240 / 145, 0.1, 100);
previewCamera.position.set(0, 0.45, 3.2);
previewCamera.lookAt(0, 0, 0);

previewScene.add(new THREE.AmbientLight(0x8be0ff, 1.4));
const previewSun = new THREE.DirectionalLight(0xfff7e8, 2.3);
previewSun.position.set(2, 3, 2);
previewScene.add(previewSun);

const previewShark = buildSharkRig(colorInput.value);
previewScene.add(previewShark.group);

/** One place that keeps the input, the trigger swatch and the preview in sync. */
function applySharkColor(hex) {
  colorInput.value = hex;
  colorSwatch.style.background = hex;
  previewShark.skinMaterial.color.set(hex);
  for (const btn of swatchButtons) {
    btn.classList.toggle('selected', btn.dataset.color === hex.toLowerCase());
  }
}

function setColorPopoverOpen(open) {
  colorPopover.hidden = !open;
  colorPickerBtn.setAttribute('aria-expanded', String(open));
}

applySharkColor(colorInput.value);
setColorPopoverOpen(false);

colorPickerBtn.addEventListener('click', () => {
  SoundManager.playClick();
  setColorPopoverOpen(colorPopover.hidden);
});

for (const btn of swatchButtons) {
  btn.addEventListener('click', () => {
    SoundManager.playClick();
    applySharkColor(btn.dataset.color);
  });
}

colorInput.addEventListener('input', () => applySharkColor(colorInput.value));

closeColorPopoverBtn.addEventListener('click', () => {
  SoundManager.playClick();
  setColorPopoverOpen(false);
});

// Clicking anywhere outside the popover (other than its trigger) closes it.
document.addEventListener('mousedown', (event) => {
  if (colorPopover.hidden) return;
  if (colorPopover.contains(event.target) || colorPickerBtn.contains(event.target)) return;
  setColorPopoverOpen(false);
});

function renderLobbyPreview(now) {
  previewShark.group.rotation.y = Math.sin(now * 0.0012) * 0.45 - 0.6;
  previewShark.group.position.y = Math.sin(now * 0.003) * 0.08;
  previewShark.tail.rotation.y = Math.sin(now * 0.012) * 0.45;
  previewRenderer.render(previewScene, previewCamera);
}

// --- Minimap ----------------------------------------------------------------

const minimapCanvas = document.querySelector('#minimapCanvas');
const minimapCtx = minimapCanvas.getContext('2d');
let gameHudVisible = false;

/** Minimap and audio HUD appear together while alive in a game. */
function setGameHudVisible(visible) {
  if (gameHudVisible === visible) return;
  gameHudVisible = visible;
  minimapCanvas.style.display = visible ? 'block' : 'none';
  hudAudioControls.style.display = visible ? 'flex' : 'none';
  refreshTouchHud();
}

/** The dash button shows only in game on touch devices; the joystick hides with it. */
function refreshTouchHud() {
  mobileDashBtn.style.display = gameHudVisible && isTouchDevice ? 'block' : 'none';
  if (!gameHudVisible) {
    steerTouchId = null;
    hideJoystick();
  }
}

function drawMinimap(now) {
  const size = MINIMAP_SIZE;
  const half = size / 2;
  minimapCtx.clearRect(0, 0, size, size);

  minimapCtx.strokeStyle = 'rgba(140, 210, 255, 0.18)';
  minimapCtx.lineWidth = 1;
  minimapCtx.beginPath();
  minimapCtx.moveTo(half, 0);
  minimapCtx.lineTo(half, size);
  minimapCtx.moveTo(0, half);
  minimapCtx.lineTo(size, half);
  minimapCtx.stroke();

  let me = null;

  minimapCtx.fillStyle = '#ffffff';
  for (const p of Object.values(localGameState.players)) {
    if (p.id === myId) {
      me = p;
      continue;
    }
    minimapCtx.beginPath();
    minimapCtx.arc((p.x / world.width) * size, (p.y / world.height) * size, 2.5, 0, Math.PI * 2);
    minimapCtx.fill();
  }

  // Drawn last so other dots never cover it.
  if (me) {
    const mx = (me.x / world.width) * size;
    const my = (me.y / world.height) * size;
    const pulse = 6.5 + Math.sin(now * 0.006) * 1.2;

    minimapCtx.fillStyle = 'rgba(255, 60, 90, 0.45)';
    minimapCtx.beginPath();
    minimapCtx.arc(mx, my, pulse, 0, Math.PI * 2);
    minimapCtx.fill();

    minimapCtx.fillStyle = '#ff2a4b';
    minimapCtx.beginPath();
    minimapCtx.arc(mx, my, 4, 0, Math.PI * 2);
    minimapCtx.fill();
  }
}

// --- Game state -------------------------------------------------------------

let localGameState = { players: {}, food: [] };
let myId = null;
let playing = false;

// Set when we die; drives the fade-to-black cinematic and then the lobby.
let gameOver = null;
let endingSession = false;

// Smoothed values actually drawn. The server speaks at 30Hz but we draw at
// 60fps, so these chase the authoritative ones each frame.
const renderState = { players: {} };

// The camera that was in force on the last living frame. The cinematic keeps
// using it, since the shark it was following no longer exists.
let lastCamera = null;

function formatDuration(sec = 0) {
  const s = Math.max(1, Math.floor(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

/** " · Survived 1m 24s", or nothing if an older server didn't send the time. */
function survivedSuffix(info) {
  return Number.isFinite(info.survivalTime) ? ` · Survived ${formatDuration(info.survivalTime)}` : '';
}

function deathHeadline(info) {
  const base =
    info.cause === 'wall'
      ? `You hit the wall at size ${info.score}`
      : `Eaten by ${info.eatenByName ?? 'a bigger shark'} at size ${info.score}`;
  return `${base}${survivedSuffix(info)}`;
}

const socket = io(SERVER_URL);

// --- Lobby ------------------------------------------------------------------

function showLobby(message) {
  lobbyMessage.textContent = message ?? '';
  lobby.hidden = false;
  leaderboardEl.hidden = true;
  statsEl.hidden = true;
  nameplateLayer.replaceChildren();

  try {
    nameInput.focus();
  } catch {
    /* focus is best effort */
  }
}

lobbyPanel.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!socket.connected) return;

  SoundManager.startGameAudioImmediate();
  SoundManager.playClick();
  setColorPopoverOpen(false);
  lastSentAngle = null;
  touchSteerAngle = null;
  playing = true;
  gameOver = null;
  lastCamera = null;
  lobby.hidden = true;
  lobbyMessage.textContent = '';
  gameoverEl.hidden = true;
  clearSharks();
  renderState.players = {};

  socket.emit('joinGame', { name: nameInput.value, color: colorInput.value });
});

// --- Networking -------------------------------------------------------------

socket.on('connect', () => {
  playButton.disabled = false;
});

socket.on(
  'welcome',
  ({ message, socketId, world: serverWorld, foodRadius: serverFoodRadius, food }) => {
    myId = socketId;
    if (serverFoodRadius) foodRadius = serverFoodRadius;

    if (serverWorld && (serverWorld.width !== world.width || serverWorld.height !== world.height)) {
      world = serverWorld;
      buildArena();
    }

    // Full pool, sent once. Replacing wholesale also makes reconnects self-heal.
    localGameState.food = food ?? [];
    clearFood();
    localGameState.food.forEach(addPellet);

    console.log(`[socket] ${message} (id: ${socketId}, ${localGameState.food.length} pellets)`);
  },
);

socket.on('stateUpdate', (state) => {
  localGameState.players = state.players;
});

socket.on('foodUpdate', ({ eatenIds, newFood }) => {
  if (eatenIds?.length) {
    const gone = new Set(eatenIds);
    localGameState.food = localGameState.food.filter((pellet) => !gone.has(pellet.id));
    eatenIds.forEach(removePellet);
  }

  if (newFood?.length) {
    // Popped fish animate from their origin; the welcome pool never does.
    const bornAt = performance.now();
    for (const item of newFood) {
      if (item.originX !== undefined) item.clientBornAt = bornAt;
    }
    localGameState.food.push(...newFood);
    newFood.forEach(addPellet);
  }
});

// Batched per server tick. Nearby positional sounds only; death is ours alone.
socket.on('sfx', (events) => {
  if (!Array.isArray(events)) return;

  const me = renderState.players[myId];
  const listener = me ?? lastCamera;
  // Each kind plays at most once per batch so a feeding frenzy doesn't stack.
  const played = new Set();

  for (const event of events) {
    if (event.type === 'bump') spawnShockwave(event.x, event.y, 0x99ecff);
    else if (event.type === 'chomp') spawnShockwave(event.x, event.y, 0xffbb55);

    if (event.type === 'death') {
      if (event.playerId === myId) SoundManager.playDeath();
      continue;
    }

    if (!listener || played.has(event.type)) continue;
    if (Math.hypot(event.x - listener.x, event.y - listener.y) >= SFX_HEARING_RANGE) continue;

    played.add(event.type);
    if (event.type === 'eat_pellet') SoundManager.playEatPellet();
    else if (event.type === 'eat_fish') SoundManager.playEatFish();
    else if (event.type === 'bump') SoundManager.playBump();
    else if (event.type === 'chomp') SoundManager.playChomp();
  }
});

socket.on('gameOver', (info) => {
  // Stop sending input but stay connected and keep rendering: the cinematic
  // plays over the live arena, and the lobby only returns once it finishes.
  playing = false;
  resetDash();
  SoundManager.setBgmMode('lobby');
  gameOver = { ...info, diedAt: performance.now() };

  gameoverCause.textContent =
    info.cause === 'wall' ? 'You hit the wall' : `Eaten by ${info.eatenByName ?? 'a bigger shark'}`;
  gameoverSize.textContent = `Final size ${info.score}${survivedSuffix(info)}`;
  gameoverEl.hidden = false;
  leaderboardEl.hidden = true;
  statsEl.hidden = true;

  console.log(`[game] ${deathHeadline(gameOver)}`);
});

socket.on('disconnect', (reason) => {
  console.log(`[socket] disconnected: ${reason}`);

  playing = false;
  resetDash();
  SoundManager.setBgmMode('lobby');
  playButton.disabled = true;

  // The cinematic closes the session itself and has already put the lobby up.
  if (endingSession) {
    endingSession = false;
    return;
  }

  gameOver = null;
  lastCamera = null;
  gameoverEl.hidden = true;
  localGameState = { players: {}, food: [] };
  renderState.players = {};
  clearSharks();
  clearFood();

  showLobby('Lost connection to the server. Reconnecting...');
});

socket.on('connect_error', (err) => {
  console.error(`[socket] connection error: ${err.message}`);
  playButton.disabled = true;
});

// --- Input ------------------------------------------------------------------

// Aiming is resolved in the world, not on the screen: the ground plane is seen
// in perspective, so a screen-space angle would be foreshortened along the
// vertical axis and the shark would not swim where the cursor points.
const pointer = new THREE.Vector2(0, 0);
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const groundHit = new THREE.Vector3();
let pointerMoved = false;

// Which device is steering right now: 'mouse', 'keyboard' or 'touch'. The
// last one used wins.
let inputMode = 'mouse';
let lastSentAngle = null;

window.addEventListener('mousemove', (event) => {
  pointer.set(
    (event.clientX / window.innerWidth) * 2 - 1,
    -(event.clientY / window.innerHeight) * 2 + 1,
  );
  pointerMoved = true;
  inputMode = 'mouse';
});

/** World-space aim angle from the shark toward the cursor's point on the water. */
function aimAngle(me) {
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.ray.intersectPlane(groundPlane, groundHit);

  if (hit) {
    const dx = groundHit.x - me.x;
    const dz = groundHit.z - me.y;
    if (Math.hypot(dx, dz) > 1) return Math.atan2(dz, dx);
  }

  // Cursor is above the horizon, where the ray never meets the water. Fall back
  // to the screen direction, which still maps right to +x and down to +y.
  return Math.atan2(-pointer.y, pointer.x);
}

// --- Keyboard steering ---

const STEER_KEYS = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};
const DASH_KEYS = new Set(['Space', 'ShiftLeft', 'ShiftRight', 'KeyE']);

const steerHeld = new Set(); // held directions: 'up' | 'down' | 'left' | 'right'
const dashKeysDown = new Set(); // held dash key codes

/** World heading from the held arrows/WASD, or null if none (or they cancel). */
function keyboardAngle() {
  const kx = (steerHeld.has('right') ? 1 : 0) - (steerHeld.has('left') ? 1 : 0);
  const ky = (steerHeld.has('down') ? 1 : 0) - (steerHeld.has('up') ? 1 : 0);
  if (kx === 0 && ky === 0) return null;
  // Screen up is world -y under this camera, so screen axes map straight over.
  return Math.atan2(ky, kx);
}

// --- Touch steering (virtual joystick) ---

const touchJoystick = document.querySelector('#touchJoystick');
const touchJoystickKnob = document.querySelector('#touchJoystickKnob');
const mobileDashBtn = document.querySelector('#mobileDashBtn');

const JOYSTICK_KNOB_MAX = 38; // px
const JOYSTICK_DEADZONE = 6; // px
const DOUBLE_TAP_MS = 280;

let isTouchDevice = navigator.maxTouchPoints > 0;
let steerTouchId = null;
let joyOriginX = 0;
let joyOriginY = 0;
let joyCurrentX = 0;
let joyCurrentY = 0;
let touchSteerAngle = null;
let lastCanvasTapAt = -Infinity;

setInterval(() => {
  if (!playing) return;

  const me = renderState.players[myId];
  if (!me) return;

  let angle = null;
  if (inputMode === 'keyboard') angle = keyboardAngle();
  else if (inputMode === 'touch') angle = touchSteerAngle;
  else if (pointerMoved) angle = aimAngle(me);
  pointerMoved = false;

  // No input, or nothing changed: the shark keeps its current heading.
  if (angle === null || angle === lastSentAngle) return;
  lastSentAngle = angle;
  socket.emit('input', { angle });
}, 1000 / INPUT_HZ);

// --- Dash ---
// Every dash source is tracked separately and combined, so releasing one while
// another is still held keeps the dash going.
let mouseDashHeld = false;
let dashKeyHeld = false;
let mobileDashBtnHeld = false;
let touchDoubleTapDash = false;
let isDashing = false;

/** Tells the server only when the combined dash state actually flips. */
function updateDash() {
  dashKeyHeld = dashKeysDown.size > 0;
  const shouldDash =
    playing && (mouseDashHeld || dashKeyHeld || mobileDashBtnHeld || touchDoubleTapDash);
  if (shouldDash === isDashing) return;

  isDashing = shouldDash;
  socket.emit('dash', { active: shouldDash });
}

function resetDash() {
  mouseDashHeld = false;
  mobileDashBtnHeld = false;
  touchDoubleTapDash = false;
  dashKeysDown.clear();
  updateDash();
}

window.addEventListener('keydown', (event) => {
  // While the lobby is up, every key belongs to the nickname field.
  if (!playing) return;

  const dir = STEER_KEYS[event.code];
  if (dir) {
    // Arrows would otherwise scroll the page.
    event.preventDefault();
    steerHeld.add(dir);
    inputMode = 'keyboard';
    return;
  }

  if (DASH_KEYS.has(event.code)) {
    // Still swallow key-repeat so the page never scrolls; updateDash dedupes.
    event.preventDefault();
    dashKeysDown.add(event.code);
    updateDash();
  }
});

window.addEventListener('keyup', (event) => {
  const dir = STEER_KEYS[event.code];
  if (dir) steerHeld.delete(dir);

  if (DASH_KEYS.has(event.code)) {
    dashKeysDown.delete(event.code);
    updateDash();
  }
});

window.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || !playing) return;
  mouseDashHeld = true;
  updateDash();
});

window.addEventListener('mouseup', (event) => {
  if (event.button !== 0) return;
  mouseDashHeld = false;
  updateDash();
});

// A key or button released while the window is unfocused never fires its up
// event, which would leave the shark steering or dashing until it starved.
window.addEventListener('blur', () => {
  steerHeld.clear();
  resetDash();
});

// --- Touch handlers ---

function markTouchDevice() {
  if (isTouchDevice) return;
  isTouchDevice = true;
  refreshTouchHud();
}

function hideJoystick() {
  touchJoystick.style.display = 'none';
  touchJoystickKnob.style.transform = '';
}

canvas.addEventListener(
  'touchstart',
  (event) => {
    // Also suppresses the emulated mouse events that would start a dash.
    event.preventDefault();
    markTouchDevice();
    if (!playing) return;

    const now = performance.now();
    for (const touch of event.changedTouches) {
      if (steerTouchId !== null) break;

      steerTouchId = touch.identifier;
      joyOriginX = joyCurrentX = touch.clientX;
      joyOriginY = joyCurrentY = touch.clientY;
      touchJoystick.style.left = `${touch.clientX}px`;
      touchJoystick.style.top = `${touch.clientY}px`;
      touchJoystickKnob.style.transform = '';
      touchJoystick.style.display = 'block';

      // Double-tap and hold: one-handed dash.
      if (now - lastCanvasTapAt < DOUBLE_TAP_MS) touchDoubleTapDash = true;
      lastCanvasTapAt = now;
    }

    updateDash();
  },
  { passive: false },
);

canvas.addEventListener(
  'touchmove',
  (event) => {
    event.preventDefault();

    for (const touch of event.changedTouches) {
      if (touch.identifier !== steerTouchId) continue;

      joyCurrentX = touch.clientX;
      joyCurrentY = touch.clientY;
      const dx = joyCurrentX - joyOriginX;
      const dy = joyCurrentY - joyOriginY;
      const len = Math.hypot(dx, dy);

      const scale = len > JOYSTICK_KNOB_MAX ? JOYSTICK_KNOB_MAX / len : 1;
      touchJoystickKnob.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;

      if (len > JOYSTICK_DEADZONE) {
        touchSteerAngle = Math.atan2(dy, dx);
        inputMode = 'touch';
      }
    }
  },
  { passive: false },
);

function endCanvasTouch(event) {
  for (const touch of event.changedTouches) {
    if (touch.identifier !== steerTouchId) continue;

    steerTouchId = null;
    hideJoystick();
    touchDoubleTapDash = false;
    updateDash();
  }
}

canvas.addEventListener('touchend', endCanvasTouch);
canvas.addEventListener('touchcancel', endCanvasTouch);

// The dash button is its own touch target, so it works alongside the joystick.
function setMobileDash(held) {
  return (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (held) markTouchDevice();
    mobileDashBtnHeld = held;
    updateDash();
  };
}

mobileDashBtn.addEventListener('touchstart', setMobileDash(true), { passive: false });
mobileDashBtn.addEventListener('touchend', setMobileDash(false), { passive: false });
mobileDashBtn.addEventListener('touchcancel', setMobileDash(false), { passive: false });
mobileDashBtn.addEventListener('mousedown', setMobileDash(true));
mobileDashBtn.addEventListener('mouseup', setMobileDash(false));

// --- Smoothing --------------------------------------------------------------

function lerp(start, end, amt) {
  return (1 - amt) * start + amt * end;
}

function syncRenderState(targets) {
  for (const id of Object.keys(renderState.players)) {
    if (!targets[id]) {
      delete renderState.players[id];
      removeShark(id);
    }
  }

  for (const id of Object.keys(targets)) {
    const target = targets[id];
    const current = renderState.players[id];

    if (!current) {
      renderState.players[id] = { ...target };
      continue;
    }

    current.x = lerp(current.x, target.x, LERP_AMOUNT);
    current.y = lerp(current.y, target.y, LERP_AMOUNT);
    // Radius is smoothed too: it drives the camera pull-back, so a raw step
    // would jolt the whole view on every pellet eaten.
    current.radius = lerp(current.radius, target.radius, LERP_AMOUNT);

    // Chase the server's real heading, not the mouse intent: the turn rate is
    // simulated, so `angle` already lags `targetAngle` by design. Interpolating
    // through the vector form avoids spinning the long way round at the seam.
    current.angle = Math.atan2(
      lerp(Math.sin(current.angle), Math.sin(target.angle), LERP_AMOUNT),
      lerp(Math.cos(current.angle), Math.cos(target.angle), LERP_AMOUNT),
    );

    current.id = target.id;
    current.name = target.name;
    current.color = target.color;
    current.score = target.score;
    current.speed = target.speed;
    current.turnSpeed = target.turnSpeed;
    current.dashTimer = target.dashTimer;
  }
}

// --- Frame ------------------------------------------------------------------

const projected = new THREE.Vector3();

function updateSharks(now) {
  for (const player of Object.values(renderState.players)) {
    let shark = sharks.get(player.id);
    if (!shark) {
      shark = createShark(player);
      sharks.set(player.id, shark);
    }

    // Float the body just clear of the water so it never z-fights the floor.
    shark.group.position.set(player.x, player.radius * SHARK_FLOAT, player.y);
    shark.group.scale.setScalar(player.radius);

    // A group rotated by -angle about Y sends its local +X, the snout, along
    // (cos angle, 0, sin angle), which is the server's heading vector.
    shark.group.rotation.y = -player.angle;

    const dashing = player.dashTimer > 0;
    shark.tail.rotation.y = Math.sin(now * WAG_FREQUENCY * (dashing ? 2 : 1)) * TAIL_MAX_ANGLE;

    // Frail sharks go see-through. Only touch the materials when the state
    // actually flips, since changing `transparent` recompiles the shader.
    const weak = player.score < WEAK_SCORE;
    if (shark.weak !== weak) {
      shark.weak = weak;
      for (const material of shark.materials) {
        material.transparent = weak;
        material.opacity = weak ? WEAK_OPACITY : 1;
        material.depthWrite = !weak;
        material.needsUpdate = true;
      }
    }
  }
}

function updateNameplates() {
  const width = window.innerWidth;
  const height = window.innerHeight;

  for (const player of Object.values(renderState.players)) {
    const shark = sharks.get(player.id);
    if (!shark) continue;

    // Only touch the DOM when the shown text would actually change.
    const name = player.name ?? 'Shark';
    if (name !== shark.lastDisplayedName) {
      shark.lastDisplayedName = name;
      shark.plateName.textContent = name;
    }

    const score = Math.floor(player.score);
    if (score !== shark.lastDisplayedScore) {
      shark.lastDisplayedScore = score;
      shark.plateScore.textContent = `[${score}]`;
    }

    projected.set(player.x, player.radius * 1.5, player.y).project(camera);

    // Behind the camera, or off screen: hide rather than clamp to an edge.
    if (projected.z > 1) {
      shark.plate.style.display = 'none';
      continue;
    }

    const sx = (projected.x * 0.5 + 0.5) * width;
    const sy = (-projected.y * 0.5 + 0.5) * height;

    if (sx < -120 || sx > width + 120 || sy < -60 || sy > height + 60) {
      shark.plate.style.display = 'none';
      continue;
    }

    shark.plate.style.display = 'block';
    shark.plate.style.left = `${sx}px`;
    shark.plate.style.top = `${sy}px`;
  }
}

function placeCamera(me) {
  const growthRatio = Math.max(
    0,
    (me.radius - CAMERA_REFERENCE_RADIUS) / CAMERA_REFERENCE_RADIUS,
  );
  const k = Math.min(CAMERA_MAX_SCALE, 1 + growthRatio * CAMERA_GROWTH_DAMPING);

  camera.position.set(me.x, CAMERA_HEIGHT * k, me.y + CAMERA_BACK * k);
  camera.lookAt(me.x, 0, me.y);

  lastCamera = { x: me.x, y: me.y, k };
}

function restoreCamera() {
  if (!lastCamera) return;
  camera.position.set(
    lastCamera.x,
    CAMERA_HEIGHT * lastCamera.k,
    lastCamera.y + CAMERA_BACK * lastCamera.k,
  );
  camera.lookAt(lastCamera.x, 0, lastCamera.y);
}

let lastRanked = [];

function updateHud(me) {
  const ranked = Object.values(renderState.players).sort((a, b) => b.score - a.score);
  lastRanked = ranked;

  const rank = ranked.findIndex((p) => p.id === myId) + 1;
  statSize.textContent = `Size: ${Math.floor(me.score)}`;
  statRank.textContent = `Rank: ${rank || '-'} / ${ranked.length}`;
  statsEl.hidden = false;

  leaderboardEl.hidden = false;
  const top = ranked.slice(0, 5);

  // Reuse the rows rather than rebuilding the list every frame.
  while (leaderboardRows.children.length > top.length) leaderboardRows.lastChild.remove();
  while (leaderboardRows.children.length < top.length) {
    const li = document.createElement('li');
    li.append(document.createElement('span'), document.createElement('span'));
    leaderboardRows.append(li);
  }

  top.forEach((player, index) => {
    const row = leaderboardRows.children[index];
    const label = `${index + 1}. ${player.name ?? 'Shark'}`;
    if (row.children[0].textContent !== label) row.children[0].textContent = label;

    const score = String(Math.floor(player.score));
    if (row.children[1].textContent !== score) row.children[1].textContent = score;

    row.classList.toggle('self', player.id === myId);
  });
}

function updateCinematic(elapsed) {
  const fade = Math.min(CINEMATIC_MAX_FADE, elapsed / CINEMATIC_FADE_MS);
  gameoverEl.style.background = `rgba(0, 0, 0, ${fade})`;

  // Cubic ease-out: the title lands fast and settles.
  const reveal = Math.min(1, elapsed / CINEMATIC_TITLE_MS);
  const eased = 1 - (1 - reveal) ** 3;
  const inner = gameoverEl.firstElementChild;
  inner.style.opacity = String(eased);
  inner.style.transform = `scale(${0.82 + eased * 0.18})`;
}

function endCinematic() {
  const message = deathHeadline(gameOver);

  gameOver = null;
  lastCamera = null;
  localGameState = { players: {}, food: [] };
  renderState.players = {};
  clearSharks();
  clearFood();
  gameoverEl.hidden = true;

  // Close the session, then immediately open a fresh one so the lobby's Play
  // button works again. A bare disconnect would leave the client unable to
  // rejoin, because socket.io does not auto-reconnect after a manual close.
  endingSession = true;
  socket.disconnect();
  socket.connect();

  showLobby(message);
}

let lastFrameAt = performance.now();

function frame() {
  const now = performance.now();
  // Capped so a backgrounded tab doesn't launch every bubble at once.
  const dt = Math.min(0.1, (now - lastFrameAt) / 1000);
  lastFrameAt = now;
  const me = playing ? localGameState.players[myId] : null;

  if (me || gameOver) {
    syncRenderState(localGameState.players);
    updateSharks(now);
  }

  // Rebuild the food InstancedMesh every frame so additions and removals are
  // always reflected without per-pellet bookkeeping.
  syncFoodInstances(now);
  updateBubbles(now, dt);
  updateShockwaves(now);

  if (me) {
    placeCamera(renderState.players[myId]);
    updateHud(renderState.players[myId]);
    setGameHudVisible(true);
    drawMinimap(now);
  } else {
    restoreCamera();
    setGameHudVisible(false);
  }

  SoundManager.setDashLoop(Boolean(me && me.dashTimer > 0));

  updateNameplates();
  renderer.render(scene, camera);

  // The preview only costs a render while someone is actually looking at it.
  if (!lobby.hidden && !colorPopover.hidden) renderLobbyPreview(now);

  if (gameOver) {
    const elapsed = now - gameOver.diedAt;
    updateCinematic(elapsed);
    if (elapsed > CINEMATIC_TOTAL_MS) endCinematic();
  }

  requestAnimationFrame(frame);
}

playButton.disabled = true;
showLobby('');
requestAnimationFrame(frame);

// Dev-only inspection handle. Vite strips this from production builds, so it
// costs the shipped bundle nothing but lets tests assert on the real scene
// instead of guessing from pixels.
if (import.meta.env.DEV) {
  window.__happyshark = {
    THREE,
    scene,
    camera,
    renderer,
    sharks,
    foodMeshes,
    foodInstancedMesh,
    fishInstancedMesh,
    renderState,
    constants: {
      CAMERA_REFERENCE_RADIUS,
      CAMERA_HEIGHT,
      CAMERA_BACK,
      CAMERA_GROWTH_DAMPING,
      CAMERA_MAX_SCALE,
      WEAK_SCORE,
      WEAK_OPACITY,
      WAG_FREQUENCY,
      TAIL_MAX_ANGLE,
    },
    snapshot() {
      const me = renderState.players[myId];
      return {
        myId,
        playing,
        gameOver: gameOver ? { ...gameOver } : null,
        foodCount: foodInstancedMesh.count,
        sharkCount: sharks.size,
        me: me ? { ...me } : null,
        camera: {
          position: camera.position.toArray(),
          height: camera.position.y,
          distance: me ? camera.position.distanceTo(new THREE.Vector3(me.x, 0, me.y)) : null,
        },
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
      };
    },
    sharkInfo(id) {
      const shark = sharks.get(id);
      if (!shark) return null;
      return {
        position: shark.group.position.toArray(),
        scale: shark.group.scale.x,
        rotationY: shark.group.rotation.y,
        tailRotationY: shark.tail.rotation.y,
        childCount: shark.group.children.length,
        weak: shark.weak,
        opacity: shark.materials.map((m) => m.opacity),
        transparent: shark.materials.map((m) => m.transparent),
        color: shark.materials[0].color.getHexString(),
      };
    },
  };
}
