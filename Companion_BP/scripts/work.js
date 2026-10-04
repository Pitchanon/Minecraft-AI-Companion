import { system, BlockVolume, ItemStack } from "@minecraft/server";

const LOGS = new Set(
  ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "pale_oak"]
    .map((wood) => `minecraft:${wood}_log`)
    .concat(["minecraft:crimson_stem", "minecraft:warped_stem"])
);
// A log only counts as a tree when it touches one of these, so the bot leaves log houses alone
const CANOPY = new Set(
  ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "pale_oak", "azalea"]
    .map((wood) => `minecraft:${wood}_leaves`)
    .concat(["minecraft:nether_wart_block", "minecraft:warped_wart_block", "minecraft:shroomlight"])
);

// ore -> [item, min, max]; deepslate and lit variants drop the same thing
const ORE_DROPS = {};
for (const [ore, drop] of Object.entries({
  coal_ore: ["coal", 1, 1],
  iron_ore: ["raw_iron", 1, 1],
  copper_ore: ["raw_copper", 2, 5],
  gold_ore: ["raw_gold", 1, 1],
  redstone_ore: ["redstone", 4, 5],
  lapis_ore: ["lapis_lazuli", 4, 9],
  diamond_ore: ["diamond", 1, 1],
  emerald_ore: ["emerald", 1, 1],
})) {
  ORE_DROPS[`minecraft:${ore}`] = drop;
  ORE_DROPS[`minecraft:deepslate_${ore}`] = drop;
}
ORE_DROPS["minecraft:lit_redstone_ore"] = ORE_DROPS["minecraft:redstone_ore"];
ORE_DROPS["minecraft:lit_deepslate_redstone_ore"] = ORE_DROPS["minecraft:redstone_ore"];
ORE_DROPS["minecraft:nether_gold_ore"] = ["gold_nugget", 2, 6];
ORE_DROPS["minecraft:quartz_ore"] = ["quartz", 1, 1];

const TREE_RANGE = 16;
const ORE_RANGE = 10;
const MAX_LOGS = 64;
const MAX_ORES = 16;
const BREAK_INTERVAL_TICKS = 6;
const ARRIVE_TIMEOUT_TICKS = 20 * 20;
const WAYPOINT_TYPE = "bot:waypoint";

const SIDES = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
const AROUND = [];
for (let x = -1; x <= 1; x++)
  for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) AROUND.push([x, y, z]);

// bot id -> { end } of the job in progress. Only one job runs at a time, so a bot
// never walks to another bot's waypoint (bots target the nearest waypoint).
const tasks = new Map();

export const isLog = (typeId) => LOGS.has(typeId);
export const isOre = (typeId) => typeId in ORE_DROPS;
export const isBusy = (bot) => tasks.has(bot.id);
export const anyJobRunning = () => tasks.size > 0;

/** Stop the bot's job (if any) and put it back to following. */
export function cancelTask(bot) {
  const job = tasks.get(bot.id);
  if (!job) return false;
  job.end();
  return true;
}

/** Waypoints left behind by a job that never finished (e.g. the world was closed mid-job). */
export function removeStrayWaypoints(dimensions) {
  const live = new Set([...tasks.values()].map((job) => job.markerId));
  for (const dimension of dimensions) {
    for (const marker of dimension.getEntities({ type: WAYPOINT_TYPE })) {
      if (!live.has(marker.id)) marker.remove();
    }
  }
}

const offset = (p, [x, y, z]) => ({ x: p.x + x, y: p.y + y, z: p.z + z });
const key = (p) => `${p.x},${p.y},${p.z}`;
const typeAt = (dimension, p) => {
  try {
    return dimension.getBlock(p)?.typeId;
  } catch {
    return undefined; // unloaded chunk or outside the world
  }
};
const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const sameOre = (typeId) => typeId?.replace("lit_", "");

// Connected blocks that satisfy match, nearest-first from the start positions
function collect(dimension, starts, match, limit, neighbors) {
  const found = [];
  const seen = new Set(starts.map(key));
  const queue = [...starts];
  while (queue.length && found.length < limit) {
    const p = queue.shift();
    if (!match(typeAt(dimension, p))) continue;
    found.push(p);
    for (const step of neighbors) {
      const next = offset(p, step);
      if (!seen.has(key(next))) {
        seen.add(key(next));
        queue.push(next);
      }
    }
  }
  return found;
}

function hasCanopy(dimension, logs) {
  return logs.some((p) => SIDES.some((step) => CANOPY.has(typeAt(dimension, offset(p, step)))));
}

function isExposed(dimension, p) {
  return SIDES.some((step) => typeAt(dimension, offset(p, step)) === "minecraft:air");
}

// Block positions of the given types around center, nearest first
function findAround(dimension, center, types, radius, below, above) {
  const c = { x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) };
  const from = { x: c.x - radius, y: Math.max(c.y - below, dimension.heightRange.min), z: c.z - radius };
  const to = { x: c.x + radius, y: Math.min(c.y + above, dimension.heightRange.max - 1), z: c.z + radius };
  let volume;
  try {
    volume = dimension.getBlocks(new BlockVolume(from, to), { includeTypes: [...types] }, false);
  } catch {
    return [];
  }
  const dist = (p) => (p.x - c.x) ** 2 + (p.y - c.y) ** 2 + (p.z - c.z) ** 2;
  return [...volume.getBlockLocationIterator()].sort((a, b) => dist(a) - dist(b));
}

const isNear = (location, p) =>
  Math.hypot(location.x - (p.x + 0.5), location.z - (p.z + 0.5)) <= 2.5 && Math.abs(location.y - p.y) <= 3;

// Walk to positions[0], then break positions one at a time and hand the drops to the player.
// The bot walks by "attacking" an invisible waypoint on the first block, so the game does the
// pathfinding; once there it keeps swinging at it, which looks like chopping.
function runJob(bot, player, positions, dropFor, sound, messages) {
  cancelTask(bot);
  const dimension = bot.dimension;
  const target = positions[0];
  const marker = dimension.spawnEntity(WAYPOINT_TYPE, { x: target.x + 0.5, y: target.y, z: target.z + 0.5 });
  bot.triggerEvent("bot:work_start");
  player.sendMessage(messages.start);

  let index = 0;
  let collected = 0;
  let waited = 0;
  let arrived = false;
  const job = { markerId: marker.id };
  job.end = (message) => {
    system.clearRun(job.runId);
    tasks.delete(bot.id);
    if (marker.isValid) marker.remove();
    if (bot.isValid) bot.triggerEvent("bot:work_end");
    if (message && player.isValid) player.sendMessage(message);
  };

  job.runId = system.runInterval(() => {
    if (!bot.isValid) return job.end();
    if (!arrived) {
      arrived = isNear(bot.location, target);
      waited += BREAK_INTERVAL_TICKS;
      if (!arrived) {
        if (waited >= ARRIVE_TIMEOUT_TICKS) job.end(messages.unreachable);
        return;
      }
    }
    const p = positions[index++];
    const block = dimension.getBlock(p);
    const drop = block && dropFor(block.typeId);
    if (drop) {
      block.setType("minecraft:air");
      dimension.playSound(sound, p);
      const to = player.isValid && player.dimension.id === dimension.id ? player.location : p;
      dimension.spawnItem(drop, to);
      collected += drop.amount;
    }
    if (index >= positions.length) job.end(messages.done(collected));
  }, BREAK_INTERVAL_TICKS);
  tasks.set(bot.id, job);
}

const logDrop = (typeId) => (LOGS.has(typeId) ? new ItemStack(typeId, 1) : undefined);
const oreDrop = (typeId) => {
  const drop = ORE_DROPS[typeId];
  return drop && new ItemStack(`minecraft:${drop[0]}`, randomInt(drop[1], drop[2]));
};
const byHeight = (a, b) => a.y - b.y;

/** Chop the nearest tree around the player. Returns a message when there is nothing to do. */
export function chopTree(bot, player, prefix) {
  const dimension = player.dimension;
  for (const start of findAround(dimension, player.location, LOGS, TREE_RANGE, 4, 12).slice(0, 8)) {
    const logs = collect(dimension, [start], isLog, MAX_LOGS, AROUND);
    if (!hasCanopy(dimension, logs)) continue;
    runJob(bot, player, logs.sort(byHeight), logDrop, "dig.wood", {
      start: prefix + "กำลังเดินไปตัดต้นไม้นะ!",
      done: (n) => prefix + `ตัดเสร็จแล้ว ได้ไม้ ${n} ชิ้น`,
      unreachable: prefix + "เดินไปที่ต้นไม้ไม่ได้ ลองพาไปใกล้ ๆ อีกนิด",
    });
    return;
  }
  player.sendMessage(prefix + `ไม่เจอต้นไม้ในระยะ ${TREE_RANGE} บล็อก`);
}

/** Mine the nearest ore vein the player can see (touching air). */
export function mineOres(bot, player, prefix) {
  const dimension = player.dimension;
  const ores = Object.keys(ORE_DROPS);
  const start = findAround(dimension, player.location, ores, ORE_RANGE, 8, 8).find((p) => isExposed(dimension, p));
  if (!start) {
    player.sendMessage(prefix + `ไม่เจอแร่ที่มองเห็นในระยะ ${ORE_RANGE} บล็อก`);
    return;
  }
  const kind = sameOre(typeAt(dimension, start));
  const vein = collect(dimension, [start], (t) => sameOre(t) === kind, MAX_ORES, SIDES);
  runJob(bot, player, vein, oreDrop, "dig.stone", {
    start: prefix + "กำลังเดินไปขุดแร่นะ!",
    done: (n) => prefix + `ขุดเสร็จแล้ว ได้ของ ${n} ชิ้น`,
    unreachable: prefix + "เดินไปที่แร่ไม่ได้ ลองพาไปใกล้ ๆ อีกนิด",
  });
}

/** Helper mode: the player just broke a log or ore at p, the bot finishes the rest. */
export function finishWhatPlayerStarted(bot, player, brokenType, p, prefix) {
  const dimension = player.dimension;
  const starts = AROUND.map((step) => offset(p, step));
  if (isLog(brokenType)) {
    const logs = collect(dimension, starts, isLog, MAX_LOGS, AROUND);
    if (logs.length === 0 || !hasCanopy(dimension, logs)) return;
    runJob(bot, player, logs.sort(byHeight), logDrop, "dig.wood", {
      start: prefix + "เดี๋ยวช่วยตัดต่อนะ!",
      done: (n) => prefix + `ช่วยตัดอีก ${n} ชิ้นแล้ว`,
      unreachable: prefix + "เดินไปช่วยไม่ได้ ต้นนี้อยู่ไกลไป",
    });
  } else if (isOre(brokenType)) {
    const kind = sameOre(brokenType);
    const vein = collect(dimension, starts, (t) => sameOre(t) === kind, MAX_ORES, SIDES);
    if (vein.length === 0) return;
    runJob(bot, player, vein, oreDrop, "dig.stone", {
      start: prefix + "เดี๋ยวช่วยขุดต่อนะ!",
      done: (n) => prefix + `ช่วยขุดอีก ${n} ชิ้นแล้ว`,
      unreachable: prefix + "เดินไปช่วยไม่ได้ แร่อยู่ไกลไป",
    });
  }
}
