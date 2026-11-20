#!/bin/zsh
set -e
cd "$(dirname "$0")"
if ! command -v npm >/dev/null 2>&1; then
  print 'Install Node.js 24, then open this file again.'
  read -r '?Press Return to close.'
  exit 1
fi
if [[ ! -d node_modules ]]; then
  npm ci
fi
npm run build
print '\nOpen the Orluma URL printed below. Keep this window open while using the app.\n'
npm start
