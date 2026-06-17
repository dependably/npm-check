#!/bin/sh
set -e

echo "=== npm-check Integration Tests ==="
echo "Node version: $(node --version)"
echo "npm version: $(npm --version)"
echo "============================================="
echo

# Run command passed as arguments
exec "$@"
