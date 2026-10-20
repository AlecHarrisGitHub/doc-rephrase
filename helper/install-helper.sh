#!/bin/bash
# Installs the Doc Rephrase helper and registers it with Google Chrome (macOS).
#
#   helper/install-helper.sh --op-ref "op://<vault>/<item>/credential" [--model claude-opus-5-5]
#
# The helper reads your Anthropic API key from 1Password each time you request a
# rewrite. Only the op:// reference is written to disk, never the key itself.
set -euo pipefail

# Chrome derives the unpacked extension's ID from the public key in its manifest.
EXTENSION_ID="$(/usr/bin/python3 -I -c 'import base64,hashlib,json,sys; k=json.load(open(sys.argv[1]))["key"]; h=hashlib.sha256(base64.b64decode(k)).hexdigest()[:32]; print("".join(chr(97+int(c,16)) for c in h))' "$(dirname "$0")/../extension/manifest.json")"
HOST_NAME="com.rdwrs.doc_rephrase"
SRC="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Library/Application Support/DocRephrase"
CHROME_HOSTS="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

OP_REF=""; MODEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --op-ref) OP_REF="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
if [ -n "$OP_REF" ] && [[ "$OP_REF" != op://* ]]; then
  echo "--op-ref must be a 1Password secret reference starting with op://" >&2; exit 2
fi

UV="$(command -v uv || true)"; [ -z "$UV" ] && [ -x /opt/homebrew/bin/uv ] && UV=/opt/homebrew/bin/uv
if [ -z "$UV" ]; then echo "uv is required: brew install uv" >&2; exit 1; fi
if ! command -v op >/dev/null && [ ! -x /opt/homebrew/bin/op ] && [ ! -x /usr/local/bin/op ]; then
  echo "Warning: 1Password CLI not found. Install it with: brew install --cask 1password-cli" >&2
fi

mkdir -p "$APP" "$CHROME_HOSTS"
if [ ! -x "$APP/venv/bin/python" ]; then "$UV" venv --quiet --python 3.12 "$APP/venv"; fi
"$UV" pip install --quiet --python "$APP/venv/bin/python" "anthropic==1.15.0"
cp "$SRC/doc_rephrase_host.py" "$APP/doc_rephrase_host.py"

# A small app bundle is the process Chrome launches, so macOS names "Doc Rephrase Helper" when it asks
# to let the helper reach 1Password (once per Chrome session; the key is then cached in memory).
BUNDLE="$APP/Doc Rephrase Helper.app"
rm -rf "$BUNDLE" "$APP/doc-rephrase-host"
mkdir -p "$BUNDLE/Contents/MacOS"
APP_C_STRING=$(printf '%s' "$APP" | sed 's/\\/\\\\/g; s/"/\\"/g')
xcrun clang -O2 -Wall -o "$BUNDLE/Contents/MacOS/doc-rephrase-host" -DAPP_DIR="\"$APP_C_STRING\"" "$SRC/launcher.c"
cat > "$BUNDLE/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.rdwrs.docrephrase.helper</string>
  <key>CFBundleName</key><string>Doc Rephrase Helper</string>
  <key>CFBundleExecutable</key><string>doc-rephrase-host</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>2.0.2</string>
  <key>LSUIElement</key><true/>
</dict></plist>
EOF
codesign --force --sign - --identifier com.rdwrs.docrephrase.helper "$BUNDLE"
HOST_EXE="$BUNDLE/Contents/MacOS/doc-rephrase-host"

# Merge settings into config.json (keeps an existing reference unless a new one is given).
"$APP/venv/bin/python" -I - "$APP/config.json" "$OP_REF" "$MODEL" <<'PY'
import json, sys
path, op_ref, model = sys.argv[1:4]
try:
    config = json.load(open(path))
except (FileNotFoundError, ValueError):
    config = {}
if op_ref: config['op_ref'] = op_ref
if model: config['model'] = model
config.setdefault('model', 'claude-opus-5-5')
json.dump(config, open(path, 'w'), indent=2)
print('Helper config:', json.dumps(config))
PY

cat > "$CHROME_HOSTS/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Doc Rephrase helper: calls Claude with a key read from 1Password",
  "path": "$HOST_EXE",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
echo "Registered $HOST_NAME for extension $EXTENSION_ID"
echo "Installed to: $APP"
