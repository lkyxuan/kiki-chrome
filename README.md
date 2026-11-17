# kiki-chrome

Chrome extension that lets [Kiki](https://getkiki.ai) use your Chrome profiles as browsers it can drive.

Install it in every Chrome profile you want Kiki to use. Each copy connects to Kiki on the same Mac under a name you give it (for example `浏览器1`), so a team member can say "open this in `浏览器1`" and the action runs in that profile, with the logins that are already there. The extension is only a browser tool: which profile holds which account, and how to post on each site, is up to the team member using it.

## Install (developer mode, for now)

1. Download `kiki-chrome-<version>.zip` from [Releases](https://github.com/lkyxuan/kiki-chrome/releases/latest) and unzip it somewhere it can stay (Chrome loads it from there).
2. In each Chrome profile: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the unzipped folder.
3. Click the Kiki icon in the toolbar, fill in:
   - **Name**: what Kiki calls this browser, e.g. `浏览器1`. Different in every profile.
   - **Pairing code**: copy it from Kiki → Settings → Browsers.
4. The icon shows no badge when connected, `…` while connecting and `!` when it cannot reach Kiki.

## How it works

- The service worker keeps one WebSocket to Kiki (`ws://127.0.0.1:4567/ext` by default), sends `hello` with the browser name and pairing code, and pings every 20 s (Chrome 116+ keeps a worker alive while WebSocket traffic flows). If Kiki is not running it retries with backoff; an alarm every 30 s is the backstop.
- Kiki sends `{type:"call", id, action, params}`; the extension answers `{type:"result", id, ok, result|error}`.
- Actions: `tabs`, `open`, `navigate`, `close`, `snapshot`, `describe`, `click`, `type`, `key`, `scroll`, `upload`, `screenshot`, `eval`. See `src/protocol.js`.
- **Only tabs it opened.** Every tab Kiki opens goes into an orange **Kiki** tab group. Actions on any other tab are refused, so your own tabs in that profile are never touched.
- Clicks, typing and file uploads go through `chrome.debugger` (real input events, works on sites that ignore synthetic events). While it is attached Chrome shows "Kiki started debugging this browser"; it detaches after 30 s without actions.
- Input behaves like a person, never like a script: the mouse glides along a curved path to a slightly random spot inside the element, presses and releases with a short hold; text is typed key by key with uneven pauses (Chinese and other non-ASCII text is committed a few characters at a time, like an input method; newlines are inserted, never pressed as Enter). Page-side JavaScript sees only trusted events (`isTrusted: true`). Long text speeds up so one `type` finishes inside Kiki's 60 s call timeout.
- `snapshot` lists clickable / typeable elements with a number (`ref`) and the page text; later actions use the `ref`. The numbers live in the extension's isolated world, so nothing is written into the page (an upload adds a random attribute only for the instant the debugger needs it).
- Kiki, not the extension, decides whether a click or an Enter needs your approval (posting, sending, replying). It calls `describe` first to see what the button says.

## Develop

```sh
npm test        # unit tests (protocol, keys, injected functions)
npm i && npx playwright install chromium   # once
npm run smoke   # loads the extension into Playwright Chromium and runs every action against a test page
```

## Release

Bump `version` in both `manifest.json` and `package.json`, merge, then push a tag with the same version:

```sh
git tag v0.1.3 && git push origin v0.1.3
```

The `release` workflow checks the versions match, runs the tests, packs `kiki-chrome-<version>.zip` (`scripts/pack.sh`) and publishes it on Releases. To upgrade, unzip over the old folder and click reload on `chrome://extensions` in each profile.

## License

MIT
