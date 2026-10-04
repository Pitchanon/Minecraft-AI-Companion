#!/bin/bash
# Pack Companion_BP + Companion_RP into dist/NatthawatAICompanion.mcaddon
# (double-click on Windows to import into Minecraft Bedrock)
set -euo pipefail
cd "$(dirname "$0")"

python3 gen_skins.py
python3 check.py

rm -rf dist
mkdir -p dist
zip -qr -X dist/NatthawatAICompanion.mcaddon Companion_BP Companion_RP -x '*.DS_Store'
echo "built dist/NatthawatAICompanion.mcaddon"
unzip -l dist/NatthawatAICompanion.mcaddon | tail -1
