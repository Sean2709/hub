#!/bin/bash
# TS 엔진(src/lib/mansur.ts) ↔ iOS 앱 엔진(Swift) 교차 검증. 앱 소스가 있는 Mac에서만 실행.
set -euo pipefail
cd "$(dirname "$0")"
APP="${MANSUR_MODELS:-$HOME/Documents/Projects/Retire Mansur/RetireMansur/Models}"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
swiftc -O -o "$T/engine" "$APP"/{Constants,Profile,Tax,HousingPension,Calculator,Format,Recommend}.swift main.swift
node parity.ts gen "$T/p.json" "${1:-400}"
"$T/engine" "$T/p.json" > "$T/swift.json"
node parity.ts cmp "$T/p.json" "$T/swift.json"
