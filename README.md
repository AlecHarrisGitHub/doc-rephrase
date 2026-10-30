# Doc Rephrase

Highlight text in any Google Doc, press **Option + Shift + R**, and Claude suggests a better way to say it, using the rest of your document as context. You review and edit the suggestion in Chrome's side panel, then replace the original or copy it. Nothing changes in your doc until you click **Replace original passage**, and **Cmd + Z** undoes it.

Your Anthropic API key stays in **1Password**. It is never pasted into Google, saved in the extension, or written to a file. Nothing is added to your documents, so collaborators see no difference.

## Requirements

- macOS with Google Chrome
- [Homebrew](https://brew.sh) and Apple's command line tools (`xcode-select --install` if you don't have them)
- The 1Password desktop app
- An Anthropic API key (Claude Console at [platform.claude.com](https://platform.claude.com) → **Manage → API keys**)

## Install (about 5 minutes, once per Mac)

1. **Get the code.** In Terminal:
   ```bash
   git clone https://github.com/AlecHarrisGitHub/doc-rephrase.git ~/doc-rephrase && cd ~/doc-rephrase
   ```
   Or use **Code → Download ZIP** on GitHub and unzip it somewhere permanent. Keep this folder: Chrome loads the extension from it.
2. **Store your key in 1Password.** Create an item (type *API Credential*) with a plain name (letters, numbers, spaces), and paste the key into its **credential** field. Its secret reference is `op://<vault>/<item name>/credential`, for example `op://Employee/Anthropic API Key/credential`.
3. **Let the helper ask 1Password for it.** In the 1Password app, open **Settings → Developer** and turn on **Integrate with 1Password CLI**.
4. **Run the installer** from this folder:
   ```bash
   ./install.sh
   ```
   It installs `uv` and the 1Password CLI if needed, checks that 1Password can supply the key, and installs the helper.
5. **Load the Chrome extension.** Go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose this folder's `extension` folder.

That's it. It works in every Google Doc you can edit.

## Use

- Highlight a passage and press **Option + Shift + R**, or click the Doc Rephrase toolbar button. The side panel opens and writes a suggestion. The panel shows your current shortcut; you can change it at `chrome://extensions/shortcuts`.
- Pick a **tone** and an **effort** level. Low is fastest; High and Max think longer and cost more.
- Edit the suggestion if you like, then **Replace original passage**, **Copy text**, or **Try again**.

The helper reads the key from the 1Password app in the background; there are no popups to click. If 1Password ever asks you to approve access for the 1Password CLI, approve it once. The key is then kept in memory until you quit Chrome (at most 12 hours).

## How it works

```
Google Doc ◀── Chrome extension ──▶ local helper ──▶ Claude API
(reads the selection,  (side panel,   (reads the key with
 writes the rewrite)    relays)        `op read`; holds it in memory)
```

- **`extension/`**: reads the highlighted text the same way Docs' Copy does, then puts your previous clipboard text back. It reads the document's current text for context and, when you click Replace, hands the new text to Docs as a paste. It only runs on `docs.google.com`, and only when you press the shortcut or use the panel.
- **`helper/`**: a small macOS app plus a Python program that Chrome starts (native messaging). It reads the key from 1Password, calls Claude (default `claude-opus-5-5`, with prompt caching for the document context), and validates the response.

## Privacy

When you ask for a rewrite, the selected passage and the document's text (up to 200,000 characters around the selection) go from your Mac directly to Anthropic's API, under your own API key and that account's data terms. Images and comments are not sent. Nothing passes through any other server.

The extension asks Chrome for clipboard access only so it can put your clipboard back after reading the selection. Only plain text is restored; if you had copied an image or formatted text, the plain text of your Docs selection replaces it.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Connection: *helper is not installed* | Run `./install.sh` again, then quit and reopen Chrome. |
| Another error mentioning 1Password | Unlock 1Password, check **Settings → Developer → Integrate with 1Password CLI**, and test with `op read "op://…"` in Terminal. The helper writes 1Password's exact error (never the key) to `~/Library/Logs/DocRephrase/helper.log`. |
| *Highlight some text in the document first* | Click into the document, highlight words, then press the shortcut again. |
| *The highlighted text changed* | Highlight the original passage again before clicking Replace, or use **Copy text**. |
| *…includes an image, drawing, equation, or footnote* | Highlight only the words next to it. |
| *Anthropic rejected the API key* / *model not found* | Check the key in your 1Password item, or switch models (see Settings). |
| The shortcut does nothing | Set one at `chrome://extensions/shortcuts`, or click the toolbar button. |

## Settings

Change the model with `helper/install-helper.sh --model claude-sonnet-5-5`, then restart Chrome. The helper's config is at `~/Library/Application Support/DocRephrase/config.json`. It holds only the `op://` reference and the model name.

## Limits

- Selections up to 10,000 characters, including several paragraphs.
- The new text takes the formatting where your selection starts. Mixed formatting and links inside the replaced words aren't kept.
- Google Docs only (not Sheets or Slides), in Chrome on macOS.

## Update

`git pull` (or download the ZIP again into the same folder), then run `./install.sh`. The extension reloads itself the next time you open its panel.

## Develop

```bash
node --test tests/*.test.cjs                       # extension tests (Node 20+)
"$HOME/Library/Application Support/DocRephrase/venv/bin/python" -m unittest tests/test_host.py   # helper tests
```

When you change the extension, bump `version` in `extension/manifest.json` so installed copies reload.

## Uninstall

`./uninstall.sh`, then remove the extension in `chrome://extensions`. Your key stays in 1Password.

## License

MIT. See [LICENSE](LICENSE).
