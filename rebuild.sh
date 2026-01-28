#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "Building shared package..."
cd packages/shared
pnpm build

echo "Building server package..."
cd ../server
pnpm build

echo "Building web package..."
cd ../web
pnpm build

echo "Restarting pm2..."
pm2 restart banshee-forge

echo "Done!"
