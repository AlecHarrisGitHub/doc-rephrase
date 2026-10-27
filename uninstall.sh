#!/bin/bash
# Removes the Doc Rephrase helper and its Chrome registration. Your API key stays in 1Password.
set -euo pipefail
rm -f "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.rdwrs.doc_rephrase.json"
rm -rf "$HOME/Library/Application Support/DocRephrase"
echo "Removed the Doc Rephrase helper."
echo "To finish: remove the Doc Rephrase extension in chrome://extensions."
