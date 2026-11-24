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
