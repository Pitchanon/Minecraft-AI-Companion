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

const BOT_TYPE = "bot:companion";
const REMOTE_TYPE = "bot:remote";
const OWNER_PROP = "bot:owner"; // on the bot: id of the player who owns it
const GOT_REMOTE_PROP = "bot:got_remote"; // on the player: remote already handed out once
const HELPER_PROP = "bot:helper"; // on the player: bot finishes trees/veins the player starts
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
}

function forEachBot(player, action, message) {
  const bots = ownedBots(player);
  if (bots.length === 0) {
    player.sendMessage(PREFIX + "หาบอทไม่เจอ ลองเรียกบอทตัวใหม่ได้เลย");
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

function removeBots(player) {
  const bots = ownedBots(player);
  bots.forEach((bot) => {
    cancelTask(bot);
    bot.remove();
  });
  player.sendMessage(PREFIX + (bots.length ? `ส่งบอทกลับบ้านแล้ว ${bots.length} ตัว` : "ไม่มีบอทอยู่ใกล้ ๆ"));
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
    player.sendMessage(PREFIX + (ownedBots(player).length ? "บอททุกตัวกำลังทำงานอยู่ หรืออยู่ไกลเกินไป" : "ต้องเรียกบอทก่อนนะ"));
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
};

const playersInMenu = new Set();

// A form opened right after another one closes can come back as UserBusy and never show,
// so wait a moment and try again
async function showForm(player, form) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await form.show(player);
    if (res.cancelationReason !== FormCancelationReason.UserBusy) return res;
    await system.waitTicks(5);
  }
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
  const res = await showForm(player, form);
  if (!res || res.canceled || res.selection === undefined) return;
  await buttons[res.selection][2](player);
}

async function confirmRemove(player) {
  const form = new ActionFormData()
    .title("ส่งบอทกลับบ้าน")
    .body("บอทของคุณทุกตัวจะหายไป ของที่ฝากไว้จะหล่นที่พื้น\nแน่ใจไหม?")
    .button("ใช่ ส่งกลับบ้าน", "textures/ui/trash")
    .button("ไม่ใช่", "textures/ui/cancel");
  const res = await showForm(player, form);
  if (res && !res.canceled && res.selection === 0) removeBots(player);
}

async function openMenu(player) {
  const count = ownedBots(player).length;
  const full = count >= MAX_BOTS_PER_PLAYER;
  const buttons = [
    [full ? "§7เรียกบอทตัวใหม่ (เต็มแล้ว)" : "เรียกบอทตัวใหม่", "textures/items/egg", ACTIONS.summon],
    ["สั่งงาน (ตัดไม้ / ขุดแร่)", "textures/items/iron_axe", openWorkMenu],
    ["เรียกบอทมาหา", "textures/items/ender_pearl", ACTIONS.here],
    ["ให้เดินตาม", "textures/items/lead", ACTIONS.follow],
    ["ให้รอตรงนี้", "textures/items/bed_red", ACTIONS.sit],
    ["หยุดสิ่งที่ทำอยู่", "textures/ui/cancel", ACTIONS.stop],
    ["ส่งบอทกลับบ้าน", "textures/ui/trash", confirmRemove],
  ];

  const form = new ActionFormData()
    .title("รีโมทเพื่อนบอท")
    .body(
      `บอทของคุณ: §a${count}/${MAX_BOTS_PER_PLAYER}§r ตัว\n\n` +
        "§dคำแนะนำ:§r ต่อยบอท 3 ครั้งติดกันเพื่อสั่งให้หยุด\nถ้าบอทติดหรืออยู่ไกล กด \"เรียกบอทมาหา\""
    );
  for (const [label, icon] of buttons) form.button(label, icon);

  const res = await showForm(player, form);
  if (!res || res.canceled || res.selection === undefined) return;
  await buttons[res.selection][2](player);
}

function registerBotCommand(registry, name, description, action) {
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
});

// One menu at a time per player, so a second use of the remote while a menu chain is open does nothing
world.afterEvents.itemUse.subscribe(async ({ itemStack, source: player }) => {
  if (itemStack?.typeId !== REMOTE_TYPE || playersInMenu.has(player.id)) return;
  playersInMenu.add(player.id);
  try {
    await openMenu(player);
  } finally {
    playersInMenu.delete(player.id);
  }
});

world.afterEvents.playerBreakBlock.subscribe(({ player, block, brokenBlockPermutation }) => {
  if (!player.getDynamicProperty(HELPER_PROP)) return;
  const brokenType = brokenBlockPermutation.type.id;
  if (!isLog(brokenType) && !isOre(brokenType)) return;
  if (anyJobRunning()) return;
  const bot = idleBot(player);
  if (bot) finishWhatPlayerStarted(bot, player, brokenType, block.location, PREFIX);
});

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (initialSpawn && !player.getDynamicProperty(GOT_REMOTE_PROP)) giveRemote(player);
});

// /summon bot:companion skips the per-player limit, so cap the world total here
world.afterEvents.entitySpawn.subscribe(({ entity }) => {
  if (entity.typeId !== BOT_TYPE) return;
  if (loadedBots().length > MAX_BOTS_IN_WORLD) entity.remove();
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
  if (bot.typeId !== BOT_TYPE || player.typeId !== "minecraft:player") return;
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

system.runInterval(() => removeStrayWaypoints(DIMENSIONS.map((id) => world.getDimension(id))), 10 * 20);
