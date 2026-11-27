# kiki-chrome

Chrome extension that lets [Kiki](https://getkiki.ai) use your Chrome profiles as browsers it can drive.

Install it in every Chrome profile you want Kiki to use. Each copy connects to Kiki on the same Mac under a name you give it (for example `浏览器1`), so a team member can say "open this in `浏览器1`" and the action runs in that profile, with the logins that are already there. The extension is only a browser tool: which profile holds which account, and how to post on each site, is up to the team member using it.

## Install (developer mode, for now)

1. Download `kiki-chrome-<version>.zip` from [Releases](https://github.com/lkyxuan/kiki-chrome/releases/latest) and unzip it somewhere it can stay (Chrome loads it from there).
2. In each Chrome profile: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the unzipped folder.
3. That's it: the extension finds Kiki on its own. In Kiki → Settings → Browsers a row "新浏览器想连上" appears; give it a name and click 同意. Kiki hands this browser its own key, so it reconnects by itself from then on.
   - Kiki on another computer (over Tailscale): click the Kiki icon → 高级, paste the address shown in Kiki's Settings → Browsers ("别的电脑填"), then approve in Kiki.
   - Fallback on the same Mac: paste the pairing code from Kiki → Settings → Browsers into 高级 → 配对码.
4. The extension speaks English by default and Chinese when Chrome's language is Chinese (texts in `_locales/`).
5. The icon shows no badge when connected, `…` while connecting or waiting for approval and `!` when it cannot reach Kiki.

## How it works

- The service worker keeps one WebSocket to Kiki (`ws://127.0.0.1:4567/ext` by default), sends `hello` (its key, or the pairing code, or just a random install id when it is new and waits for approval), and pings every 20 s (Chrome 116+ keeps a worker alive while WebSocket traffic flows). If Kiki is not running it retries with backoff; an alarm every 30 s is the backstop.
- Kiki sends `{type:"call", id, action, params}`; the extension answers `{type:"result", id, ok, result|error}`.
- Actions: `tabs`, `open`, `navigate`, `close`, `snapshot`, `describe`, `find`, `click`, `type`, `key`, `scroll`, `upload`, `screenshot`, `eval`. See `src/protocol.js`.
- **Only tabs it opened.** Every tab Kiki opens goes into an orange **Kiki** tab group. Actions on any other tab are refused, so your own tabs in that profile are never touched.
- Clicks, typing and file uploads go through `chrome.debugger` (real input events, works on sites that ignore synthetic events). While it is attached Chrome shows "Kiki started debugging this browser"; it detaches after 30 s without actions.
- Input behaves like a person, never like a script: the mouse glides along a curved path to a slightly random spot inside the element, presses and releases with a short hold; text is typed key by key with uneven pauses (Chinese and other non-ASCII text is committed a few characters at a time, like an input method; newlines are inserted, never pressed as Enter). Page-side JavaScript sees only trusted events (`isTrusted: true`). Long text speeds up so one `type` finishes inside Kiki's 60 s call timeout.
- `snapshot` lists clickable / typeable elements with a number (`ref`) and the page text; later actions use the `ref`. Besides real buttons and links it lists things styled as buttons (custom elements, `<div>`s with a pointer cursor) and what sits inside open shadow roots. `find` looks an element up by the words on it ("发布") when the list missed it and gives it a `ref`, so a button you can see in a screenshot can still be clicked. When even that can't see it (a closed web component, a canvas), `click` and `describe` also take `x`/`y`: a spot on the latest `screenshot`, which is taken in CSS pixels (its `width`/`height` come back with it) so the picture and the click share one frame. The numbers live in the extension's isolated world, so nothing is written into the page (an upload adds a random attribute only for the instant the debugger needs it).
- `upload` hands the local files to the page through the debugger when the extension's "Allow access to file URLs" switch is on. That switch is off by default (store installs too), so Kiki also sends the files' bytes (`blobs`, base64) and the extension puts them on the file input itself; nobody has to flip the switch.
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

Or open Actions → release → **Run workflow** on `main`: it tags main with the version in `manifest.json`.

The `release` workflow checks the versions match, runs the tests, packs `kiki-chrome-<version>.zip` (`scripts/pack.sh`) and publishes it on Releases. To upgrade, unzip over the old folder and click reload on `chrome://extensions` in each profile.

## License

MIT

## Chrome Web Store

Merging a version bump (manifest.json + package.json) to main runs `release`: it packs the zip, puts it on Releases, and
uploads it to the store item `ljmhepikeflncdaolonniphfcihpcgic` and submits it for review. The listing, screenshots and
privacy answers stay as they are; Google still reviews every version. The store step runs only when these repo secrets are set
(one-time setup by the publisher account):

1. Google Cloud console → enable "Chrome Web Store API" → OAuth consent screen (External; press "Publish app" so it is "In production", otherwise the refresh token dies after 7 days) →
   Credentials → OAuth client ID, type "Web application", with `https://developers.google.com/oauthplayground` as an authorized redirect URI. Save `CWS_CLIENT_ID` and `CWS_CLIENT_SECRET`.
2. Get a refresh token for scope `https://www.googleapis.com/auth/chromewebstore` with that client (signed in as the
   publisher), e.g. with the OAuth Playground (gear → "Use your own OAuth credentials"). Save it as `CWS_REFRESH_TOKEN`.
3. If a store submission failed, or the secrets were added after a version was already on Releases, press "Run workflow" on the `release` action: it skips Releases and submits that version to the store again.
