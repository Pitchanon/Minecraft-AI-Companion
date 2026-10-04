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

const SIDES = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
const AROUND = [];
for (let x = -1; x <= 1; x++)
  for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) AROUND.push([x, y, z]);

const tasks = new Map(); // bot id -> run id of the job in progress

export const isLog = (typeId) => LOGS.has(typeId);
export const isOre = (typeId) => typeId in ORE_DROPS;
export const isBusy = (bot) => tasks.has(bot.id);

export function cancelTask(bot) {
  const runId = tasks.get(bot.id);
  if (runId === undefined) return false;
  system.clearRun(runId);
  tasks.delete(bot.id);
  return true;
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

// Put the bot on a free spot beside the block so it looks like it walked over
function standNear(bot, p) {
  const dimension = bot.dimension;
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    for (const y of [0, -1, 1]) {
      const feet = { x: p.x + x, y: p.y + y, z: p.z + z };
      const free =
        typeAt(dimension, feet) === "minecraft:air" &&
        typeAt(dimension, offset(feet, [0, 1, 0])) === "minecraft:air" &&
        typeAt(dimension, offset(feet, [0, -1, 0])) !== "minecraft:air";
      if (free && bot.tryTeleport({ x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 })) return;
    }
  }
}

// Break positions one at a time and hand the drops to the player
function runJob(bot, player, positions, dropFor, sound, doneMessage) {
  cancelTask(bot);
  standNear(bot, positions[0]);
  bot.triggerEvent("bot:sit");

  let index = 0;
  let collected = 0;
  const runId = system.runInterval(() => {
    const finished = !bot.isValid || index >= positions.length;
    if (!finished) {
      const p = positions[index++];
      const block = bot.dimension.getBlock(p);
      const drop = block && dropFor(block.typeId);
      if (drop) {
        block.setType("minecraft:air");
        bot.dimension.playSound(sound, p);
        const target = player.isValid && player.dimension.id === bot.dimension.id ? player.location : p;
        bot.dimension.spawnItem(drop, target);
        collected += drop.amount;
      }
      if (index < positions.length) return;
    }
    system.clearRun(runId);
    tasks.delete(bot.id);
    if (bot.isValid) bot.triggerEvent("bot:follow");
    if (player.isValid) player.sendMessage(doneMessage(collected));
  }, BREAK_INTERVAL_TICKS);
  tasks.set(bot.id, runId);
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
    player.sendMessage(prefix + "ไปตัดต้นไม้นะ!");
    runJob(bot, player, logs.sort(byHeight), logDrop, "dig.wood", (n) => prefix + `ตัดเสร็จแล้ว ได้ไม้ ${n} ชิ้น`);
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
  player.sendMessage(prefix + "ไปขุดแร่นะ!");
  runJob(bot, player, vein, oreDrop, "dig.stone", (n) => prefix + `ขุดเสร็จแล้ว ได้ของ ${n} ชิ้น`);
}

/** Helper mode: the player just broke a log or ore at p, the bot finishes the rest. */
export function finishWhatPlayerStarted(bot, player, brokenType, p, prefix) {
  const dimension = player.dimension;
  const starts = AROUND.map((step) => offset(p, step));
  if (isLog(brokenType)) {
    const logs = collect(dimension, starts, isLog, MAX_LOGS, AROUND);
    if (logs.length === 0 || !hasCanopy(dimension, logs)) return;
    runJob(bot, player, logs.sort(byHeight), logDrop, "dig.wood", (n) => prefix + `ช่วยตัดอีก ${n} ชิ้นแล้ว`);
  } else if (isOre(brokenType)) {
    const kind = sameOre(brokenType);
    const vein = collect(dimension, starts, (t) => sameOre(t) === kind, MAX_ORES, SIDES);
    if (vein.length === 0) return;
    runJob(bot, player, vein, oreDrop, "dig.stone", (n) => prefix + `ช่วยขุดอีก ${n} ชิ้นแล้ว`);
  }
}
