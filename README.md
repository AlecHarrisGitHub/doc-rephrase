# Doc Rephrase

Highlight text in a Google Doc, press **Option + Shift + R**, and Claude suggests a better way to say it, using the rest of your document as context. You review and edit the suggestion in a sidebar, then replace the original or copy it. Nothing changes in your doc until you click **Replace original passage**.

Your Anthropic API key stays in **1Password**. It is never pasted into Google, saved in the extension, or written to a file.

## Requirements

- macOS with Google Chrome
- [Homebrew](https://brew.sh)
- The 1Password desktop app, with an [Anthropic API key](https://platform.claude.com/settings/keys) saved in it

## Install (about 5 minutes)

1. **Store your key in 1Password.** Create an item (type *API Credential*) and paste the key into its **credential** field. Its secret reference is `op://<vault>/<item name>/credential`, for example `op://Employee/Anthropic API Key/credential`.
2. **Let the helper ask 1Password for it.** In the 1Password app, open **Settings → Developer** and turn on **Integrate with 1Password CLI**.
3. **Run the installer** from this folder:
   ```bash
   ./install.sh
   ```
   It installs `uv` and the 1Password CLI if needed, checks that 1Password can supply the key, installs the helper, and copies the Google Docs script to your clipboard.
4. **Load the Chrome extension.** Go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose this repo's `extension` folder.
5. **Add it to a Google Doc** (once per document). In the doc choose **Extensions → Apps Script**, replace everything in `Code.gs` with the copied script (also in [`dist/Code.gs`](dist/Code.gs)), click **Save**, and reload the doc. A **Doc Rephrase** menu appears. Authorize the script the first time Google asks.

## Use

- Highlight a passage and press **Option + Shift + R**, or choose **Doc Rephrase → Rephrase selection**. The sidebar shows your current shortcut. Change it at `chrome://extensions/shortcuts`.
- Pick a **tone** and an **effort** level. Low is fastest; High and Max think longer and cost more.
- Edit the suggestion if you like, then **Replace original passage**, **Copy text**, or **Try again**.

The first rewrite after Chrome starts asks you to approve access twice: once in 1Password, and once in a macOS popup ("Doc Rephrase Helper would like to access data from other apps"). Click **Allow**. The key is then kept in memory until you quit Chrome (at most 12 hours).

## How it works

```
Google Doc ──Apps Script──▶ sidebar ──Chrome extension──▶ local helper ──▶ Claude API
 (selection, context,        (review,      (relays requests;    (reads the key with
  applies the edit)           edit)         adds the shortcut)   `op read`; holds it in memory)
```

- **`apps-script/`**: the Google Docs side. It captures the selection, gathers document text (the current tab first, then other tabs while they fit within 200,000 characters), and applies your edit only if the passage hasn't changed since. It never sees the API key and makes no network requests.
- **`extension/`**: the Chrome extension. It forwards requests only from Apps Script sidebars inside Google Docs tabs, and only to the helper.
- **`helper/`**: a small macOS app plus a Python program that Chrome starts (native messaging). It reads the key from 1Password, calls Claude (default `claude-opus-5-5`, with prompt caching for the document context), and validates the response.

## Settings

Change the model with `helper/install-helper.sh --model claude-sonnet-5-5`, then restart Chrome. The helper's config is at `~/Library/Application Support/DocRephrase/config.json`. It holds only the `op://` reference and the model name.

## Limits

- Selections up to 10,000 characters: part of a paragraph, several consecutive paragraphs, list items, or text inside one table cell. Footnote markers, images and chips can sit next to the selection but not inside it.
- Rewritten text takes the formatting of the first selected character in each paragraph. Mixed formatting and links inside the replaced words aren't kept.
- The script must be added to each document. A copy of a prepared doc keeps its script.

## Develop

```bash
python3 build.py                                   # regenerate dist/Code.gs after editing apps-script/
node --test tests/*.test.cjs                       # Apps Script + extension tests (Node 20+)
"$HOME/Library/Application Support/DocRephrase/venv/bin/python" -m unittest tests/test_host.py   # helper tests
```

## Uninstall

`./uninstall.sh`, then remove the extension in `chrome://extensions`. Your key stays in 1Password.

## License

MIT. See [LICENSE](LICENSE).
