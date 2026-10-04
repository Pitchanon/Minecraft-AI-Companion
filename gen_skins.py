"""Generate the bot's skin list from the game's cat skins and every PNG in Companion_RP/textures/entity/bot_skins/.

Writes the client entity and render controller, and the random-skin groups in the behavior entity.
Extra skins use the cat texture layout (64x32).
"""
import json
import pathlib
import re
import struct
import sys

root = pathlib.Path(__file__).parent
RP = root / "Companion_RP"
BP_ENTITY = root / "Companion_BP/entities/companion.json"
SKIN_DIR = RP / "textures/entity/bot_skins"

skins = [
    (name, f"textures/entity/cat/{file}")
    for name, file in [
        ("tabby", "tabby"),
        ("black", "tuxedo"),
        ("red", "redtabby"),
        ("siamese", "siamesecat"),
        ("british", "britishshorthair"),
        ("calico", "calico"),
        ("persian", "persian"),
        ("ragdoll", "ragdoll"),
        ("white", "white"),
        ("jellie", "jellie"),
        ("all_black", "allblackcat"),
    ]
]

errors = []
for png in sorted(SKIN_DIR.glob("*.png")):
    if not re.fullmatch(r"[a-z0-9_]+", png.stem):
        errors.append(f"{png.name}: rename to lowercase letters, digits and _ only")
        continue
    head = png.read_bytes()[:24]
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        errors.append(f"{png.name}: not a PNG file")
        continue
    width, height = struct.unpack(">II", head[16:24])
    if (width, height) != (64, 32):
        errors.append(f"{png.name}: cat skin must be 64x32, got {width}x{height}")
        continue
    skins.append((f"skin_{png.stem}", f"textures/entity/bot_skins/{png.stem}"))

if errors:
    print("\n".join("FAIL " + e for e in errors))
    sys.exit(1)


def write(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


# Client entity: the game's cat model and animations. The vanilla cat gets variable.state from
# the engine, so set it here: walk while moving, sit while standing still.
write(
    RP / "entity/companion.entity.json",
    {
        "format_version": "1.8.0",
        "minecraft:client_entity": {
            "description": {
                "identifier": "bot:companion",
                "materials": {"default": "cat"},
                "textures": {key: path for key, path in skins},
                "geometry": {"default": "geometry.cat"},
                "scripts": {
                    "pre_animation": ["variable.state = query.modified_move_speed > 0.05 ? 3 : 2;"],
                },
                "animations": {
                    "sneak": "animation.cat.sneak",
                    "walk": "animation.cat.walk",
                    "sprint": "animation.cat.sprint",
                    "sit": "animation.cat.sit",
                    "lie_down": "animation.cat.lie_down",
                    "baby_sit": "animation.cat.baby_sit",
                    "baby_lie_down": "animation.cat.baby_lie_down",
                    "look_at_target": "animation.common.look_at_target",
                },
                "animation_controllers": [
                    {"look_at_target": "controller.animation.cat.look_at_target"},
                    {"move": "controller.animation.cat.move"},
                ],
                "render_controllers": ["controller.render.bot_companion"],
            }
        },
    },
)

write(
    RP / "render_controllers/bot_companion.render_controllers.json",
    {
        "format_version": "1.8.0",
        "render_controllers": {
            "controller.render.bot_companion": {
                "arrays": {"textures": {"Array.skins": [f"Texture.{key}" for key, _ in skins]}},
                "geometry": "Geometry.default",
                "materials": [{"*": "Material.default"}],
                "textures": ["Array.skins[query.variant]"],
            }
        },
    },
)

# Behavior entity: one variant group per skin, and pick one at random when the bot spawns
doc = json.loads(BP_ENTITY.read_text(encoding="utf-8"))
entity = doc["minecraft:entity"]
groups = {k: v for k, v in entity["component_groups"].items() if not k.startswith("bot:skin_")}
for i in range(len(skins)):
    groups[f"bot:skin_{i}"] = {"minecraft:variant": {"value": i}}
entity["component_groups"] = groups
entity["events"]["minecraft:entity_spawned"] = {
    "sequence": [
        {"add": {"component_groups": ["bot:wild"]}},
        {"randomize": [{"weight": 1, "add": {"component_groups": [f"bot:skin_{i}"]}} for i in range(len(skins))]},
    ]
}
write(BP_ENTITY, doc)

print(f"skins: {len(skins)} ({', '.join(key for key, _ in skins)})")
