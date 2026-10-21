#!/bin/bash
# Doc Rephrase installer for macOS + Google Chrome.
#
#   ./install.sh                       # asks for your 1Password reference
#   ./install.sh --op-ref "op://Vault/Item/credential" [--model claude-opus-5-5]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
OP_REF=""; MODEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --op-ref) OP_REF="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[ "$(uname)" = Darwin ] || { echo "Doc Rephrase's helper currently supports macOS only." >&2; exit 1; }
[ -d "/Applications/Google Chrome.app" ] || echo "Warning: Google Chrome not found in /Applications." >&2

bold "1/4  Tools"
BREW="$(command -v brew || true)"; [ -z "$BREW" ] && [ -x /opt/homebrew/bin/brew ] && BREW=/opt/homebrew/bin/brew
need() { command -v "$1" >/dev/null || [ -x "/opt/homebrew/bin/$1" ] || [ -x "/usr/local/bin/$1" ]; }
if ! need uv || ! need op; then
  [ -n "$BREW" ] || { echo "Install Homebrew first (https://brew.sh), then run this again." >&2; exit 1; }
  need uv || "$BREW" install uv
  need op || "$BREW" install --cask 1password-cli
fi
xcrun --find clang >/dev/null 2>&1 || { echo "Install Apple's command line tools first: xcode-select --install" >&2; exit 1; }
echo "uv, 1Password CLI and clang are available."

bold "2/4  Your Anthropic API key in 1Password"
if [ -z "$OP_REF" ]; then
  echo "Save your Anthropic API key in 1Password, then enter its secret reference."
  echo "Format: op://<vault>/<item name>/credential   (for example op://Employee/Anthropic API Key/credential)"
  read -r -p "Reference: " OP_REF
fi
[[ "$OP_REF" == op://* ]] || { echo "The reference must start with op://" >&2; exit 2; }
OP="$(command -v op || echo /opt/homebrew/bin/op)"
echo "Checking that 1Password can provide it (approve the 1Password prompt if one appears)..."
ERR="$(mktemp)"
if ! "$OP" read --no-newline "$OP_REF" >/dev/null 2>"$ERR"; then
  echo "1Password could not read that reference:" >&2; tail -1 "$ERR" >&2; rm -f "$ERR"
  echo "Unlock 1Password and turn on Settings > Developer > \"Integrate with 1Password CLI\", then run this again." >&2
  exit 1
fi
rm -f "$ERR"
echo "OK: the key is readable. It stays in 1Password; only the reference is saved."

bold "3/4  Helper"
ARGS=(--op-ref "$OP_REF"); [ -n "$MODEL" ] && ARGS+=(--model "$MODEL")
"$ROOT/helper/install-helper.sh" "${ARGS[@]}"

bold "4/4  Two steps in Chrome and Google Docs"
LANG=en_US.UTF-8 pbcopy < "$ROOT/dist/Code.gs"
cat <<EOF
A) Load the extension (once):
   chrome://extensions  ->  turn on Developer mode  ->  Load unpacked  ->  choose:
   $ROOT/extension

B) Add Doc Rephrase to a Google Doc (once per document):
   In the doc: Extensions -> Apps Script -> replace the contents of Code.gs with the script
   (it is on your clipboard now; it is also in dist/Code.gs) -> Save -> reload the doc.
   Then choose Doc Rephrase -> Open sidebar / settings. Google warns "Google hasn't verified this app"
   because it is your own copy: click Advanced -> Go to Doc Rephrase (unsafe) -> Allow.

Then highlight text and press Option+Shift+R, or use Doc Rephrase -> Rephrase selection.
The first rewrite each Chrome session asks once for 1Password / macOS approval.
EOF
open -R "$ROOT/extension/manifest.json" 2>/dev/null || true
