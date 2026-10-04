"""Generate the bot's skin list from Steve, Alex and every PNG in Companion_RP/textures/entity/bot_skins/.

Writes the client entity and render controller, and the random-skin groups in the behavior entity.
A file whose name ends in _slim (e.g. kid_slim.png) uses the thin-arm (Alex) model.
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
    ("steve", "textures/entity/steve", False),
    ("alex", "textures/entity/alex", True),
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
    if (width, height) != (64, 64):
        errors.append(f"{png.name}: skin must be 64x64, got {width}x{height}")
        continue
    skins.append((f"skin_{png.stem}", f"textures/entity/bot_skins/{png.stem}", png.stem.endswith("_slim")))

if errors:
    print("\n".join("FAIL " + e for e in errors))
    sys.exit(1)


def write(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


# Client entity: player model with the humanoid animations a skeleton uses (walk, look, attack swing)
write(
    RP / "entity/companion.entity.json",
    {
        "format_version": "1.10.0",
        "minecraft:client_entity": {
            "description": {
                "identifier": "bot:companion",
                "materials": {"default": "entity_alphatest"},
                "textures": {key: path for key, path, _ in skins},
                "geometry": {"default": "geometry.humanoid.custom", "slim": "geometry.humanoid.customSlim"},
                "scripts": {
                    "scale": "0.9375",
                    "pre_animation": [
                        "variable.tcos0 = (Math.cos(query.modified_distance_moved * 38.17) * query.modified_move_speed / variable.gliding_speed_value) * 57.3;"
                    ],
                },
                "animations": {
                    "look_at_target_default": "animation.humanoid.look_at_target.default",
                    "look_at_target_gliding": "animation.humanoid.look_at_target.gliding",
                    "look_at_target_swimming": "animation.humanoid.look_at_target.swimming",
                    "move": "animation.humanoid.move",
                    "attack.rotations": "animation.humanoid.attack.rotations",
                    "bob": "animation.humanoid.bob",
                },
                "animation_controllers": [
                    {"look_at_target": "controller.animation.humanoid.look_at_target"},
                    {"move": "controller.animation.humanoid.move"},
                    {"attack": "controller.animation.humanoid.attack"},
                    {"bob": "controller.animation.humanoid.bob"},
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
                "arrays": {
                    "textures": {"Array.skins": [f"Texture.{key}" for key, _, _ in skins]},
                    "geometries": {
                        "Array.geos": ["Geometry.slim" if slim else "Geometry.default" for _, _, slim in skins]
                    },
                },
                "geometry": "Array.geos[query.variant]",
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

print(f"skins: {len(skins)} ({', '.join(key for key, _, _ in skins)})")
