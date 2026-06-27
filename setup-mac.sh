#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 22+ from https://nodejs.org, then run this script again."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not installed. Install Node.js 22+ from https://nodejs.org, then run this script again."
  exit 1
fi

echo "Installing dependencies..."
npm install

echo "Building Figma plugin..."
npm run build

echo ""
echo "Done."
echo "In Figma: Plugins -> Development -> Import plugin from manifest..."
echo "Select this file: $(pwd)/manifest.json"
