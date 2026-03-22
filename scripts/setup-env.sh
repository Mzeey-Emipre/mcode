#!/bin/bash
set -e
cd "$(git rev-parse --show-toplevel)"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
else
  echo ".env already exists"
fi

echo "Setting git hooks path..."
git config core.hooksPath .githooks
echo "Done."
