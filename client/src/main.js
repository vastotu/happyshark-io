import * as THREE from 'three';
import { io } from 'socket.io-client';

// Backend URL. Defaults to the local dev server; set VITE_SERVER_URL to point elsewhere.
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3000';

// Matches the server tick; sending every mousemove would flood the socket.
const INPUT_HZ = 30;

// How far render values close the gap to the authoritative ones each frame.
const LERP_AMOUNT = 0.3;

// --- Camera -----------------------------------------------------------------
// The camera sits back and above, and its offset scales with the shark so a
// shark of any size keeps roughly the same apparent size. These values put a
// fresh radius-20 shark at about the same screen footprint the old 2D view gave
// it, and the whole rig is a straight port of `zoom = 20 / radius`.
const CAMERA_REFERENCE_RADIUS = 20;
const CAMERA_HEIGHT = 280;
const CAMERA_BACK = 280;
const CAMERA_FOV = 50;

// Floor on how far the camera may pull back, equivalent to zoom 0.2 in the old
// 2D projection. Without it a capped giant shrank the whole arena to a speck.
const MIN_ZOOM = 0.3;
const MAX_FRAMED_RADIUS = CAMERA_REFERENCE_RADIUS / MIN_ZOOM;

// --- World ------------------------------------------------------------------
const VOID_COLOR = 0x060f1e; // beyond the arena
const WATER_COLOR = 0x11325c; // the arena floor
const GRID_COLOR = 0x2d5a8f;
const WALL_COLOR = 0xff4d5e; // lethal, so it reads as a hazard
const WALL_HEIGHT = 54;
const WALL_THICKNESS = 16;
const GRID_DIVISIONS = 20;
const FOOD_HEIGHT = 7;

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
const colorInput = document.querySelector('#color');
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

// --- Three.js ---------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(VOID_COLOR, 1);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(VOID_COLOR, 2200, 9000);

const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 1, 30000);

scene.add(new THREE.AmbientLight(0x8fa8c8, 1.5));

// Directional lights are infinitely distant, so only the direction matters:
// this one rakes across the water and gives the shark bodies a lit top and a
// shaded flank, which is what sells the 2.5D depth.
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
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
let world = { width: 3000, height: 3000 };
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
    new THREE.MeshStandardMaterial({ color: WATER_COLOR, roughness: 0.95, metalness: 0 }),
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

  // Four low walls rather than a flat line, so the lethal boundary has real
  // thickness and catches the light.
  const wallMaterial = new THREE.MeshStandardMaterial({
    color: WALL_COLOR,
    roughness: 0.5,
    emissive: new THREE.Color(WALL_COLOR).multiplyScalar(0.25),
  });

  const spans = [
    { w: world.width + WALL_THICKNESS * 2, d: WALL_THICKNESS, x: world.width / 2, z: 0 },
    { w: world.width + WALL_THICKNESS * 2, d: WALL_THICKNESS, x: world.width / 2, z: world.height },
    { w: WALL_THICKNESS, d: world.height, x: 0, z: world.height / 2 },
    { w: WALL_THICKNESS, d: world.height, x: world.width, z: world.height / 2 },
  ];

  for (const span of spans) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(span.w, WALL_HEIGHT, span.d), wallMaterial);
    wall.position.set(span.x, WALL_HEIGHT / 2, span.z);
    arena.add(wall);
  }
}

buildArena();

// --- Food -------------------------------------------------------------------

// A single InstancedMesh replaces hundreds of individual Mesh objects, dropping
// food draw calls to 1. Capacity is pre-allocated; `count` tracks live pellets.
const FOOD_INSTANCE_CAPACITY = 1000;
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
scene.add(foodInstancedMesh);

// Retained for backward-compat with the dev handle; tracks nothing visual now.
const foodMeshes = new Map();

const _foodMatrix = new THREE.Matrix4();
const _foodColor = new THREE.Color();
const _foodScale = new THREE.Vector3();

/** Rebuild every food instance from `localGameState.food`. */
function syncFoodInstances() {
  const food = localGameState.food;
  const count = Math.min(food.length, FOOD_INSTANCE_CAPACITY);

  for (let i = 0; i < count; i++) {
    const pellet = food[i];

    _foodMatrix.makeTranslation(pellet.x, FOOD_HEIGHT, pellet.y);
    _foodMatrix.scale(_foodScale.setScalar(foodRadius));
    foodInstancedMesh.setMatrixAt(i, _foodMatrix);

    _foodColor.set(pellet.color);
    foodInstancedMesh.setColorAt(i, _foodColor);
  }

  foodInstancedMesh.count = count;
  foodInstancedMesh.instanceMatrix.needsUpdate = true;
  if (foodInstancedMesh.instanceColor) foodInstancedMesh.instanceColor.needsUpdate = true;
}

// Legacy helpers kept thin — actual rendering now goes through syncFoodInstances.
function addPellet(_pellet) {}
function removePellet(_id) {}
function clearFood() {}

// --- Sharks -----------------------------------------------------------------

// Authored in units of the authoritative radius: the snout sits at x = 1 and
// the tail tip reaches x = -1, so scaling the group by `radius` makes the model
// fill its collision circle exactly.
const bodyGeometry = new THREE.SphereGeometry(1, 22, 16);
bodyGeometry.scale(0.6, 0.3, 0.4);

const headGeometry = new THREE.ConeGeometry(0.38, 0.52, 20);
const dorsalGeometry = new THREE.ConeGeometry(0.15, 0.32, 4);
dorsalGeometry.scale(1, 1, 0.35);

const pectoralGeometry = new THREE.ConeGeometry(0.22, 0.46, 4);
pectoralGeometry.scale(1, 1, 0.16); // flatten into a blade

const flukeGeometry = new THREE.ConeGeometry(0.3, 0.37, 4);
flukeGeometry.scale(0.16, 1, 1); // flatten into a horizontal blade

const caudalGeometry = new THREE.ConeGeometry(0.12, 0.26, 4);
caudalGeometry.scale(1, 1, 0.3);

const eyeGeometry = new THREE.SphereGeometry(0.055, 8, 6);
const eyeMaterial = new THREE.MeshStandardMaterial({ color: 0x0a1424, roughness: 0.3 });

// Drop shadow geometry shared across all sharks. Placed at Y just above the
// arena floor so it reads as a contact shadow and never z-fights.
const shadowGeometry = new THREE.CircleGeometry(1, 24);
shadowGeometry.rotateX(-Math.PI / 2);
const shadowMaterial = new THREE.MeshBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0.4,
  depthWrite: false,
});

const sharks = new Map();

/**
 * Builds one procedural shark. The tail lives on its own pivot so it can be
 * swung without touching the body, and every material is owned by this shark
 * so colour and opacity can be set per player.
 */
function createShark(player) {
  const group = new THREE.Group();

  const skin = new THREE.MeshStandardMaterial({
    color: new THREE.Color(player.color),
    roughness: 0.5,
    metalness: 0.1,
  });
  const belly = new THREE.MeshStandardMaterial({
    color: new THREE.Color(player.color).multiplyScalar(0.62),
    roughness: 0.6,
  });

  const body = new THREE.Mesh(bodyGeometry, skin);
  body.position.x = -0.05;
  group.add(body);

  // Cones point +Y by default; -90 degrees about Z aims the snout along +X.
  const head = new THREE.Mesh(headGeometry, skin);
  head.rotation.z = -Math.PI / 2;
  head.position.x = 0.74;
  group.add(head);

  const dorsal = new THREE.Mesh(dorsalGeometry, belly);
  dorsal.position.set(-0.1, 0.24, 0);
  dorsal.rotation.z = 0.3; // leans back
  group.add(dorsal);

  // Pectoral fins: a pivot carries the sweep, the blade points outward.
  for (const side of [1, -1]) {
    const pivot = new THREE.Group();
    pivot.position.set(0.06, -0.03, side * 0.2);
    pivot.rotation.y = -0.55 * side;

    const fin = new THREE.Mesh(pectoralGeometry, belly);
    fin.rotation.x = (Math.PI / 2) * side;
    fin.position.z = side * 0.23;
    pivot.add(fin);
    group.add(pivot);
  }

  for (const side of [1, -1]) {
    const eye = new THREE.Mesh(eyeGeometry, eyeMaterial);
    eye.position.set(0.56, 0.07, side * 0.13);
    group.add(eye);
  }

  // Tail pivot at the back of the body: rotating this about Y is the wag.
  const tail = new THREE.Group();
  tail.position.x = -0.63;

  const fluke = new THREE.Mesh(flukeGeometry, skin);
  fluke.rotation.z = Math.PI / 2; // length now runs along -X, blade horizontal
  fluke.position.x = -0.185;
  tail.add(fluke);

  const caudal = new THREE.Mesh(caudalGeometry, belly);
  caudal.position.set(-0.08, 0.1, 0);
  caudal.rotation.z = 0.35;
  tail.add(caudal);

  group.add(tail);

  // Drop shadow: a dark circle on the arena floor to ground the floating shark.
  const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
  shadow.renderOrder = -1;
  group.add(shadow);

  scene.add(group);

  const plate = document.createElement('span');
  plate.textContent = player.name ?? 'Shark';
  nameplateLayer.append(plate);

  return { group, tail, shadow, materials: [skin, belly], plate, weak: null };
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

function deathHeadline(info) {
  return info.cause === 'wall'
    ? `You hit the wall at size ${info.score}.`
    : `Eaten by ${info.eatenByName ?? 'a bigger shark'} at size ${info.score}.`;
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
    localGameState.food.push(...newFood);
    newFood.forEach(addPellet);
  }
});

socket.on('gameOver', (info) => {
  // Stop sending input but stay connected and keep rendering: the cinematic
  // plays over the live arena, and the lobby only returns once it finishes.
  playing = false;
  gameOver = { ...info, diedAt: performance.now() };

  gameoverCause.textContent =
    info.cause === 'wall' ? 'You hit the wall' : `Eaten by ${info.eatenByName ?? 'a bigger shark'}`;
  gameoverSize.textContent = `Final size ${info.score}`;
  gameoverEl.hidden = false;
  leaderboardEl.hidden = true;
  statsEl.hidden = true;

  console.log(`[game] ${deathHeadline(gameOver)}`);
});

socket.on('disconnect', (reason) => {
  console.log(`[socket] disconnected: ${reason}`);

  playing = false;
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

window.addEventListener('mousemove', (event) => {
  pointer.set(
    (event.clientX / window.innerWidth) * 2 - 1,
    -(event.clientY / window.innerHeight) * 2 + 1,
  );
  pointerMoved = true;
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

setInterval(() => {
  if (!playing || !pointerMoved) return;

  const me = renderState.players[myId];
  if (!me) return;

  socket.emit('input', { angle: aimAngle(me) });
  pointerMoved = false;
}, 1000 / INPUT_HZ);

function requestDash() {
  if (!playing) return;
  socket.emit('dash');
}

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat) return;
  // While the lobby is up, space belongs to the nickname field.
  if (!playing) return;

  event.preventDefault();
  requestDash();
});

window.addEventListener('mousedown', (event) => {
  if (event.button === 0) requestDash();
});

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
    shark.group.position.set(player.x, player.radius * 0.42, player.y);
    shark.group.scale.setScalar(player.radius);

    // Position the drop shadow so it sits at world Y ≈ 1 (just above the arena
    // floor) regardless of how high the group itself floats. In local space the
    // group is at Y = radius * 0.42, so the shadow needs to cancel that offset.
    shark.shadow.position.y = (1 - player.radius * 0.42) / player.radius;

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

    if (shark.plate.textContent !== player.name) shark.plate.textContent = player.name;

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
  // Clamping the framed radius is the zoom floor: past this size the camera
  // stops retreating and a giant simply looks giant.
  const framed = Math.min(me.radius, MAX_FRAMED_RADIUS);
  const k = framed / CAMERA_REFERENCE_RADIUS;

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

function frame() {
  const now = performance.now();
  const me = playing ? localGameState.players[myId] : null;

  if (me || gameOver) {
    syncRenderState(localGameState.players);
    updateSharks(now);
  }

  // Rebuild the food InstancedMesh every frame so additions and removals are
  // always reflected without per-pellet bookkeeping.
  syncFoodInstances();

  if (me) {
    placeCamera(renderState.players[myId]);
    updateHud(renderState.players[myId]);
  } else {
    restoreCamera();
  }

  updateNameplates();
  renderer.render(scene, camera);

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
    renderState,
    constants: {
      CAMERA_REFERENCE_RADIUS,
      CAMERA_HEIGHT,
      CAMERA_BACK,
      MIN_ZOOM,
      MAX_FRAMED_RADIUS,
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
