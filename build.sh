#!/bin/bash
# Pack Companion_BP + Companion_RP into dist/NatthawatAICompanion_<version>.mcaddon
# (double-click on Windows to import into Minecraft Bedrock)
set -euo pipefail
cd "$(dirname "$0")"

python3 gen_skins.py
python3 check.py

version=$(python3 -c 'import json; print("_".join(map(str, json.load(open("Companion_BP/manifest.json"))["header"]["version"])))')
out="dist/NatthawatAICompanion_${version}.mcaddon"

rm -rf dist
mkdir -p dist
zip -qr -X "$out" Companion_BP Companion_RP -x '*.DS_Store'
echo "built $out"
unzip -l "$out" | tail -1
