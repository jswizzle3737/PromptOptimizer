# Developer tools

None of this ships to users; Chrome never loads anything in `tools/`.

No `node` on PATH? VS Code bundles one. In PowerShell, run any command below as:

```powershell
$env:ELECTRON_RUN_AS_NODE=1; & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" <script> <args>
```

## Checks

| Command | What it checks |
|---|---|
| `node selftest.mjs` | Engine, storage migrations, email tasks, icons, secret detection |
| `node tools/check-contrast.cjs` | Every theme's text, accent and status colors meet WCAG AA (exits 1 on a failure) |
| `node tools/check-extension-load.cjs [chrome.exe]` | Loads the real extension in headless Chromium and imports every web-accessible module from a content script (exits 1 on a failure). Uses Playwright's Chromium by default; branded Chrome ignores `--load-extension`. |

| `node tools/e2e-email-approval.cjs [chrome.exe]` | End-to-end in headless Chromium: the Email replies page asks before sending, "Don't ask again" skips the next notice, a credential warning always asks, and Cancel sends nothing. Uses a local fake OmniRoute gateway; nothing leaves the machine. |

## Releasing

1. Bump `version` in `manifest.json` and add a `## <version>` section to `CHANGELOG.md`.
2. `node tools/package.cjs` builds `dist/promptoptimizer-<version>.zip` (only the files Chrome loads)
   and fails if anything the manifest or a page references is missing. To prove the zip itself loads,
   extract it and run `node tools/check-extension-load.cjs --from <extracted folder>`.
3. Commit, then tag and push: `git tag v<version>` and `git push origin v<version>`.
   `.github/workflows/release.yml` runs the checks, rebuilds the zip and publishes a GitHub Release
   with that changelog section as notes and the zip attached.
4. Upload the zip in the Chrome Web Store developer dashboard.

### Why `use_dynamic_url` is off

It would stop websites from detecting the extension by probing
`chrome-extension://<id>/shared/…`. In Chromium 149 it also breaks every shared
module that imports a sibling (`select.js`, `assist.js`, `pco-controls.js`,
`save-sheet.js`, `theme-picker.js`) when loaded from a content script, so the in-page
panel and the Gmail tools would fail. `check-extension-load.cjs` reports 13/18 with it
on. The code is otherwise ready: every resource URL comes from `runtime.getURL` per
file, and the worker's sender checks compare origins. To enable it later, bundle the
shared modules (no relative imports) or re-run the check on a newer Chromium, then
add `"use_dynamic_url": true` to the manifest entry and raise
`minimum_chrome_version` to 131.

## Preview the pages without installing

`node tools/dev/serve.cjs` starts a server on `http://127.0.0.1:8765/` and injects
`tools/dev/chrome-mock.js`, a stand-in for the `chrome.*` APIs, into every extension page.

| URL | Page |
|---|---|
| `/popup/popup.html` | Toolbar popup. Set the viewport to 440×600 to match Chrome. |
| `/options/options.html` | Settings console |
| `/options/email-reply.html` | Email replies workspace |
| `/__test/panel.html` | In-page panel on a stand-in chat page. Run `openPanel()` in the console. |
| `/__test/gmail.html` | Stand-in Gmail with the reply tools; replies are scripted per task |

The mock keeps storage in the preview origin's `localStorage` under `__mock_storage`;
delete that key to start fresh. Engines are not called: an optimize run ends with
"Mock: no engine." Seed results through the library or history instead.
