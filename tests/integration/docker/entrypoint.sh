#!/bin/sh
set -e

echo "=== Package Lock Fixer Integration Tests ==="
echo "Node version: $(node --version)"
echo "npm version: $(npm --version)"
echo "============================================="
echo

# Run command passed as arguments
exec "$@"
