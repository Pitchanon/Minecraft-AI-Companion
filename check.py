"""Static checks before packing: JSON parses, UUIDs unique, cross-references resolve."""
import json
import pathlib
import re
import subprocess
import sys

root = pathlib.Path(__file__).parent
errors = []

docs = {}
for path in sorted(root.glob("Companion_*/**/*.json")):
    try:
        docs[path.relative_to(root).as_posix()] = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        errors.append(f"{path}: {e}")

bp = docs["Companion_BP/manifest.json"]
rp = docs["Companion_RP/manifest.json"]
uuids = [bp["header"]["uuid"], rp["header"]["uuid"]] + [m["uuid"] for m in bp["modules"] + rp["modules"]]
if len(set(uuids)) != len(uuids):
    errors.append("manifest UUIDs are not unique")
if not any(d.get("uuid") == rp["header"]["uuid"] for d in bp["dependencies"]):
    errors.append("BP does not depend on RP header uuid")
if not any(d.get("uuid") == bp["header"]["uuid"] for d in rp["dependencies"]):
    errors.append("RP does not depend on BP header uuid")

entry = next(m["entry"] for m in bp["modules"] if m["type"] == "script")
if not (root / "Companion_BP" / entry).is_file():
    errors.append(f"script entry {entry} missing")

entity = docs["Companion_BP/entities/companion.json"]["minecraft:entity"]
groups = set(entity["component_groups"])


def event_groups(node):
    """Yield (op, group) from an event, including nested sequence/randomize steps."""
    if isinstance(node, list):
        for step in node:
            yield from event_groups(step)
    elif isinstance(node, dict):
        for op in ("add", "remove"):
            for g in node.get(op, {}).get("component_groups", []):
                yield op, g
        for key in ("sequence", "randomize"):
            yield from event_groups(node.get(key, []))


for name, event in entity["events"].items():
    for op, g in event_groups(event):
        if g not in groups:
            errors.append(f"event {name} {op}s unknown group {g}")

scripts = sorted((root / "Companion_BP/scripts").glob("*.js"))
script = "\n".join(p.read_text(encoding="utf-8") for p in scripts)
for ev in set(re.findall(r'triggerEvent\("([^"]+)"\)', script)):
    if ev not in entity["events"]:
        errors.append(f"script triggers unknown event {ev}")

client = docs["Companion_RP/entity/companion.entity.json"]["minecraft:client_entity"]["description"]
if client["identifier"] != entity["description"]["identifier"]:
    errors.append("client entity identifier differs from behavior entity")
controllers = {}
for name, doc in docs.items():
    if name.startswith("Companion_RP/render_controllers/"):
        controllers.update(doc["render_controllers"])
bp_ids = {doc["minecraft:entity"]["description"]["identifier"] for name, doc in docs.items() if "minecraft:entity" in doc}
for name, doc in docs.items():
    if "minecraft:client_entity" not in doc:
        continue
    desc = doc["minecraft:client_entity"]["description"]
    if desc["identifier"] not in bp_ids:
        errors.append(f"{name}: no behavior entity {desc['identifier']}")
    for rc in desc["render_controllers"]:
        if rc not in controllers:
            errors.append(f"{name}: render controller {rc} not defined")

rc = controllers["controller.render.bot_companion"]["arrays"]
skin_textures = rc["textures"]["Array.skins"]
skin_variants = [g for g in groups if g.startswith("bot:skin_")]
if len(skin_textures) != len(skin_variants):
    errors.append("skin textures and variant groups have different counts")
for ref in skin_textures:
    key = ref.removeprefix("Texture.")
    if key not in client["textures"]:
        errors.append(f"render controller uses undefined texture {key}")
    elif client["textures"][key].startswith("textures/entity/bot_skins/") and not (
        root / "Companion_RP" / (client["textures"][key] + ".png")
    ).is_file():
        errors.append(f"skin file for {key} missing")

icon = docs["Companion_BP/items/remote.json"]["minecraft:item"]["components"]["minecraft:icon"]
tex = docs["Companion_RP/textures/item_texture.json"]["texture_data"]
if icon not in tex:
    errors.append(f"item icon {icon} not in item_texture.json")
elif not (root / "Companion_RP" / (tex[icon]["textures"] + ".png")).is_file():
    errors.append(f"texture file for {icon} missing")

for path in scripts:
    if subprocess.run(["node", "--check", str(path)]).returncode != 0:
        errors.append(f"{path.name} has syntax errors")

if errors:
    print("\n".join("FAIL " + e for e in errors))
    sys.exit(1)
print(f"check ok ({len(docs)} json files)")
