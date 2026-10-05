import { world, system, ItemStack, CommandPermissionLevel, CustomCommandStatus } from "@minecraft/server";
import { ActionFormData, FormCancelationReason } from "@minecraft/server-ui";
import {
  anyJobRunning,
  cancelTask,
  chopTree,
  finishWhatPlayerStarted,
  isBusy,
  isLog,
  isOre,
  mineOres,
  removeStrayWaypoints,
} from "./work.js";
import { VERSION } from "./version.js";

const BOT_TYPE = "bot:companion";
const REMOTE_TYPE = "bot:remote";
const OWNER_PROP = "bot:owner"; // on the bot: id of the player who owns it
const GOT_REMOTE_PROP = "bot:got_remote"; // on the player: remote already handed out once
const HELPER_PROP = "bot:helper"; // on the player: bot finishes trees/veins the player starts
const DEBUG_PROP = "bot:debug"; // on the player: show remote/menu events in chat

// If the world loads this add-on twice (e.g. an old version left active next to the new one),
// every copy reacts to the same remote press and each opens its own menu. Copies announce
// themselves with a script event; only the newest copy acts, and players are warned.
const INSTANCE_ID = Math.random().toString(36).slice(2, 10);
const otherCopies = new Map(); // instance id -> version of other loaded copies
let commandsTaken = false; // another copy registered the /bot: commands first

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function isActiveCopy() {
  for (const [id, version] of otherCopies) {
    const cmp = compareVersions(version, VERSION);
    if (cmp > 0 || (cmp === 0 && id > INSTANCE_ID)) return false;
  }
  return true;
}
const DIMENSIONS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];
const PREFIX = "§b[บอท]§r ";

const MAX_BOTS_PER_PLAYER = 3;
const MAX_BOTS_IN_WORLD = 10;

const LOW_HEALTH = 8; // 4 hearts
const HEAL_RANGE = 16;
const HEAL_AMOUNT = 6; // 3 hearts right away, then regeneration on top
const HEAL_COOLDOWN_TICKS = 20 * 20;
const lastHealTick = new Map();

// Punching your own bot STOP_HITS times within STOP_WINDOW_TICKS means "stop what you're doing"
const STOP_HITS = 3;
const STOP_WINDOW_TICKS = 3 * 20;
const CALM_TICKS = 10 * 20;
const recentHits = new Map(); // bot id -> ticks of recent hits
const calmTimers = new Map(); // bot id -> run id of the pending resume_combat
const WORK_RANGE = 16;

// Script can only see bots in loaded chunks; a bot left far away is invisible until you go back.
function loadedBots() {
  return DIMENSIONS.flatMap((id) => world.getDimension(id).getEntities({ type: BOT_TYPE }));
}

function ownedBots(player) {
  return loadedBots().filter((bot) => bot.getDynamicProperty(OWNER_PROP) === player.id);
}

function linkOwner(bot, player) {
  bot.setDynamicProperty(OWNER_PROP, player.id);
  bot.nameTag = `${player.name} Bot`;
}

// Where each bot was when it left the loaded area, so the owner can find it again. Written only
// when a bot unloads (no polling); entries for bots that are loaded again are simply ignored.
const FAR_PROP = "bot:far"; // on the world: JSON { botId: { owner, name, dim, x, y, z } }
const DIM_NAMES = { "minecraft:overworld": "โลกปกติ", "minecraft:nether": "เนเธอร์", "minecraft:the_end": "ดิเอนด์" };
const sentHome = new Set(); // ids of bots this script is removing on purpose

function readFar() {
  try {
    return JSON.parse(world.getDynamicProperty(FAR_PROP) ?? "{}");
  } catch {
    return {};
  }
}

function updateFar(change) {
  const far = readFar();
  if (change(far) === false) return;
  world.setDynamicProperty(FAR_PROP, Object.keys(far).length ? JSON.stringify(far) : undefined);
}

function farBots(player) {
  const loaded = new Set(loadedBots().map((bot) => bot.id));
  return Object.entries(readFar())
    .filter(([id, bot]) => bot.owner === player.id && !loaded.has(id))
    .map(([, bot]) => bot);
}

function farLines(bots) {
  return bots.map((b) => `${b.name}: x ${b.x} y ${b.y} z ${b.z} (${DIM_NAMES[b.dim] ?? b.dim})`).join("\n");
}

function notFoundMessage(player, fallback) {
  const far = farBots(player);
  return far.length ? "บอทอยู่ไกล ไปหาตามพิกัดนี้ได้เลย ของที่ฝากยังอยู่ในตัวบอท\n" + farLines(far) : fallback;
}

function summonBot(player) {
  const count = ownedBots(player).length;
  if (count >= MAX_BOTS_PER_PLAYER) {
    player.sendMessage(PREFIX + `มีบอทครบ ${MAX_BOTS_PER_PLAYER} ตัวแล้ว ส่งบอทกลับบ้านก่อนถึงจะเรียกตัวใหม่ได้`);
    return;
  }
  if (loadedBots().length >= MAX_BOTS_IN_WORLD) {
    player.sendMessage(PREFIX + "ในโลกนี้มีบอทเยอะเกินไปแล้ว");
    return;
  }
  const bot = player.dimension.spawnEntity(BOT_TYPE, player.location);
  linkOwner(bot, player);
  // entity_spawned adds the wild group (with minecraft:tameable) on spawn; tame on the next tick
  system.runTimeout(() => {
    if (!bot.isValid) return;
    bot.getComponent("minecraft:tameable")?.tame(player);
    bot.triggerEvent("bot:on_tame");
  }, 1);
  player.sendMessage(PREFIX + `สวัสดีครับ! มาเป็นเพื่อนแล้ว (${count + 1}/${MAX_BOTS_PER_PLAYER})`);
  const far = farBots(player);
  if (far.length) player.sendMessage(PREFIX + "§eบอทตัวเก่ายังรออยู่ ของที่ฝากยังอยู่ในตัวมัน§r\n" + farLines(far));
}

function forEachBot(player, action, message) {
  const bots = ownedBots(player);
  if (bots.length === 0) {
    player.sendMessage(PREFIX + notFoundMessage(player, "หาบอทไม่เจอ ลองเรียกบอทตัวใหม่ได้เลย"));
    return;
  }
  bots.forEach(action);
  player.sendMessage(PREFIX + message);
}

function bringBots(player) {
  forEachBot(
    player,
    (bot) => {
      cancelTask(bot);
      bot.teleport(player.location, { dimension: player.dimension });
      bot.triggerEvent("bot:follow");
    },
    "มาแล้วครับ!"
  );
}

function stopBot(bot) {
  cancelTask(bot);
  bot.triggerEvent("bot:stop");

  const pending = calmTimers.get(bot.id);
  if (pending !== undefined) system.clearRun(pending);
  calmTimers.set(
    bot.id,
    system.runTimeout(() => {
      calmTimers.delete(bot.id);
      if (bot.isValid) bot.triggerEvent("bot:resume_combat");
    }, CALM_TICKS)
  );
}

function botContainer(bot) {
  return bot.getComponent("minecraft:inventory")?.container;
}

// remove() deletes the bot without dropping loot, so drop what was stored first
function dropStoredItems(bot) {
  const container = botContainer(bot);
  if (!container) return;
  for (let slot = 0; slot < container.size; slot++) {
    const item = container.getItem(slot);
    if (!item) continue;
    bot.dimension.spawnItem(item, bot.location);
    container.setItem(slot);
  }
}

function removeBots(player) {
  const bots = ownedBots(player);
  const far = farBots(player); // before removing, while the bots being sent home still count as loaded
  bots.forEach((bot) => {
    cancelTask(bot);
    dropStoredItems(bot);
    sentHome.add(bot.id);
    bot.remove();
  });
  player.sendMessage(PREFIX + (bots.length ? `ส่งบอทกลับบ้านแล้ว ${bots.length} ตัว` : "ไม่มีบอทอยู่ใกล้ ๆ"));
  if (far.length) player.sendMessage(PREFIX + "บอทที่อยู่ไกลยังส่งกลับบ้านไม่ได้ ต้องไปหาก่อน\n" + farLines(far));
}

// teleport_to_owner only works inside one dimension and only while the bot is loaded, so a
// following bot is left behind when its owner changes dimension or dies and respawns far away.
// Bring those bots along once; the destination may still be loading, so retry for a few seconds.
const BRING_EVERY_TICKS = 5;
const BRING_TRIES = 20;
const botsAtDeath = new Map(); // player id -> bots that were following when the player died

function followingBots(player, dimension) {
  return ownedBots(player).filter(
    (bot) => bot.getProperty("bot:following") && (!dimension || bot.dimension.id === dimension.id)
  );
}

function bringAlong(player, bots, why) {
  if (!bots.length) return;
  let pending = bots;
  let tries = 0;
  const runId = system.runInterval(() => {
    tries++;
    if (player.isValid) {
      pending = pending.filter((bot) => bot.isValid && !bot.tryTeleport(player.location, { dimension: player.dimension }));
    }
    if (pending.length && tries < BRING_TRIES) return;
    system.clearRun(runId);
    if (player.isValid) debug(player, `${why}: brought ${bots.length - pending.length}/${bots.length} bots`);
  }, BRING_EVERY_TICKS);
}

function giveRemote(player) {
  player.getComponent("minecraft:inventory")?.container?.addItem(new ItemStack(REMOTE_TYPE, 1));
  player.setDynamicProperty(GOT_REMOTE_PROP, true);
}

// Leaving a job first gives combat back, then the new mode applies
function switchMode(bot, event) {
  cancelTask(bot);
  bot.triggerEvent(event);
}

// The closest bot of this player that is not already working
function idleBot(player) {
  const dist = (bot) => (bot.dimension.id === player.dimension.id ? distanceTo(bot, player) : Infinity);
  return ownedBots(player)
    .filter((bot) => !isBusy(bot) && dist(bot) <= WORK_RANGE * 2)
    .sort((a, b) => dist(a) - dist(b))[0];
}

function distanceTo(a, b) {
  const p = a.location;
  const q = b.location;
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
}

function assignWork(player, job) {
  if (anyJobRunning()) {
    player.sendMessage(PREFIX + "บอทกำลังทำงานอีกงานอยู่ รอให้เสร็จก่อน หรือกดหยุด");
    return;
  }
  const bot = idleBot(player);
  if (!bot) {
    player.sendMessage(
      PREFIX + (ownedBots(player).length ? "บอททุกตัวกำลังทำงานอยู่ หรืออยู่ไกลเกินไป" : notFoundMessage(player, "ต้องเรียกบอทก่อนนะ"))
    );
    return;
  }
  job(bot, player, PREFIX);
}

function toggleHelper(player) {
  const on = !player.getDynamicProperty(HELPER_PROP);
  player.setDynamicProperty(HELPER_PROP, on);
  player.sendMessage(
    PREFIX + (on ? "เปิดโหมดช่วยงาน: ตัดไม้หรือขุดแร่ก้อนแรก แล้วบอทจะช่วยทำส่วนที่เหลือ" : "ปิดโหมดช่วยงานแล้ว")
  );
}

const ACTIONS = {
  summon: summonBot,
  here: bringBots,
  follow: (p) => forEachBot(p, (bot) => switchMode(bot, "bot:follow"), "ตามไปด้วยครับ!"),
  sit: (p) => forEachBot(p, (bot) => switchMode(bot, "bot:sit"), "รอตรงนี้นะครับ"),
  stop: (p) => forEachBot(p, stopBot, "โอเค หยุดแล้วครับ"),
  remove: removeBots,
  remote: giveRemote,
  chop: (p) => assignWork(p, chopTree),
  mine: (p) => assignWork(p, mineOres),
  helper: toggleHelper,
  debug: (p) => toggleDebug(p),
};

// A new press of the remote needs this many quiet ticks since the previous itemUse event or
// since the last menu closed. While the use button is held (or the game still thinks it is
// after a menu closes) itemUse keeps arriving every few ticks, and each of those must not
// open the menu again.
const NEW_PRESS_GAP_TICKS = 10;
const playersInMenu = new Set();
const lastUseTick = new Map(); // player id -> tick of the latest remote itemUse event
const menuClosedTick = new Map(); // player id -> tick the last menu closed

function debug(player, text) {
  if (player.getDynamicProperty(DEBUG_PROP)) player.sendMessage(`§7[debug t${system.currentTick}] ${text}`);
}

// A form can come back as UserBusy while another screen is still closing; wait and try again
async function showForm(player, form, name) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await form.show(player);
    debug(player, `${name}: ${res.canceled ? res.cancelationReason : "selected " + res.selection}`);
    if (res.cancelationReason !== FormCancelationReason.UserBusy) return res;
    await system.waitTicks(5);
  }
  console.warn(`[bot] ${name} for ${player.name} stayed busy, gave up`);
  return undefined;
}

async function openWorkMenu(player) {
  const helperOn = !!player.getDynamicProperty(HELPER_PROP);
  const buttons = [
    ["ตัดต้นไม้ใกล้ ๆ 1 ต้น", "textures/items/iron_axe", ACTIONS.chop],
    ["ขุดแร่ใกล้ ๆ", "textures/items/iron_pickaxe", ACTIONS.mine],
    [helperOn ? "ช่วยตามที่ฉันทำ: §aเปิดอยู่" : "ช่วยตามที่ฉันทำ: §cปิดอยู่", "textures/items/book_enchanted", ACTIONS.helper],
  ];
  const form = new ActionFormData()
    .title("สั่งงานบอท")
    .body(
      "บอทจะทำงานรอบตัวคุณไม่เกิน 16 บล็อก แล้วเอาของมาให้\n" +
        "ต่อยบอท 3 ครั้งเพื่อให้หยุดกลางคัน\n\n" +
        "§dช่วยตามที่ฉันทำ:§r เมื่อเปิดไว้ ถ้าคุณตัดไม้หรือขุดแร่ก้อนแรก บอทจะช่วยทำส่วนที่เหลือของต้นหรือสายแร่นั้น"
    );
  for (const [label, icon] of buttons) form.button(label, icon);
  const res = await showForm(player, form, "work menu");
  if (!res || res.canceled || res.selection === undefined) return;
  buttons[res.selection][2](player);
}

async function confirmRemove(player) {
  const form = new ActionFormData()
    .title("ส่งบอทกลับบ้าน")
    .body("บอทของคุณทุกตัวจะหายไป ของที่ฝากไว้จะหล่นที่พื้น\nแน่ใจไหม?")
    .button("ใช่ ส่งกลับบ้าน", "textures/ui/trash")
    .button("ไม่ใช่", "textures/ui/cancel");
  const res = await showForm(player, form, "confirm remove");
  if (res && !res.canceled && res.selection === 0) removeBots(player);
}

// Let the main menu finish closing before the next screen opens
async function thenOpen(player, openNext) {
  await system.waitTicks(2);
  await openNext(player);
}

async function openMenu(player) {
  const count = ownedBots(player).length;
  const far = farBots(player);
  const full = count >= MAX_BOTS_PER_PLAYER;
  const buttons = [
    [full ? "§7เรียกบอทตัวใหม่ (เต็มแล้ว)" : "เรียกบอทตัวใหม่", "textures/items/egg", ACTIONS.summon],
    ["สั่งงาน (ตัดไม้ / ขุดแร่)", "textures/items/iron_axe", (p) => thenOpen(p, openWorkMenu)],
    ["เรียกบอทมาหา", "textures/items/ender_pearl", ACTIONS.here],
    ["ให้เดินตาม", "textures/items/lead", ACTIONS.follow],
    ["ให้รอตรงนี้", "textures/items/bed_red", ACTIONS.sit],
    ["หยุดสิ่งที่ทำอยู่", "textures/ui/cancel", ACTIONS.stop],
    ["ส่งบอทกลับบ้าน", "textures/ui/trash", (p) => thenOpen(p, confirmRemove)],
  ];

  const form = new ActionFormData()
    .title("รีโมทเพื่อนบอท")
    .body(
      `บอทของคุณ: §a${count}/${MAX_BOTS_PER_PLAYER}§r ตัว\n` +
        (far.length ? `§eอยู่ไกล:§r\n${farLines(far)}\n` : "") +
        "\n" +
        "§dคำแนะนำ:§r ต่อยบอท 3 ครั้งติดกันเพื่อสั่งให้หยุด\nถ้าบอทติดหรืออยู่ไกล กด \"เรียกบอทมาหา\"\n\n" +
        `§8v${VERSION}`
    );
  for (const [label, icon] of buttons) form.button(label, icon);

  const res = await showForm(player, form, "main menu");
  if (!res || res.canceled || res.selection === undefined) return;
  await buttons[res.selection][2](player);
}

function toggleDebug(player) {
  const on = !player.getDynamicProperty(DEBUG_PROP);
  player.setDynamicProperty(DEBUG_PROP, on);
  player.sendMessage(PREFIX + (on ? "เปิดโหมด debug ของรีโมทแล้ว" : "ปิดโหมด debug ของรีโมทแล้ว"));
}

function registerBotCommand(registry, name, description, action) {
  try {
    registry.registerCommand(
    {
      name: `bot:${name}`,
      description,
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
    },
    (origin) => {
      const player = origin.sourceEntity;
      if (player?.typeId !== "minecraft:player") {
        return { status: CustomCommandStatus.Failure, message: "ใช้ได้เฉพาะผู้เล่น" };
      }
      // apply world changes on the next tick, outside the command callback
      system.run(() => action(player));
      return { status: CustomCommandStatus.Success };
    }
  );
  } catch (e) {
    if (e?.reason !== "AlreadyRegistered") throw e;
    commandsTaken = true;
    console.warn(`[bot] /bot:${name} is already registered by another copy of this add-on`);
  }
}

system.beforeEvents.startup.subscribe(({ customCommandRegistry: registry }) => {
  registerBotCommand(registry, "summon", "เรียกบอทตัวใหม่", ACTIONS.summon);
  registerBotCommand(registry, "here", "เรียกบอททุกตัวมาหา ใช้ตอนบอทติดหรืออยู่ไกล", ACTIONS.here);
  registerBotCommand(registry, "follow", "ให้บอทเดินตาม", ACTIONS.follow);
  registerBotCommand(registry, "sit", "ให้บอทรออยู่ตรงนี้", ACTIONS.sit);
  registerBotCommand(registry, "stop", "ให้บอทหยุดสิ่งที่ทำอยู่", ACTIONS.stop);
  registerBotCommand(registry, "kill", "ส่งบอททุกตัวกลับบ้าน (ลบบอท)", ACTIONS.remove);
  registerBotCommand(registry, "remote", "รับรีโมทบอทอันใหม่", ACTIONS.remote);
  registerBotCommand(registry, "chop", "ให้บอทตัดต้นไม้ใกล้ ๆ 1 ต้น", ACTIONS.chop);
  registerBotCommand(registry, "mine", "ให้บอทขุดแร่ใกล้ ๆ", ACTIONS.mine);
  registerBotCommand(registry, "helper", "เปิด/ปิดโหมดให้บอทช่วยตามที่คุณทำ", ACTIONS.helper);
  registerBotCommand(registry, "debug", "เปิด/ปิดการแสดงเหตุการณ์ของรีโมทในแชต (ไว้หาบั๊ก)", ACTIONS.debug);
});

world.afterEvents.itemUse.subscribe(async ({ itemStack, source: player }) => {
  if (itemStack?.typeId !== REMOTE_TYPE || !isActiveCopy()) return;
  const now = system.currentTick;
  const quietSince = Math.max(lastUseTick.get(player.id) ?? -Infinity, menuClosedTick.get(player.id) ?? -Infinity);
  lastUseTick.set(player.id, now);
  if (playersInMenu.has(player.id)) return debug(player, "remote use ignored: menu open");
  if (now - quietSince < NEW_PRESS_GAP_TICKS) return debug(player, `remote use ignored: ${now - quietSince} ticks since last use/close`);

  debug(player, "remote use opens menu");
  playersInMenu.add(player.id);
  try {
    await openMenu(player);
  } finally {
    playersInMenu.delete(player.id);
    menuClosedTick.set(player.id, system.currentTick);
  }
});

world.afterEvents.playerBreakBlock.subscribe(({ player, block, brokenBlockPermutation }) => {
  if (!isActiveCopy() || !player.getDynamicProperty(HELPER_PROP)) return;
  const brokenType = brokenBlockPermutation.type.id;
  if (!isLog(brokenType) && !isOre(brokenType)) return;
  if (anyJobRunning()) return;
  const bot = idleBot(player);
  if (bot) finishWhatPlayerStarted(bot, player, brokenType, block.location, PREFIX);
});

world.afterEvents.entityDie.subscribe(
  ({ deadEntity: player }) => {
    if (!isActiveCopy()) return;
    const bots = followingBots(player);
    if (bots.length) botsAtDeath.set(player.id, bots);
  },
  { entityTypes: ["minecraft:player"] }
);

world.afterEvents.playerDimensionChange.subscribe(({ player, fromDimension }) => {
  if (isActiveCopy()) bringAlong(player, followingBots(player, fromDimension), "dimension change");
});

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (!initialSpawn) {
    const bots = botsAtDeath.get(player.id);
    botsAtDeath.delete(player.id);
    if (bots && isActiveCopy()) bringAlong(player, bots, "respawn");
    return;
  }
  if (!isActiveCopy()) return;
  if (!player.getDynamicProperty(GOT_REMOTE_PROP)) giveRemote(player);
  player.sendMessage(PREFIX + `พร้อมแล้ว (v${VERSION})`);
  if (otherCopies.size || commandsTaken) {
    const versions = [VERSION, ...otherCopies.values()].join(", ");
    player.sendMessage(
      PREFIX +
        `§cพบ add-on นี้เปิดอยู่มากกว่า 1 ชุดในโลกนี้ (${otherCopies.size ? versions : "มีชุดเก่าที่ไม่บอกเวอร์ชัน"}) ` +
        "ให้ปิดชุดเก่าใน Behavior Packs ของโลก หรือลบใน Settings > Storage ไม่อย่างนั้นเมนูจะเด้งซ้ำ"
    );
  }
});

world.afterEvents.worldLoad.subscribe(() => system.sendScriptEvent("bot:hello", `${INSTANCE_ID}|${VERSION}`));

system.afterEvents.scriptEventReceive.subscribe(({ id, message }) => {
  if (id !== "bot:hello") return;
  const [otherId, version] = message.split("|");
  if (otherId === INSTANCE_ID || otherCopies.has(otherId)) return;
  otherCopies.set(otherId, version);
  console.warn(`[bot] another copy of this add-on is loaded: v${version} (this one is v${VERSION})`);
  // answer so a copy that loaded later also learns about this one
  system.sendScriptEvent("bot:hello", `${INSTANCE_ID}|${VERSION}`);
});

// /summon bot:companion skips the per-player limit, so cap the world total here
// /bot:debug: show the owner every hit their bots give or take, and each bot's combat state
world.afterEvents.entityHurt.subscribe(({ hurtEntity, damage, damageSource }) => {
  if (!isActiveCopy()) return;
  const attacker = damageSource.damagingEntity;
  const bot = attacker?.typeId === BOT_TYPE ? attacker : hurtEntity.typeId === BOT_TYPE ? hurtEntity : undefined;
  if (!bot || !bot.isValid) return;
  const owner = world.getEntity(bot.getDynamicProperty(OWNER_PROP) ?? "");
  if (owner?.typeId !== "minecraft:player") return;
  if (bot === attacker) debug(owner, `bot hit ${hurtEntity.typeId} for ${damage}`);
  else debug(owner, `bot was hit by ${attacker?.typeId ?? damageSource.cause} for ${damage}`);
});

system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    if (!player.getDynamicProperty(DEBUG_PROP) || !isActiveCopy()) continue;
    for (const bot of ownedBots(player)) {
      const container = botContainer(bot);
      const stored = container ? container.size - container.emptySlotsCount : "no inventory";
      debug(player, `${bot.nameTag} [${bot.id}]: fighting=${bot.getProperty("bot:fighting")} busy=${isBusy(bot)} stored=${stored}`);
    }
  }
}, 5 * 20);

world.afterEvents.entitySpawn.subscribe(({ entity }) => {
  if (entity.typeId !== BOT_TYPE) return;
  if (loadedBots().length <= MAX_BOTS_IN_WORLD) return;
  sentHome.add(entity.id);
  entity.remove();
});

// Before events run in restricted mode; if the world write is refused there, do it next tick
function writeNowOrSoon(write) {
  try {
    write();
  } catch {
    system.run(write);
  }
}

// Fires for every entity that unloads or is removed, so leave right away for anything else
world.beforeEvents.entityRemove.subscribe(({ removedEntity: bot }) => {
  if (bot.typeId !== BOT_TYPE || !isActiveCopy()) return;
  const id = bot.id;
  const gone = sentHome.delete(id) || !(bot.getComponent("minecraft:health")?.currentValue > 0);
  if (gone) {
    writeNowOrSoon(() =>
      updateFar((far) => {
        if (!(id in far)) return false;
        delete far[id];
      })
    );
    return;
  }
  const owner = bot.getDynamicProperty(OWNER_PROP);
  if (!owner) return;
  const { x, y, z } = bot.location;
  const entry = { owner, name: bot.nameTag, dim: bot.dimension.id, x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
  writeNowOrSoon(() =>
    updateFar((far) => {
      far[id] = entry;
    })
  );
});

// A bot tamed with an apple or cookie: the nearest player is the one who fed it
world.afterEvents.dataDrivenEntityTrigger.subscribe(
  ({ entity: bot }) => {
    if (bot.getDynamicProperty(OWNER_PROP)) return;
    const [player] = bot.dimension.getEntities({
      type: "minecraft:player",
      location: bot.location,
      maxDistance: 8,
      closest: 1,
    });
    if (!player) return;
    linkOwner(bot, player);
    player.sendMessage(PREFIX + "ขอบคุณครับ! จากนี้จะตามไปทุกที่");
  },
  { entityTypes: [BOT_TYPE], eventTypes: ["bot:on_tame"] }
);

world.afterEvents.entityHitEntity.subscribe(({ damagingEntity: player, hitEntity: bot }) => {
  if (bot.typeId !== BOT_TYPE || player.typeId !== "minecraft:player" || !isActiveCopy()) return;
  if (!bot.getComponent("minecraft:is_tamed")) return;
  const owner = bot.getDynamicProperty(OWNER_PROP);
  if (owner && owner !== player.id) return;

  const now = system.currentTick;
  const hits = (recentHits.get(bot.id) ?? []).filter((tick) => now - tick < STOP_WINDOW_TICKS);
  hits.push(now);
  if (hits.length < STOP_HITS) {
    recentHits.set(bot.id, hits);
    return;
  }
  recentHits.delete(bot.id);
  stopBot(bot);
  player.sendMessage(PREFIX + "โอเค หยุดแล้วครับ");
});

system.runInterval(() => {
  if (!isActiveCopy()) return;
  for (const player of world.getAllPlayers()) {
    const health = player.getComponent("minecraft:health");
    if (!health || health.currentValue <= 0 || health.currentValue > LOW_HEALTH) continue;

    const last = lastHealTick.get(player.id);
    if (last !== undefined && system.currentTick - last < HEAL_COOLDOWN_TICKS) continue;

    const helper = player.dimension
      .getEntities({ type: BOT_TYPE, location: player.location, maxDistance: HEAL_RANGE })
      .find((bot) => bot.getDynamicProperty(OWNER_PROP) === player.id);
    if (!helper) continue;

    lastHealTick.set(player.id, system.currentTick);
    try {
      health.setCurrentValue(Math.min(health.currentValue + HEAL_AMOUNT, health.effectiveMax));
      player.addEffect("minecraft:regeneration", 5 * 20, { amplifier: 1 });
      player.sendMessage(PREFIX + "ระวังนะ! ฟื้นเลือดให้แล้ว");
    } catch (e) {
      console.warn(`[bot] heal failed: ${e}`);
    }
  }
}, 20);

// An inactive copy would see the active copy's waypoints as strays, so only the active copy cleans up
system.runInterval(() => {
  if (isActiveCopy()) removeStrayWaypoints(DIMENSIONS.map((id) => world.getDimension(id)));
}, 10 * 20);
