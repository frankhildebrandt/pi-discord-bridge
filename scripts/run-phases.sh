#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PHASE_DIR="$ROOT_DIR/phases"
SESSION_ID="${PI_PHASE_SESSION_ID:-pi-discord-bridge-implementation}"
START_PHASE="${START_PHASE:-}"
END_PHASE="${END_PHASE:-}"
DRY_RUN="${DRY_RUN:-0}"
PI_BIN="${PI_BIN:-pi}"
PI_VERBOSE="${PI_VERBOSE:-1}"

# Optional lokale Modell-/Provider-Flags, z.B.:
#   PI_MODEL_ARGS='--model anthropic/claude-sonnet-4-5 --thinking high'
# Modellsteuerung erfolgt hier lokal im Shell-Aufruf, niemals über Discord.
read -r -a MODEL_ARGS <<< "${PI_MODEL_ARGS:-}"

usage() {
  cat <<'EOF'
Usage:
  scripts/run-phases.sh [phase-file ...]

Environment:
  PI_BIN                 pi binary, default: pi
  PI_PHASE_SESSION_ID    stable pi session id, default: pi-discord-bridge-implementation
  PI_MODEL_ARGS          optional local pi model args, e.g. '--model anthropic/claude-sonnet-4-5'
  START_PHASE            first phase number to run, e.g. 3
  END_PHASE              last phase number to run, e.g. 4
  DRY_RUN=1              print commands without executing
  PI_VERBOSE=0           disable pi --verbose (enabled by default)

Examples:
  scripts/run-phases.sh
  START_PHASE=3 scripts/run-phases.sh
  START_PHASE=3 END_PHASE=4 scripts/run-phases.sh
  scripts/run-phases.sh phases/phase-04-knowledgebase-forum.md
  PI_MODEL_ARGS='--model anthropic/claude-sonnet-4-5 --thinking high' scripts/run-phases.sh
  PI_VERBOSE=0 scripts/run-phases.sh
EOF
}

phase_number() {
  local file="$1"
  basename "$file" | sed -E 's/^phase-([0-9]+).*$/\1/'
}

should_run() {
  local file="$1"
  local number
  number="$(phase_number "$file")"

  if [[ ! "$number" =~ ^[0-9]+$ ]]; then
    return 0
  fi

  if [[ -n "$START_PHASE" ]] && ((10#$number < 10#$START_PHASE)); then
    return 1
  fi

  if [[ -n "$END_PHASE" ]] && ((10#$number > 10#$END_PHASE)); then
    return 1
  fi

  return 0
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -gt 0 ]]; then
  mapfile -t PHASE_FILES < <(printf '%s\n' "$@")
else
  mapfile -t PHASE_FILES < <(find "$PHASE_DIR" -maxdepth 1 -type f -name 'phase-*.md' | sort)
fi

if [[ ${#PHASE_FILES[@]} -eq 0 ]]; then
  echo "No phase files found." >&2
  exit 1
fi

cd "$ROOT_DIR"

for phase_file in "${PHASE_FILES[@]}"; do
  if [[ ! -f "$phase_file" ]]; then
    echo "Missing phase file: $phase_file" >&2
    exit 1
  fi

  if ! should_run "$phase_file"; then
    continue
  fi

  echo "==> Running pi for $(basename "$phase_file")"

  prompt=$(
    cat <<EOF
Bitte bearbeite die folgende Implementierungsphase für das Repository.

Regeln:
- Lies die genannte Phasendatei und relevante Projektdateien.
- Implementiere nur den Umfang dieser Phase.
- Halte bestehende Vorgaben aus DESIGN.md ein.
- Über Discord darf niemals Modell, Provider oder Thinking-Level geändert werden.
- Führe nach Änderungen npm run typecheck aus und behebe Fehler.

Phasendatei: @$phase_file
EOF
  )

  if [[ "$PI_VERBOSE" == "0" ]]; then
    cmd=("$PI_BIN" -p --session-id "$SESSION_ID" "${MODEL_ARGS[@]}" "$prompt")
  else
    cmd=("$PI_BIN" --verbose -p --session-id "$SESSION_ID" "${MODEL_ARGS[@]}" "$prompt")
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    printf 'DRY RUN:'
    printf ' %q' "${cmd[@]}"
    printf '\n'
  else
    "${cmd[@]}"
  fi

done
