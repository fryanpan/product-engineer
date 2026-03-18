#!/bin/bash
# ══════════════════════════════════════════════════════════════
# Setup Claude Templates for a Single Repo
#
# Copies CLAUDE.md, .claude/settings.json, and .mcp.json to a
# target repo and commits the changes.
# ══════════════════════════════════════════════════════════════

set -e

# ─── Parse arguments ──────────────────────────────────────────

REPO_PATH=""
PRODUCT_NAME=""
PRODUCT_DESCRIPTION=""
DEVELOPMENT_SETUP=""

usage() {
  cat <<EOF
Usage: bash scripts/setup-repo-templates.sh \\
  --repo-path /path/to/repo \\
  --product-name "Product Name" \\
  --product-description "Brief description" \\
  --development-setup "npm install && npm run dev"

Sets up Claude Code templates in a target repository.
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-path)
      REPO_PATH="$2"
      shift 2
      ;;
    --product-name)
      PRODUCT_NAME="$2"
      shift 2
      ;;
    --product-description)
      PRODUCT_DESCRIPTION="$2"
      shift 2
      ;;
    --development-setup)
      DEVELOPMENT_SETUP="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      ;;
  esac
done

if [ -z "$REPO_PATH" ] || [ -z "$PRODUCT_NAME" ]; then
  echo "Error: --repo-path and --product-name are required"
  usage
fi

# ─── Defaults ─────────────────────────────────────────────────

PRODUCT_DESCRIPTION="${PRODUCT_DESCRIPTION:-A product managed by Product Engineer}"
DEVELOPMENT_SETUP="${DEVELOPMENT_SETUP:-See README.md for setup instructions}"

# ─── Preflight ────────────────────────────────────────────────

if [ ! -d "$REPO_PATH" ]; then
  echo "Error: Repo path does not exist: $REPO_PATH"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PE_ROOT="$(dirname "$SCRIPT_DIR")"
TEMPLATES_DIR="$PE_ROOT/templates"

if [ ! -d "$TEMPLATES_DIR" ]; then
  echo "Error: Templates directory not found: $TEMPLATES_DIR"
  exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║         Setup Claude Templates                          ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Repo: $(printf '%-48s' "$REPO_PATH")║"
echo "║  Product: $(printf '%-45s' "$PRODUCT_NAME")║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ─── Copy CLAUDE.md ───────────────────────────────────────────

echo "→ Creating CLAUDE.md..."

if [ -f "$REPO_PATH/CLAUDE.md" ]; then
  echo "  ⚠ CLAUDE.md already exists, creating backup"
  cp "$REPO_PATH/CLAUDE.md" "$REPO_PATH/CLAUDE.md.backup"
fi

# Replace placeholders in template
sed -e "s/{{project_name}}/$PRODUCT_NAME/g" \
    -e "s/{{project_description}}/$PRODUCT_DESCRIPTION/g" \
    -e "s|{{development_setup}}|$DEVELOPMENT_SETUP|g" \
    "$TEMPLATES_DIR/docs/CLAUDE.md.tmpl" > "$REPO_PATH/CLAUDE.md"

echo "  ✅ CLAUDE.md created"

# ─── Copy .claude/settings.json ───────────────────────────────

echo "→ Creating .claude/settings.json..."

mkdir -p "$REPO_PATH/.claude"

if [ -f "$REPO_PATH/.claude/settings.json" ]; then
  echo "  ⚠ .claude/settings.json already exists, creating backup"
  cp "$REPO_PATH/.claude/settings.json" "$REPO_PATH/.claude/settings.json.backup"
fi

cp "$TEMPLATES_DIR/claude-settings.json" "$REPO_PATH/.claude/settings.json"

echo "  ✅ .claude/settings.json created"

# ─── Copy .mcp.json ───────────────────────────────────────────

echo "→ Creating .mcp.json..."

if [ -f "$REPO_PATH/.mcp.json" ]; then
  echo "  ⚠ .mcp.json already exists, creating backup"
  cp "$REPO_PATH/.mcp.json" "$REPO_PATH/.mcp.json.backup"
fi

cp "$TEMPLATES_DIR/.mcp.json" "$REPO_PATH/.mcp.json"

echo "  ✅ .mcp.json created"

# ─── Copy alwaysApply rules ───────────────────────────────────

echo "→ Creating .claude/rules/..."

mkdir -p "$REPO_PATH/.claude/rules"

if [ -d "$TEMPLATES_DIR/rules" ]; then
  for rule_file in "$TEMPLATES_DIR/rules"/*.md; do
    if [ -f "$rule_file" ]; then
      rule_name=$(basename "$rule_file")

      if [ -f "$REPO_PATH/.claude/rules/$rule_name" ]; then
        echo "  ⚠ .claude/rules/$rule_name already exists, skipping"
      else
        cp "$rule_file" "$REPO_PATH/.claude/rules/"
        echo "  ✅ .claude/rules/$rule_name created"
      fi
    fi
  done
fi

# ─── Create docs directories ──────────────────────────────────

echo "→ Creating docs directories..."

mkdir -p "$REPO_PATH/docs/product/plans"
mkdir -p "$REPO_PATH/docs/process"

# Create learnings.md if it doesn't exist
if [ ! -f "$REPO_PATH/docs/process/learnings.md" ]; then
  cat > "$REPO_PATH/docs/process/learnings.md" <<'EOF'
# Learnings

Technical discoveries that should persist across sessions.

<!-- Add learnings here as you discover them -->
EOF
  echo "  ✅ docs/process/learnings.md created"
fi

# Create retrospective.md if it doesn't exist
if [ ! -f "$REPO_PATH/docs/process/retrospective.md" ]; then
  cat > "$REPO_PATH/docs/process/retrospective.md" <<'EOF'
# Retrospective

Session-level retrospectives and feedback.

<!-- Retros will be added here automatically -->
EOF
  echo "  ✅ docs/process/retrospective.md created"
fi

# Create decisions.md if it doesn't exist
if [ ! -f "$REPO_PATH/docs/product/decisions.md" ]; then
  cat > "$REPO_PATH/docs/product/decisions.md" <<'EOF'
# Decisions

Architecture and product decisions log.

## Format

Each entry should include:
- **Date**: When the decision was made
- **Context**: What prompted the decision
- **Decision**: What was decided
- **Rationale**: Why this was chosen
- **Alternatives**: What else was considered
- **Consequences**: Known trade-offs

<!-- Add decisions here -->
EOF
  echo "  ✅ docs/product/decisions.md created"
fi

echo "  ✅ docs directories created"

# ─── Git commit ───────────────────────────────────────────────

echo ""
echo "→ Committing changes..."

cd "$REPO_PATH"

# Check if it's a git repo
if [ ! -d ".git" ]; then
  echo "  ⚠ Not a git repo, skipping commit"
  echo "  You can manually commit with:"
  echo "    cd $REPO_PATH"
  echo "    git add CLAUDE.md .claude/ .mcp.json docs/"
  echo "    git commit -m 'Add Claude Code setup'"
else
  git add CLAUDE.md .claude/ .mcp.json docs/

  if git diff --cached --quiet; then
    echo "  ℹ No changes to commit"
  else
    git commit -m "Add Claude Code setup for Product Engineer

- CLAUDE.md with project instructions
- .claude/settings.json for agent permissions
- .mcp.json for MCP server configuration
- .claude/rules/ for alwaysApply rules
- docs/ structure for decisions, plans, learnings, retros"

    echo "  ✅ Changes committed"
  fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Setup complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Files created:"
echo "    - CLAUDE.md"
echo "    - .claude/settings.json"
echo "    - .mcp.json"
echo "    - .claude/rules/*.md"
echo "    - docs/product/decisions.md"
echo "    - docs/product/plans/"
echo "    - docs/process/learnings.md"
echo "    - docs/process/retrospective.md"
echo ""
echo "  Next steps:"
echo "    1. Review and customize CLAUDE.md"
echo "    2. Push changes: git push"
echo "    3. Test integration with a Linear ticket or Slack mention"
echo ""
