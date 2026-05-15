#!/bin/bash

# =============================================================================
# Pacific Sunday — Deployment Script
# Run this once on any server to set up or update the application.
# Usage: bash deploy.sh
# =============================================================================

set -e  # Exit immediately if any command fails

echo "========================================"
echo "  Pacific Sunday — Deploy Starting"
echo "========================================"

# ── Step 1: Check .env exists ─────────────────────────────────────────────────
if [ ! -f ".env" ]; then
  echo ""
  echo "ERROR: .env file not found."
  echo "Copy .env.example to .env and fill in your values first:"
  echo "  cp .env.example .env"
  echo ""
  exit 1
fi

echo "[1/5] .env file found"

# ── Step 2: Install dependencies ──────────────────────────────────────────────
echo "[2/5] Installing dependencies..."
npm install --omit=dev

# ── Step 3: Generate Prisma client ────────────────────────────────────────────
echo "[3/5] Generating Prisma client..."
npx prisma generate

# ── Step 4: Auto-create migration if schema has uncommitted changes ───────────
# Generates a migration file with a timestamp name — no manual naming needed.
# Safe to run even if no schema changes exist (it will simply skip).
echo "[4/5] Checking for schema changes..."
TIMESTAMP=$(date +%Y%m%d%H%M%S)
npx prisma migrate dev --name "auto_${TIMESTAMP}" --create-only --skip-seed 2>/dev/null || true

# ── Step 5: Apply all pending migrations ──────────────────────────────────────
# On first deploy  → creates all tables from scratch
# On re-deploy     → applies only new pending migrations (safe, no data loss)
echo "[5/5] Applying database migrations..."
npx prisma migrate deploy

echo ""
echo "========================================"
echo "  Deploy complete. Start with: npm start"
echo "========================================"
