import { world, system, ItemStack, CommandPermissionLevel, CustomCommandStatus } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

const BOT_TYPE = "bot:companion";
const REMOTE_TYPE = "bot:remote";
const OWNER_PROP = "bot:owner"; // on the bot: id of the player who owns it
const GOT_REMOTE_PROP = "bot:got_remote"; // on the player: remote already handed out once
const DIMENSIONS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];
const PREFIX = "§b[บอท]§r ";

const MAX_BOTS_PER_PLAYER = 3;
const MAX_BOTS_IN_WORLD = 10;

const LOW_HEALTH = 8; // 4 hearts
const HEAL_RANGE = 16;
const HEAL_COOLDOWN_TICKS = 30 * 20;
const lastHealTick = new Map();

// Punching your own bot STOP_HITS times within STOP_WINDOW_TICKS means "stop what you're doing"
const STOP_HITS = 3;
const STOP_WINDOW_TICKS = 3 * 20;
const CALM_TICKS = 10 * 20;
const recentHits = new Map(); // bot id -> ticks of recent hits
const calmTimers = new Map(); // bot id -> run id of the pending resume_combat
// Long-running jobs (e.g. mining) put a cancel function here so a stop can end them
const activeTasks = new Map();

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
      bot.teleport(player.location, { dimension: player.dimension });
      bot.triggerEvent("bot:follow");
    },
    "มาแล้วครับ!"
  );
}

function stopBot(bot) {
  activeTasks.get(bot.id)?.();
  activeTasks.delete(bot.id);
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
  bots.forEach((bot) => bot.remove());
  player.sendMessage(PREFIX + (bots.length ? `ส่งบอทกลับบ้านแล้ว ${bots.length} ตัว` : "ไม่มีบอทอยู่ใกล้ ๆ"));
}

function giveRemote(player) {
  player.getComponent("minecraft:inventory")?.container?.addItem(new ItemStack(REMOTE_TYPE, 1));
  player.setDynamicProperty(GOT_REMOTE_PROP, true);
}

const ACTIONS = {
  summon: summonBot,
  here: bringBots,
  follow: (p) => forEachBot(p, (bot) => bot.triggerEvent("bot:follow"), "ตามไปด้วยครับ!"),
  sit: (p) => forEachBot(p, (bot) => bot.triggerEvent("bot:sit"), "รอตรงนี้นะครับ"),
  stop: (p) => forEachBot(p, stopBot, "โอเค หยุดแล้วครับ"),
  remove: removeBots,
  remote: giveRemote,
};

async function confirmRemove(player) {
  const form = new ActionFormData()
    .title("ส่งบอทกลับบ้าน")
    .body("บอทของคุณทุกตัวจะหายไป ของที่ฝากไว้จะหล่นที่พื้น\nแน่ใจไหม?")
    .button("ใช่ ส่งกลับบ้าน", "textures/ui/trash")
    .button("ไม่ใช่", "textures/ui/cancel");
  const res = await form.show(player);
  if (!res.canceled && res.selection === 0) removeBots(player);
}

async function openMenu(player) {
  const count = ownedBots(player).length;
  const full = count >= MAX_BOTS_PER_PLAYER;
  const buttons = [
    [full ? "§7เรียกบอทตัวใหม่ (เต็มแล้ว)" : "เรียกบอทตัวใหม่", "textures/items/egg", ACTIONS.summon],
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

  const res = await form.show(player);
  if (res.canceled || res.selection === undefined) return;
  buttons[res.selection][2](player);
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
});

world.afterEvents.itemUse.subscribe(({ itemStack, source: player }) => {
  if (itemStack?.typeId === REMOTE_TYPE) openMenu(player);
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

    player.addEffect("regeneration", 5 * 20, { amplifier: 1 });
    player.sendMessage(PREFIX + "ระวังนะ! ฟื้นเลือดให้แล้ว");
    lastHealTick.set(player.id, system.currentTick);
  }
}, 20);
