#!/usr/bin/env bash
#
# Stage a curated copy of ~/.claude for baking into the image.
#
# The image is distributable. The live ~/.claude is not: it holds OAuth
# credentials and every session transcript this machine has ever produced, in
# plaintext. So this stages an explicit ALLOWLIST and then re-checks the result
# against a denylist before letting the build proceed. Both, deliberately —
# an allowlist alone still ships a secret the day someone adds a new entry to
# it without thinking.
#
#   ./scripts/stage-claude-config.sh              # plugins, skills, agents, commands, settings
#   ./scripts/stage-claude-config.sh --with-md    # also the global CLAUDE.md (see below)
#
# --with-md is off by default on purpose. The global CLAUDE.md names internal
# hosts, IP addresses, the registry and the repo map. That is fine on your
# laptop and wrong in an image pushed to a registry.
#
# Output: docker/claude-config/ (git-ignored). Re-runnable; it rebuilds the
# staging directory from scratch every time, so a file removed from ~/.claude
# disappears from the image on the next build rather than lingering.

set -euo pipefail

SOURCE="${CLAUDE_DIR:-$HOME/.claude}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
STAGE="$REPO_ROOT/docker/claude-config"
WITH_MD="false"

for arg in "$@"; do
  case "$arg" in
    --with-md) WITH_MD="true" ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# What may be baked in. Config only — things that describe how agents behave.
ALLOW=(
  "plugins"        # installed plugins and their marketplace metadata
  "skills"         # standalone skills
  "agents"         # agent definitions
  "workflows"      # workflow definitions — without these the agents ship with
                   # nothing wiring them together, which is how the first build
                   # went out: 7 agents served, 0 workflows
  "commands"       # slash commands
  "output-styles"  # output styles
  "settings.json"  # statusline, enabled plugins, permission policy
)

# What must never be baked in, checked again after staging. Anything matching
# these in the staged tree aborts the build rather than being quietly dropped —
# a surprise here means the allowlist above grew a hole.
DENY_NAMES=(
  ".credentials.json"
  "*.pem" "*.key" "id_rsa*" "*.p12" "*.pfx" ".env" ".env.*"
)
# Only dangerous as ~/.claude/<name>, same reasoning as DENY_DIRS below: a
# third-party plugin ships its own history.jsonl as a test fixture, and denying
# the name anywhere in the tree blocks a staging run over someone else's file.
DENY_NAMES_TOP=(
  ".claude.json" "history.jsonl"
)
DENY_DIRS=(
  "projects" "sessions" "shell-snapshots" "paste-cache" "session-env"
  "backups" "file-history" "todos" "statsig" "downloads" "feedback"
  "daemon" "jobs" "cache" "teams" "github"
)

if [[ ! -d "$SOURCE" ]]; then
  echo "✗ no Claude config at $SOURCE" >&2
  exit 1
fi

echo "Staging from $SOURCE"
rm -rf "$STAGE"
mkdir -p "$STAGE"

for entry in "${ALLOW[@]}"; do
  src="$SOURCE/$entry"
  if [[ ! -e "$src" ]]; then
    echo "  skip  $entry (not present)"
    continue
  fi
  # -L, not a plain -a: a skill or agent under ~/.claude is often a SYMLINK
  # into another tree (~/.agents/skills here). Preserving the link stages a
  # pointer to a path the image does not have, so the container ships ~40
  # dangling symlinks — and the boot seeder then dies on the first one with
  # "EEXIST: mkdir /root/.claude/skills/<name>", abandoning the rest of the
  # seed: no workflow, no watches, and a log line that names a skill rather
  # than the cause.
  /bin/cp -aL "$src" "$STAGE/$entry"
  echo "  add   $entry"
done

if [[ "$WITH_MD" == "true" && -f "$SOURCE/CLAUDE.md" ]]; then
  /bin/cp -a "$SOURCE/CLAUDE.md" "$STAGE/CLAUDE.md"
  echo "  add   CLAUDE.md (--with-md; contains internal host and repo detail)"
fi

# Plugin caches are git clones. The history is dead weight in an image and can
# hold branches nobody meant to ship.
find "$STAGE" -type d -name ".git" -prune -exec rm -rf {} + 2>/dev/null || true

# Installed dependency trees, for the same reason. A skill or plugin that
# vendors node_modules dwarfs everything else here — one on this host carried
# 1.0G of them, staging 1.9G in total against the ~41M this payload is meant to
# be — and none of it is config describing how an agent behaves. A plugin whose
# scripts genuinely need their dependencies must install them in the image, not
# smuggle them in through ~/.claude.
find "$STAGE" -type d -name "node_modules" -prune -exec rm -rf {} + 2>/dev/null || true

# Marketplace CLONES. Every marketplace ever added is a git checkout under
# plugins/marketplaces/, and on the machine that prompted this they were 229M of
# a 283M payload — one of them 99M for a server nothing here uses.
#
# The container does not need them. Installed plugins resolve to
# plugins/cache/<marketplace>/<plugin>/<version> (installPath in
# installed_plugins.json), which is what teamSync seeds from; the Explore page
# lists marketplaces from the known_marketplaces.json FILE, which lives directly
# under plugins/ and survives this, and clones on demand when someone installs.
#
# The seeding line at boot is the check: agents, skills and commands must come
# out the same as before. If a plugin body ever does live under marketplaces/,
# that count drops and says so.
find "$STAGE/plugins" -maxdepth 1 -type d -name "marketplaces" -exec rm -rf {} + 2>/dev/null || true
find "$STAGE" -type f \( -name "*.log" -o -name ".DS_Store" \) -delete 2>/dev/null || true

# ── Fail closed ───────────────────────────────────────────────────────────
violations=()

# Two exemptions, both for files that belong to a vendored dependency rather
# than to this machine: a published package's own dotfiles under node_modules,
# and the *.example/*.sample templates plugins ship to document their settings.
# Neither can carry a credential of ours, and matching them aborts a staging
# run over a file nobody here wrote.
is_vendored() {
  case "$1" in
    */node_modules/*|*.example|*.sample|*.template) return 0 ;;
    *) return 1 ;;
  esac
}

for pattern in "${DENY_NAMES[@]}"; do
  while IFS= read -r hit; do
    [[ -n "$hit" ]] && ! is_vendored "$hit" && violations+=("$hit")
  done < <(find "$STAGE" -name "$pattern" 2>/dev/null || true)
done

for pattern in "${DENY_NAMES_TOP[@]}"; do
  while IFS= read -r hit; do
    [[ -n "$hit" ]] && violations+=("$hit")
  done < <(find "$STAGE" -maxdepth 1 -name "$pattern" 2>/dev/null || true)
done

# Anchored to the top level of the staged tree on purpose. These names are
# only dangerous as ~/.claude/<name>; nested ones are legitimate — plugins/cache
# IS the plugin bodies, which is the whole point of baking anything in.
for dir in "${DENY_DIRS[@]}"; do
  if [[ -d "$STAGE/$dir" ]]; then
    violations+=("$STAGE/$dir")
  fi
done

# A last, content-based sweep for credential-shaped values in the small text
# files. Not a guarantee — it is the backstop for the case the name-based
# rules miss, and it only has to catch the obvious shapes to be worth running.
while IFS= read -r file; do
  if grep -qlE '(sk-ant-[A-Za-z0-9_-]{20,}|"access_token"|"refresh_token"|BEGIN [A-Z ]*PRIVATE KEY)' "$file" 2>/dev/null; then
    violations+=("$file (credential-shaped content)")
  fi
done < <(find "$STAGE" -maxdepth 2 -type f -size -256k \( -name "*.json" -o -name "*.md" -o -name "*.yaml" \) 2>/dev/null || true)

if (( ${#violations[@]} > 0 )); then
  echo >&2
  echo "✗ refusing to stage — these must never go into an image:" >&2
  printf '    %s\n' "${violations[@]}" >&2
  echo >&2
  echo "The allowlist let something through. Fix the allowlist; do not delete" >&2
  echo "these by hand and re-run, or the next person hits the same thing." >&2
  rm -rf "$STAGE"
  exit 1
fi

size="$(du -sh "$STAGE" | cut -f1)"
plugins="$(find "$STAGE/plugins/cache" -maxdepth 2 -mindepth 2 -type d 2>/dev/null | wc -l | tr -d ' ')"
skills="$(find "$STAGE/skills" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
agents="$(find "$STAGE/agents" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"

echo
echo "✓ staged $size at docker/claude-config"
echo "    plugins: $plugins   skills: $skills   agents: $agents"
echo "    excluded: credentials, transcripts, history, caches$([[ "$WITH_MD" == "true" ]] || echo ", global CLAUDE.md")"
