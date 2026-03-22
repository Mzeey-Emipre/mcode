#!/bin/bash
set -e

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
else
  echo ".env already exists"
fi

echo "Setting git hooks path..."
git config core.hooksPath .githooks
echo "Done."
