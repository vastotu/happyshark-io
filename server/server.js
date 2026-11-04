import { createServer } from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';

const PORT = Number(process.env.PORT) || 3000;

// Origin allowed to connect from a browser. Defaults to the Vite dev server;
// set CLIENT_ORIGIN when the client is served from somewhere else.
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

// Fixed arena shared by every player. Clients render a camera window onto it
// rather than scaling it to their viewport, so everyone agrees on coordinates.
const WORLD = { width: 5000, height: 5000 };

// Score is the real currency; radius is derived from it. The curve rises fast
// early so growth is obvious, then eases into MAX_RADIUS at SATURATION_SCORE.
const START_SCORE = 10;
const MIN_RADIUS = 16;
const MAX_RADIUS = 105;
const SATURATION_SCORE = 1500;

// The walls are lethal now, so spawns keep well clear of them.
const SPAWN_MARGIN = 250;

// Every shark swims at the same speed. Size costs agility instead: a shark
// turns at turnSpeed radians per second, so its tightest circle has radius
// speed/turnSpeed. A fresh shark carves a 45-unit circle; a giant needs 250.
const BASE_SPEED = 250; // pixels per second, for everyone
const BASE_TURN_SPEED = 6.0; // radians per second at zero radius
const MIN_TURN_SPEED = 1.0;
const TURN_RADIUS_DIVISOR = 50;

// Holding dash burns mass continuously for a burst of speed, giving small
// sharks an escape and big ones a way to close a gap. It cuts out once the
// shark is down to MIN_DASH_SCORE.
const MIN_DASH_SCORE = 10;
const DASH_COST_PER_SEC = 5;
const DASH_MULTIPLIER = 1.5;

const MAX_FOOD = 800;
const FOOD_RADIUS = 5;
const FOOD_SCORE = 1;

// Food never spawns within this margin of the lethal wall. Without it the
// border becomes a permanent pellet sink: players sensibly refuse to graze
// where a mistake is fatal, the uneaten pellets keep the pool at MAX_FOOD, the
// top-up rule therefore never fires, and the playable interior starves.
const FOOD_MARGIN = 150;

// Death and bump drops push the pool above MAX_FOOD, which the top-up logic
// then treats as a floor. This keeps a burst of deaths from ballooning the
// broadcast payload.
const FOOD_HARD_CAP = 1500;

// Eating is judged on score, not radius. Radius is offset and capped at
// MAX_RADIUS, so it is not a faithful measure of who is bigger. A predator
// needs about 32% more mass than its prey.
const EAT_RATIO_SCORE = 1.15 ** 2;

// Two sharks too evenly matched to eat each other grind mass off one another,
// and that mass drops to the sea floor as pellets.
const BUMP_DRAIN_PER_SECOND = 0.05;
const BUMP_SCORE_FLOOR = 1;

// A shark that dies to the wall leaves this share of itself behind.
const DEATH_DROP_FRACTION = 0.5;
const DEATH_DROP_MAX = 40;

// Death and bump drops land as dried fish rather than plain pellets.
const FISH_COLOR = '#f5a642';
const FISH_DEATH_VALUE = 3;
const FISH_BUMP_VALUE = 1;

// Bump sounds fire at most this often per pair of sharks.
const BUMP_SFX_THROTTLE_MS = 200;

const MAX_NAME_LENGTH = 12;
const DEFAULT_NAME = 'Shark';

// --- Bots -------------------------------------------------------------------
// AI sharks top the arena up to TARGET_POPULATION and give way as humans join.
const TARGET_POPULATION = 14;

const BOT_NAMES = [
  'kevin_99', 'SharkBite', 'nemo_lost', '阿瑋', 'tuna_roll', 'GuraFan',
  '吃魚不吐骨', 'laggy_bro', 'mako_7', '深海肥宅', 'sushi_lover', ' FinFin',
  'Chomper', '小魚乾獵人', 'aqua_kid', ' Bubbles', '浪裡白條', ' jaws_jr',
  '鹹魚翻身', 'BlueFin', '呆呆鯊', 'orca_spy', '夜宵吃生魚片', 'drift_king',
];

const BOT_COLORS = [
  '#38bdf8', '#f43f5e', '#a855f7', '#10b981', '#f59e0b',
  '#ec4899', '#06b6d4', '#84cc16', '#6366f1', '#14b8a6',
];

const BOT_SPAWN_INTERVAL_MS = 1000; // bots trickle in, at most one per second
const BOT_SPAWN_MARGIN = 400; // from the walls
const BOT_SAFE_DISTANCE = 400; // from any larger shark
const BOT_WALL_ALERT = 340;
const BOT_THREAT_RANGE = 340;
const BOT_PREY_RANGE = 360;
const BOT_FOOD_RANGE = 550;

const TICK_RATE = 30; // Hz
const TICK_MS = 1000 / TICK_RATE;

// Authoritative game state. Players are keyed by socket.id so lookups on
// connect/disconnect/input are O(1); food is a flat array since it's only ever
// scanned, never addressed by key.
const gameState = { players: {}, food: [] };

// Fractional bump losses bank here until they are worth a whole pellet, so
// drained mass is conserved rather than rounded away every tick.
const dropDebt = new Map();

// Outbound events collected during a tick and flushed at the end of it.
let tickEatenFood = [];
let tickNewFood = [];
let tickDeaths = [];
let tickSfx = [];

// Last bump sound per pair of sharks, for throttling.
const lastBumpSfx = new Map();

let botSerial = 0;
let nextBotSpawnAt = 0;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Random colour as a `#rrggbb` string. */
function randomHexColor() {
  // Channels start at 0x40 rather than 0x00 so colours stay readable against
  // the dark water background; fully random hex can land on near-black.
  const channel = () =>
    Math.floor(randomBetween(0x40, 0x100))
      .toString(16)
      .padStart(2, '0');

  return `#${channel()}${channel()}${channel()}`;
}

function scoreToRadius(score) {
  const clamped = Math.max(0, Math.min(SATURATION_SCORE, score) - 10);
  const progress = clamped / (SATURATION_SCORE - 10);
  return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * Math.pow(progress, 0.52);
}

/** Shortest signed rotation from `from` to `to`, in (-PI, PI]. */
function angleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function normalizeAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * Recomputes everything derived from score. Call this after any score change so
 * radius and agility can never drift out of sync with it.
 */
function refreshPlayerSize(player) {
  player.radius = scoreToRadius(player.score);
  player.speed = BASE_SPEED;
  player.turnSpeed = Math.max(
    MIN_TURN_SPEED,
    BASE_TURN_SPEED - player.radius / TURN_RADIUS_DIVISOR,
  );
}

/** Nicknames are untrusted input: strip control characters and clamp length. */
function sanitizeName(raw) {
  const cleaned = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH);

  return cleaned || DEFAULT_NAME;
}

/** Colours end up as canvas fill styles, so only accept plain hex. */
function sanitizeColor(raw) {
  return /^#[0-9a-f]{6}$/i.test(String(raw ?? '')) ? String(raw).toLowerCase() : randomHexColor();
}

function createPlayer(id, name, color) {
  const player = {
    id,
    name,
    color,
    x: randomBetween(SPAWN_MARGIN, WORLD.width - SPAWN_MARGIN),
    y: randomBetween(SPAWN_MARGIN, WORLD.height - SPAWN_MARGIN),
    score: START_SCORE,
    radius: scoreToRadius(START_SCORE),
    speed: BASE_SPEED,
    turnSpeed: BASE_TURN_SPEED,
    // Where the mouse points, and where the body has actually swung to.
    // Aim at the middle of the arena so a fresh shark isn't pointed at a wall.
    targetAngle: 0,
    angle: 0,
    // Whether the dash button is held. dashTimer mirrors it as 1/0 so clients
    // can keep keying the fast tail wag off `dashTimer > 0`.
    isDashing: false,
    dashTimer: 0,
    isBot: false,
  };

  player.targetAngle = Math.atan2(WORLD.height / 2 - player.y, WORLD.width / 2 - player.x);
  // Start facing the way we are aiming, so a spawn doesn't open with a spin.
  player.angle = player.targetAngle;

  refreshPlayerSize(player);
  return player;
}

/**
 * Builds one food item. A plain pellet at a random spot by default; death and
 * bump drops override kind, colour, rotation, value and position.
 */
function createFoodItem(overrides = {}) {
  const item = {
    id: Math.random().toString(36).slice(2),
    kind: 'pellet',
    value: FOOD_SCORE,
    rot: 0,
    color: randomHexColor(),
    ...overrides,
  };

  // Clamping to the safe zone also keeps death and bump drops out of the
  // border, so a shark dying against a wall cannot seed the sink either.
  item.x = clamp(
    overrides.x ?? randomBetween(FOOD_MARGIN, WORLD.width - FOOD_MARGIN),
    FOOD_MARGIN,
    WORLD.width - FOOD_MARGIN,
  );
  item.y = clamp(
    overrides.y ?? randomBetween(FOOD_MARGIN, WORLD.height - FOOD_MARGIN),
    FOOD_MARGIN,
    WORLD.height - FOOD_MARGIN,
  );

  return item;
}

/** Appends `count` pellets at random spots and returns just the new ones. */
function generateFood(count) {
  const created = [];

  for (let i = 0; i < count; i += 1) {
    const pellet = createFoodItem();
    gameState.food.push(pellet);
    created.push(pellet);
  }

  return created;
}

/** Scatters `count` dried fish worth `value` each around a point, within `spread`. */
function scatterFish(count, x, y, spread, value) {
  const created = [];

  for (let i = 0; i < count; i += 1) {
    if (gameState.food.length >= FOOD_HARD_CAP) break;

    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * spread;
    const fish = createFoodItem({
      x: x + Math.cos(angle) * distance,
      y: y + Math.sin(angle) * distance,
      kind: 'fish',
      color: FISH_COLOR,
      rot: Number((Math.random() * Math.PI * 2).toFixed(2)),
      value,
    });

    gameState.food.push(fish);
    created.push(fish);
  }

  return created;
}

/** Eats every food item overlapping `player`; returns the ids consumed. */
function eatNearbyFood(player) {
  const eaten = [];
  let ateFish = false;

  // Walk backwards so splice() can't make us skip the next entry.
  for (let i = gameState.food.length - 1; i >= 0; i -= 1) {
    const food = gameState.food[i];
    const d = Math.hypot(player.x - food.x, player.y - food.y);

    if (d < player.radius + FOOD_RADIUS) {
      gameState.food.splice(i, 1);
      eaten.push(food.id);
      if (food.kind === 'fish') ateFish = true;

      player.score += food.value ?? FOOD_SCORE;
      refreshPlayerSize(player);
    }
  }

  // One sound per shark per tick, however many items it swallowed.
  if (eaten.length > 0) {
    tickSfx.push({
      type: ateFish ? 'eat_fish' : 'eat_pellet',
      x: player.x,
      y: player.y,
      playerId: player.id,
    });
  }

  return eaten;
}

/**
 * Removes a player and queues their gameOver event. `dropFood` is off when a
 * predator absorbed them, since the mass already went somewhere.
 */
function killPlayer(id, { cause, eatenBy = null, eatenByName = null, dropFood = true }) {
  const player = gameState.players[id];
  if (!player) return;

  if (dropFood) {
    const pellets = Math.min(DEATH_DROP_MAX, Math.round(player.score * DEATH_DROP_FRACTION));
    if (pellets > 0) {
      tickNewFood.push(
        ...scatterFish(pellets, player.x, player.y, player.radius + 80, FISH_DEATH_VALUE),
      );
    }
  }

  delete gameState.players[id];
  dropDebt.delete(id);

  tickSfx.push({ type: 'death', x: player.x, y: player.y, playerId: id });

  tickDeaths.push({
    id,
    cause,
    eatenBy,
    eatenByName,
    score: Math.floor(player.score),
    name: player.name,
  });

  console.log(
    `[game] ${player.name} (${id}) died: ${cause}` +
      `${eatenByName ? ` by ${eatenByName}` : ''} at size ${Math.floor(player.score)}`,
  );
}

/** The arena edge is lethal: any contact at all kills. */
function touchesWall(player) {
  return (
    player.x - player.radius <= 0 ||
    player.y - player.radius <= 0 ||
    player.x + player.radius >= WORLD.width ||
    player.y + player.radius >= WORLD.height
  );
}

function devour(predator, prey) {
  predator.score += prey.score;
  refreshPlayerSize(predator);

  tickSfx.push({ type: 'chomp', x: prey.x, y: prey.y, playerId: predator.id });

  killPlayer(prey.id, {
    cause: 'eaten',
    eatenBy: predator.id,
    eatenByName: predator.name,
    dropFood: false,
  });
}

/**
 * Two sharks too evenly matched to eat each other grind mass off both sides.
 * The lost mass is re-spawned as pellets between them, so a third shark (or
 * whoever wins the shoving match) can pick it up.
 */
function grindBump(a, b, deltaTime) {
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const spread = (a.radius + b.radius) * 0.6;

  for (const player of [a, b]) {
    const loss = Math.min(
      player.score * BUMP_DRAIN_PER_SECOND * deltaTime,
      Math.max(0, player.score - BUMP_SCORE_FLOOR),
    );
    if (loss <= 0) continue;

    player.score -= loss;
    refreshPlayerSize(player);

    const banked = (dropDebt.get(player.id) ?? 0) + loss;
    const pellets = Math.floor(banked);
    dropDebt.set(player.id, banked - pellets);

    if (pellets > 0) {
      tickNewFood.push(...scatterFish(pellets, midX, midY, spread, FISH_BUMP_VALUE));
    }
  }
}

/**
 * Whether B touches A's elliptical body. The rendered shark is long and narrow,
 * so a circular hitbox made contact on the empty water beside its flanks.
 */
function checkSharkCollision(A, B) {
  // Check if B touches A's elliptical body (length = A.radius, width = A.radius * 0.45)
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const cos = Math.cos(-A.angle);
  const sin = Math.sin(-A.angle);
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;

  // Account for B's core body thickness (~0.45 of B's radius)
  const pad = B.radius * 0.45;
  const rx = A.radius * 1.05 + pad; // snout-to-tail reach
  const ry = A.radius * 0.52 + pad; // flank width reach

  return (localX * localX) / (rx * rx) + (localY * localY) / (ry * ry) <= 1.0;
}

/**
 * Resolves shark-vs-shark overlaps. O(N^2) over pairs, which is fine at this
 * player count. Eating is checked before draining, so a bump that pushes one
 * side under the 15% threshold resolves as a kill on the following tick.
 */
function resolvePlayerCollisions(deltaTime, now) {
  const ids = Object.keys(gameState.players);

  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = gameState.players[ids[i]];
      const b = gameState.players[ids[j]];

      // Either side may already have been removed earlier in this pass.
      if (!a || !b) continue;

      if (!checkSharkCollision(a, b) && !checkSharkCollision(b, a)) continue;

      // Judged on score, so the verdict still works when either radius is
      // sitting on a clamp. The test is asymmetric, so at most one can hold.
      if (a.score > b.score * EAT_RATIO_SCORE) {
        devour(a, b);
      } else if (b.score > a.score * EAT_RATIO_SCORE) {
        devour(b, a);
      } else {
        grindBump(a, b, deltaTime);

        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (now - (lastBumpSfx.get(key) ?? -Infinity) >= BUMP_SFX_THROTTLE_MS) {
          lastBumpSfx.set(key, now);
          tickSfx.push({ type: 'bump', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, playerId: a.id });
        }
      }
    }
  }
}

// --- Bots -------------------------------------------------------------------

/** Ecological mix: mostly small scavengers, some hunters, at most two apexes. */
function rollBotScore(players) {
  const r = Math.random();
  if (r < 0.6) return 12 + Math.floor(Math.random() * 33);
  if (r < 0.9) return 65 + Math.floor(Math.random() * 155);

  const apexCount = players.filter((p) => p.score > 260).length;
  return apexCount < 2
    ? 280 + Math.floor(Math.random() * 260)
    : 80 + Math.floor(Math.random() * 100);
}

function pickBotName(players) {
  const used = new Set(players.map((p) => p.name));
  const free = BOT_NAMES.map(sanitizeName).filter((name) => !used.has(name));
  if (free.length === 0) return `Shark_${botSerial}`;
  return free[Math.floor(Math.random() * free.length)];
}

/** A spot clear of the walls and of every shark big enough to eat the newcomer. */
function findBotSpawn(score, players) {
  let spot = null;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    spot = {
      x: randomBetween(BOT_SPAWN_MARGIN, WORLD.width - BOT_SPAWN_MARGIN),
      y: randomBetween(BOT_SPAWN_MARGIN, WORLD.height - BOT_SPAWN_MARGIN),
    };

    const safe = players.every(
      (p) => p.score <= score || Math.hypot(p.x - spot.x, p.y - spot.y) >= BOT_SAFE_DISTANCE,
    );
    if (safe) break;
  }

  return spot;
}

function spawnBot(now, players) {
  botSerial += 1;
  const id = `bot_${botSerial}`;
  const score = rollBotScore(players);
  const color = BOT_COLORS[Math.floor(Math.random() * BOT_COLORS.length)];
  const bot = createPlayer(id, pickBotName(players), color);

  const spot = findBotSpawn(score, players);
  bot.x = spot.x;
  bot.y = spot.y;
  bot.score = score;
  refreshPlayerSize(bot);

  bot.isBot = true;
  bot.desiredAngle = Math.atan2(WORLD.height / 2 - bot.y, WORLD.width / 2 - bot.x);
  bot.targetAngle = bot.desiredAngle;
  bot.angle = bot.desiredAngle;
  bot.wanderPhase = Math.random() * Math.PI * 2;
  bot.nextThinkAt = now;
  bot.dashUntil = 0;

  gameState.players[id] = bot;
}

/**
 * Keeps the arena at TARGET_POPULATION. Over target, the bot farthest from any
 * human leaves silently (no fish, no sound); under it, one bot joins per second.
 */
function maintainBotPopulation(now) {
  const players = Object.values(gameState.players);
  const humans = players.filter((p) => !p.isBot);
  const bots = players.filter((p) => p.isBot);

  if (players.length > TARGET_POPULATION && bots.length > 0) {
    let farthest = bots[0];
    let farthestDist = -1;

    for (const bot of bots) {
      let nearest = Infinity;
      for (const human of humans) {
        nearest = Math.min(nearest, Math.hypot(human.x - bot.x, human.y - bot.y));
      }
      if (nearest > farthestDist) {
        farthestDist = nearest;
        farthest = bot;
      }
    }

    // The next stateUpdate simply omits it, which clients treat as a removal.
    delete gameState.players[farthest.id];
    dropDebt.delete(farthest.id);
    return;
  }

  if (players.length < TARGET_POPULATION && now >= nextBotSpawnAt) {
    spawnBot(now, players);
    nextBotSpawnAt = now + BOT_SPAWN_INTERVAL_MS;
  }
}

/** One decision: walls, then threats, then prey, then food, then wander. */
function botThink(bot, now) {
  // 1. Wall avoidance.
  if (
    bot.x < BOT_WALL_ALERT ||
    bot.y < BOT_WALL_ALERT ||
    bot.x > WORLD.width - BOT_WALL_ALERT ||
    bot.y > WORLD.height - BOT_WALL_ALERT
  ) {
    const cx = WORLD.width / 2 + (Math.random() - 0.5) * 800;
    const cy = WORLD.height / 2 + (Math.random() - 0.5) * 800;
    bot.desiredAngle = Math.atan2(cy - bot.y, cx - bot.x);
    bot.isDashing = false;
    // Cleared too, or the dash flag recomputed after thinking would carry the
    // bot into the wall at full speed.
    bot.dashUntil = 0;
    return;
  }

  let threat = null;
  let threatDist = BOT_THREAT_RANGE;
  let prey = null;
  let preyDist = BOT_PREY_RANGE;

  for (const other of Object.values(gameState.players)) {
    if (other === bot) continue;
    const d = Math.hypot(other.x - bot.x, other.y - bot.y);

    if (other.score > bot.score * 1.15) {
      if (d < threatDist) {
        threat = other;
        threatDist = d;
      }
    } else if (bot.score > other.score * 1.18 && d < preyDist) {
      prey = other;
      preyDist = d;
    }
  }

  // 2. Threat evasion.
  if (threat) {
    bot.desiredAngle =
      Math.atan2(bot.y - threat.y, bot.x - threat.x) + (Math.random() - 0.5) * 0.7;
    if (threatDist < 195 && bot.score > 18) bot.dashUntil = now + 450;
    return;
  }

  // 3. Prey hunt.
  if (prey) {
    const toPrey = Math.atan2(prey.y - bot.y, prey.x - bot.x);
    bot.desiredAngle = toPrey;
    if (preyDist < 175 && Math.abs(angleDelta(bot.angle, toPrey)) < 0.5 && bot.score > 35) {
      bot.dashUntil = now + 500;
    }
    return;
  }

  // 4. Foraging. Dried fish are worth chasing harder than pellets.
  let best = null;
  let bestValue = 0;
  let bestDist = 0;

  for (const food of gameState.food) {
    const dx = food.x - bot.x;
    const dy = food.y - bot.y;
    if (Math.abs(dx) > BOT_FOOD_RANGE || Math.abs(dy) > BOT_FOOD_RANGE) continue;

    const d = Math.hypot(dx, dy);
    if (d > BOT_FOOD_RANGE) continue;

    const value = (food.kind === 'fish' ? 4.5 : 1.0) / Math.max(40, d);
    if (value > bestValue) {
      best = food;
      bestValue = value;
      bestDist = d;
    }
  }

  if (best) {
    bot.desiredAngle = Math.atan2(best.y - bot.y, best.x - bot.x);
    if (best.kind === 'fish' && bestDist < 260 && bot.score > 25 && Math.random() < 0.35) {
      bot.dashUntil = now + 380;
    }
    return;
  }

  // 5. Wander.
  bot.desiredAngle = normalizeAngle(bot.desiredAngle + (Math.random() - 0.5) * 0.9);
}

// eslint-disable-next-line no-unused-vars
function updateBotAI(bot, dt, now) {
  // A slight continuous wobble, like a human hand on a mouse.
  const wobble = Math.sin(now * 0.0035 + bot.wanderPhase) * 0.07;

  if (now >= bot.nextThinkAt) {
    bot.nextThinkAt = now + 180 + Math.random() * 220;
    botThink(bot, now);
  }

  bot.targetAngle = bot.desiredAngle + wobble;
  bot.isDashing = now < bot.dashUntil && bot.score > 14;
}

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));

// Lightweight health check for verifying the HTTP server is up.
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    players: Object.keys(gameState.players).length,
    food: gameState.food.length,
  });
});

// Socket.IO needs the raw HTTP server, so create it explicitly around Express.
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: CLIENT_ORIGIN },
});

io.on('connection', (socket) => {
  console.log(`[socket] connected: ${socket.id}`);

  // Connecting only gets you the lobby. The full pellet pool ships here so the
  // client can build its pool before spawning; after this it tracks foodUpdate
  // deltas, and the 30Hz broadcast carries players only.
  socket.emit('welcome', {
    message: 'Welcome to HappyShark.io!',
    socketId: socket.id,
    world: WORLD,
    foodRadius: FOOD_RADIUS,
    food: gameState.food,
    maxNameLength: MAX_NAME_LENGTH,
  });

  socket.on('joinGame', (data) => {
    // Already swimming: ignore, so a client cannot re-roll its position by
    // spamming joinGame to escape a predator.
    if (gameState.players[socket.id]) return;

    const name = sanitizeName(data?.name);
    const color = sanitizeColor(data?.color);

    gameState.players[socket.id] = createPlayer(socket.id, name, color);

    console.log(
      `[game] ${name} joined as ${socket.id} (players: ${Object.keys(gameState.players).length})`,
    );
  });

  socket.on('input', (data) => {
    const player = gameState.players[socket.id];
    if (!player) return;

    const angle = data?.angle;
    // Reject anything non-finite. NaN would propagate straight into x/y and
    // there is no way to recover it, which would strand the player permanently.
    if (Number.isFinite(angle)) {
      player.targetAngle = angle;
    }
  });

  // Dash is held, not tapped: the client sends { active } whenever the button
  // state changes, and the tick drains mass for as long as it stays on.
  socket.on('dash', (data) => {
    const player = gameState.players[socket.id];
    if (!player) return;

    player.isDashing = data?.active === true;
  });

  socket.on('disconnect', (reason) => {
    delete gameState.players[socket.id];
    dropDebt.delete(socket.id);

    console.log(
      `[socket] disconnected: ${socket.id} (${reason}) (players: ${Object.keys(gameState.players).length})`,
    );
  });
});

generateFood(MAX_FOOD);

// Authoritative simulation. The broadcast happens here rather than on
// connect/disconnect, so joins and leaves surface on the next tick.
let lastTick = performance.now();

setInterval(() => {
  const now = performance.now();
  const deltaTime = (now - lastTick) / 1000;
  lastTick = now;

  tickEatenFood = [];
  tickNewFood = [];
  tickDeaths = [];
  tickSfx = [];

  // 0. Top up or trim the bot population, then let every bot steer.
  maintainBotPopulation(now);
  for (const player of Object.values(gameState.players)) {
    if (player.isBot) updateBotAI(player, deltaTime, now);
  }

  // 1. Swing the body toward the aim, move, and the walls bite.
  for (const player of Object.values(gameState.players)) {
    // The mouse sets an intent; how fast the shark can answer depends on size.
    const wanted = angleDelta(player.angle, player.targetAngle);
    const maxTurn = player.turnSpeed * deltaTime;
    player.angle = normalizeAngle(player.angle + clamp(wanted, -maxTurn, maxTurn));

    let speed = player.speed;

    if (player.isDashing && player.score > MIN_DASH_SCORE) {
      player.score = Math.max(MIN_DASH_SCORE, player.score - DASH_COST_PER_SEC * deltaTime);
      refreshPlayerSize(player);
      speed *= DASH_MULTIPLIER;
      // Kept above zero while dashing so the client's fast tail wag still works.
      player.dashTimer = 1;
    } else {
      player.isDashing = false;
      player.dashTimer = 0;
    }

    // Scaling by deltaTime keeps travel speed constant even if a tick runs late.
    const distance = speed * deltaTime;

    // Travel along the body's actual heading, not the mouse direction.
    player.x += Math.cos(player.angle) * distance;
    player.y += Math.sin(player.angle) * distance;

    if (touchesWall(player)) {
      killPlayer(player.id, { cause: 'wall' });
    }
  }

  // 2. Food, collected as a delta instead of a full array.
  for (const player of Object.values(gameState.players)) {
    tickEatenFood.push(...eatNearbyFood(player));
  }

  if (gameState.food.length < MAX_FOOD) {
    tickNewFood.push(...generateFood(MAX_FOOD - gameState.food.length));
  }

  // 3. Shark vs shark: swallow, or grind each other down.
  resolvePlayerCollisions(deltaTime, now);

  for (const [key, at] of lastBumpSfx) {
    if (now - at > 1000) lastBumpSfx.delete(key);
  }

  // 4. Flush. Deaths go out first so a victim learns why before the roster
  //    that no longer contains them.
  for (const death of tickDeaths) {
    io.to(death.id).emit('gameOver', death);
  }

  if (tickEatenFood.length > 0 || tickNewFood.length > 0) {
    io.emit('foodUpdate', { eatenIds: tickEatenFood, newFood: tickNewFood });
  }

  // Batched: one event per tick carrying every sound that happened in it.
  if (tickSfx.length > 0) {
    io.emit('sfx', tickSfx);
  }

  io.emit('stateUpdate', { players: gameState.players });
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`HappyShark.io server listening on http://localhost:${PORT}`);
  console.log(
    `World: ${WORLD.width}x${WORLD.height} | tick: ${TICK_RATE}Hz | food: ${gameState.food.length}`,
  );
  console.log(`Walls are lethal | bump drain ${BUMP_DRAIN_PER_SECOND * 100}%/s`);
  console.log(
    `Speed ${BASE_SPEED} for all | turn ${BASE_TURN_SPEED}..${MIN_TURN_SPEED} rad/s | ` +
      `radius ${MIN_RADIUS}..${MAX_RADIUS} (caps at score ${SATURATION_SCORE})`,
  );
  console.log(`Accepting browser clients from ${CLIENT_ORIGIN}`);
});
