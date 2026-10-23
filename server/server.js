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
const WORLD = { width: 3000, height: 3000 };

// Score is the real currency; radius is derived from it so that area, not
// radius, grows linearly with food eaten. sqrt(10) * 6.32 ~= 20, which puts a
// fresh shark exactly at MIN_RADIUS.
const START_SCORE = 10;
const MIN_RADIUS = 20;
const RADIUS_PER_ROOT_SCORE = 6.32;

// Radius stops growing past this score, so a giant can no longer shrink the
// whole arena to nothing through the camera, and its hitbox stays bounded.
const MAX_SCORE_FOR_RADIUS = 5000;
const MAX_RADIUS = Math.sqrt(MAX_SCORE_FOR_RADIUS) * RADIUS_PER_ROOT_SCORE;

// The walls are lethal now, so spawns keep well clear of them.
const SPAWN_MARGIN = 250;

// Every shark swims at the same speed. Size costs agility instead: a shark
// turns at turnSpeed radians per second, so its tightest circle has radius
// speed/turnSpeed. A fresh shark carves a 45-unit circle; a giant needs 250.
const BASE_SPEED = 250; // pixels per second, for everyone
const BASE_TURN_SPEED = 6.0; // radians per second at zero radius
const MIN_TURN_SPEED = 1.0;
const TURN_RADIUS_DIVISOR = 50;

// Dash trades mass for a burst of speed, giving small sharks an escape and big
// ones a way to close a gap.
const DASH_MIN_SCORE = 20;
const DASH_SCORE_COST = 5;
const DASH_DURATION = 1.0; // seconds
const DASH_MULTIPLIER = 1.5;

const MAX_FOOD = 500;
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
const FOOD_HARD_CAP = 1200;

// Eating is judged on score, not radius. Radius is clamped at both ends now
// (MIN_RADIUS below score 10, MAX_RADIUS above 5000), so it stops being a
// faithful measure of who is bigger. Below the clamps the two are identical:
// radius scales with sqrt(score), so a 1.15x radius edge is a 1.15^2 score edge.
const EAT_RATIO_SCORE = 1.15 ** 2;

// Two sharks too evenly matched to eat each other grind mass off one another,
// and that mass drops to the sea floor as pellets.
const BUMP_DRAIN_PER_SECOND = 0.05;
const BUMP_SCORE_FLOOR = 1;

// A shark that dies to the wall leaves this share of itself behind.
const DEATH_DROP_FRACTION = 0.5;
const DEATH_DROP_MAX = 40;

const MAX_NAME_LENGTH = 12;
const DEFAULT_NAME = 'Shark';

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

function radiusForScore(score) {
  return Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, Math.sqrt(score) * RADIUS_PER_ROOT_SCORE));
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
  player.radius = radiusForScore(player.score);
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
    radius: MIN_RADIUS,
    speed: BASE_SPEED,
    turnSpeed: BASE_TURN_SPEED,
    // Where the mouse points, and where the body has actually swung to.
    // Aim at the middle of the arena so a fresh shark isn't pointed at a wall.
    targetAngle: 0,
    angle: 0,
    // Seconds of dash boost remaining. Shipped to clients so they can show it.
    dashTimer: 0,
  };

  player.targetAngle = Math.atan2(WORLD.height / 2 - player.y, WORLD.width / 2 - player.x);
  // Start facing the way we are aiming, so a spawn doesn't open with a spin.
  player.angle = player.targetAngle;

  refreshPlayerSize(player);
  return player;
}

function makePellet(x, y) {
  return {
    id: Math.random().toString(36).slice(2),
    // Clamping to the safe zone also keeps death and bump drops out of the
    // border, so a shark dying against a wall cannot seed the sink either.
    x: clamp(x, FOOD_MARGIN, WORLD.width - FOOD_MARGIN),
    y: clamp(y, FOOD_MARGIN, WORLD.height - FOOD_MARGIN),
    color: randomHexColor(),
  };
}

/** Appends `count` pellets at random spots and returns just the new ones. */
function generateFood(count) {
  const created = [];

  for (let i = 0; i < count; i += 1) {
    const pellet = makePellet(
      randomBetween(FOOD_MARGIN, WORLD.width - FOOD_MARGIN),
      randomBetween(FOOD_MARGIN, WORLD.height - FOOD_MARGIN),
    );

    gameState.food.push(pellet);
    created.push(pellet);
  }

  return created;
}

/** Scatters `count` pellets around a point, jittered within `spread`. */
function scatterFood(count, x, y, spread) {
  const created = [];

  for (let i = 0; i < count; i += 1) {
    if (gameState.food.length >= FOOD_HARD_CAP) break;

    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * spread;
    const pellet = makePellet(x + Math.cos(angle) * distance, y + Math.sin(angle) * distance);

    gameState.food.push(pellet);
    created.push(pellet);
  }

  return created;
}

/** Eats every pellet overlapping `player`; returns the ids consumed. */
function eatNearbyFood(player) {
  const eaten = [];

  // Walk backwards so splice() can't make us skip the next entry.
  for (let i = gameState.food.length - 1; i >= 0; i -= 1) {
    const food = gameState.food[i];
    const d = Math.hypot(player.x - food.x, player.y - food.y);

    if (d < player.radius + FOOD_RADIUS) {
      gameState.food.splice(i, 1);
      eaten.push(food.id);

      player.score += FOOD_SCORE;
      refreshPlayerSize(player);
    }
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
      tickNewFood.push(...scatterFood(pellets, player.x, player.y, player.radius + 80));
    }
  }

  delete gameState.players[id];
  dropDebt.delete(id);

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
      tickNewFood.push(...scatterFood(pellets, midX, midY, spread));
    }
  }
}

/**
 * Resolves shark-vs-shark overlaps. O(N^2) over pairs, which is fine at this
 * player count. Eating is checked before draining, so a bump that pushes one
 * side under the 15% threshold resolves as a kill on the following tick.
 */
function resolvePlayerCollisions(deltaTime) {
  const ids = Object.keys(gameState.players);

  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = gameState.players[ids[i]];
      const b = gameState.players[ids[j]];

      // Either side may already have been removed earlier in this pass.
      if (!a || !b) continue;

      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d >= a.radius + b.radius) continue;

      // Judged on score, so the verdict still works when either radius is
      // sitting on a clamp. The test is asymmetric, so at most one can hold.
      if (a.score > b.score * EAT_RATIO_SCORE) {
        devour(a, b);
      } else if (b.score > a.score * EAT_RATIO_SCORE) {
        devour(b, a);
      } else {
        grindBump(a, b, deltaTime);
      }
    }
  }
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

  socket.on('dash', () => {
    const player = gameState.players[socket.id];
    if (!player) return;

    // Too small to spare the mass. Re-dashing mid-dash is allowed; the score
    // cost is what keeps it from being spammed.
    if (player.score <= DASH_MIN_SCORE) return;

    player.score -= DASH_SCORE_COST;
    refreshPlayerSize(player);
    player.dashTimer = DASH_DURATION;
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

  // 1. Swing the body toward the aim, move, and the walls bite.
  for (const player of Object.values(gameState.players)) {
    // The mouse sets an intent; how fast the shark can answer depends on size.
    const wanted = angleDelta(player.angle, player.targetAngle);
    const maxTurn = player.turnSpeed * deltaTime;
    player.angle = normalizeAngle(player.angle + clamp(wanted, -maxTurn, maxTurn));

    let speed = player.speed;

    if (player.dashTimer > 0) {
      speed *= DASH_MULTIPLIER;
      player.dashTimer = Math.max(0, player.dashTimer - deltaTime);
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
  resolvePlayerCollisions(deltaTime);

  // 4. Flush. Deaths go out first so a victim learns why before the roster
  //    that no longer contains them.
  for (const death of tickDeaths) {
    io.to(death.id).emit('gameOver', death);
  }

  if (tickEatenFood.length > 0 || tickNewFood.length > 0) {
    io.emit('foodUpdate', { eatenIds: tickEatenFood, newFood: tickNewFood });
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
      `radius caps at ${MAX_RADIUS.toFixed(1)} (score ${MAX_SCORE_FOR_RADIUS})`,
  );
  console.log(`Accepting browser clients from ${CLIENT_ORIGIN}`);
});
