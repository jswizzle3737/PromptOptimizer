# PromptOptimizer (Manifest V3)

PromptOptimizer is a Chrome extension that rewrites rough prompts into structured, high-performance ones for **ChatGPT**, **Claude**, **Google Gemini**, **Perplexity**, **DeepSeek**, **Mistral**, **Grok**, **Microsoft Copilot**, **Poe**, and, on request, any other site.

---

## Key Capabilities

Every page opens with the **yourlegalaid** logo and wordmark, at the same size, above the **PromptOptimizer** name.

1. **In-page Optimize button**
   - On the listed AI sites, focusing the chat box shows an **Optimize** button beside it.
   - **Alt+O** (remappable at `chrome://extensions/shortcuts`) or the right-click item **Optimize with PromptOptimizer** opens the optimizer on any page. These use `activeTab`, so no site permission is needed.
   - On other sites, the toolbar popup has a **Turn on** control that enables the button for that one site, after the browser asks for that site's permission.
   - Runs in a Shadow DOM so page styles cannot distort it. It never attaches to or reads password or other credential fields.
   - **Insert** writes the result back, dispatching the input events React, ProseMirror, Quill, and Lexical expect.
   - On pages extensions cannot script (`chrome://`, the Web Store), the shortcut and menu open the toolbar popup with the text pre-filled.

2. **Target-model tuning and transparent rewrites**
   - The rewrite adapts to the site you are on: XML-style sections for Claude, Markdown-first structure for ChatGPT, Gemini, Mistral and Copilot, cited-and-dated sourcing for Perplexity, goal+verification framing for DeepSeek, facts-versus-speculation for Grok. Poe hosts many models, so it gets no single profile.
   - Applies to the LLM engines' rewrite instructions and to the offline templates, which carry a short *target model note*.
   - Every result shows **technique chips** — what the optimizer added and why (persona, output contract, verification, target tuning) — in the popup and the in-page panel.

3. **Customizable frameworks**
   - Edit names, icons, taglines, system prompts, or offline templates for any framework, or add your own.
   - Edits sync to the in-page panel, popup, and options page without reloading.
   - Factory set: *Smart Expand*, *RTF*, *CREATE*, *Reasoning*, *Concise* (one-click reset).

4. **Engines**
   - **Chrome built-in Prompt API (Gemini Nano)**: the default. On-device and private. Needs Chrome 138+ with the model downloaded. The Prompt API exists only in documents, not in the service worker, so the worker runs Nano in an offscreen document (`offscreen/`).
   - **Offline templates**: instant, no network.
   - **Bring your own key**: Google Gemini, OpenAI, Anthropic Claude, OpenRouter. Default model IDs live in `PROVIDER_DEFAULTS` (`shared/storage.js`).
   - **First run**: when Nano is unavailable and no key is saved, the popup says so and offers an inline key form (with a link to get one; OpenRouter has free models) and a one-click Nano download where Chrome supports it.
   - If the chosen engine fails, any other provider with a saved key is tried next, and the result names the engine that actually answered. Only if none can answer is the offline template used, labelled as an offline fallback with the reason. Neither is presented as the chosen engine's output.

5. **Fifteen interface designs**
   - Pick one in Options, or from the swatch in the popup and the in-page panel: Ink, Terminal, Ember, Harbor, Contrast, Amethyst, Midnight, Aurora (dark) and Paper, Manuscript, Sand, Glacier, Meadow, Rose, Ochre (light).
   - Each is a complete design, with its own palette and, where it matters, its own type face, corner radius and weight. All fifteen meet WCAG AA contrast.

6. **Library of saved prompts**
   - **Save** under any optimized prompt, in the popup or the in-page panel, to keep it with a name and labels.
   - **Fill-in templates**: write `{{audience}}`, `{{due date}}` and the like into a saved prompt. The bookmark button in the popup and the in-page panel lists saved prompts; picking one with blanks asks for them, then puts the filled-in text in the result box, ready to copy or insert.
   - **Options → Library** lists everything saved: search names, text and labels, filter by label, edit, copy, delete, or add a prompt by hand. Up to 500 prompts, stored only in the browser.

7. **Working with a result**
   - **Streaming**: cloud engines and Nano show the rewrite as it is written. **Optimize** turns into **Cancel** while a request runs.
   - **Cut-off detection**: if a model stops at its length limit, the result says so and offers **Continue**, which appends the rest.
   - **Refine**: one-tap *Shorter*, *More formal* and *Add examples* edits of the result (AI engines only; a template is never passed off as a refinement).
   - **Ask me first**: up to three questions about what the draft leaves open; the answers are added to the draft before it is rewritten.
   - **Use page context** (off by default): sends the page title, address without query string, and any other selected text along with the draft.
   - **Secret warning**: a draft that looks like it holds an API key, token, private key or password is held back with a warning before it can reach a cloud provider.

8. **Popup and Options**
   - Popup: framework chips, history, save, per-site switch.
   - Options: engine and key management with live connection tests, frameworks, library, design.

---

## Load in Chrome

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select:
   ```
   C:\Users\jswiz\Desktop\prompt-optimizer-extension
   ```
4. Pin **PromptOptimizer** to the toolbar.

---

## Enable Chrome's built-in model (Gemini Nano)

1. Open `chrome://flags/#prompt-api-for-gemini-nano` and set it to **Enabled**.
2. Open `chrome://flags/#optimization-guide-on-device-model` and set it to **Enabled BypassPerfRequirement**.
3. Relaunch Chrome.
4. Open `chrome://components` and click **Check for update** next to **Optimization Guide On Device Model**.

Until the model is available, Nano requests fall back to the offline templates and say so. The model download needs a user action and cannot be started from the background, so it is done through the steps above. Offline mode and the bring-your-own-key engines work immediately.

---

## Tests

No build step and no `package.json`; everything runs with Node.

```
node --no-warnings --test "unit/*.test.mjs"   # engine, migrations, offline heuristic, service worker, designs, library
node check_contrast.js                        # WCAG AA on every meaningful token pair, every design
node verify_themes.js                         # same, measured on the rendered popup (set SHOTS_DIR to save screenshots)
node check_dom_contract.js                    # every id and class the scripts use exists
node test_extension.js                        # end-to-end in Edge over CDP
node package.mjs                              # store upload: dist/promptoptimizer-<version>.zip
```

`ship-files.json` lists what the extension needs at runtime. `package.mjs` zips exactly that (no research notes, previews or tests) and fails if the manifest points at anything outside it; `test_extension.js` loads the same set.

`test_extension.js` loads a temporary copy of the extension whose only difference from the shipped manifest is one extra content-script match for its local mock chat page.

---

## Project Architecture

```
prompt-optimizer-extension/
├── manifest.json              # Manifest V3 configuration
├── background/
│   ├── service-worker.js      # Context menu, keyboard command, per-site opt-in, messaging, streaming port
│   └── nano-bridge.js         # Runs Gemini Nano through the offscreen document
├── offscreen/                 # Hidden document hosting the Prompt API for the worker
├── content/
│   ├── content.js             # Shadow DOM floating widget & input replacer
│   └── content.css            # Root container CSS
├── popup/                     # Toolbar UI: popup.html / popup.css / popup.js
├── options/                   # Settings and API keys: options.html / options.css / options.js
├── shared/
│   ├── optimizer-engine.js    # Orchestrator: Nano, cloud providers, offline; streaming, fallback, refine, clarify
│   ├── nano.js                # The one Prompt API implementation (popup, offscreen)
│   ├── run-client.js          # Client side of the streaming port (popup, in-page panel)
│   ├── assist.js              # Refine/Continue bar, Ask-me-first sheet, secret notice, library picker
│   ├── clarify.js             # Ask-me-first question parsing and answer folding
│   ├── secrets.js             # Credential detection before a draft leaves the device
│   ├── templates.js           # {{variable}} extraction and filling
│   ├── frameworks.js          # Framework definitions & offline heuristics
│   ├── engines.js             # The engine list: single source for popup, options, content
│   ├── library.js             # Saved prompts: storage, labels, search (no UI)
│   ├── save-sheet.js          # The "Save as / Labels" form shared by popup and in-page panel
│   ├── storage.js             # chrome.storage helpers, schema migrations, provider defaults
│   ├── icons.js               # Stroke icon set (replaces emoji)
│   ├── select.js              # Accessible listbox
│   ├── theme-picker.js        # Theme metadata, migration, dark/light toggle
│   ├── theme.css              # Design tokens — single source of truth
│   ├── base.css               # Reset, typography, focus, reduced motion
│   └── components.css         # Buttons, fields, badges, callouts, chips
├── unit/                      # node:test suites and stubs (no dependencies)
├── assets/
│   └── logo.png               # yourlegalaid logo, transparent background (lockup and in-page panel)
├── icons/                     # 16 / 48 / 128 px PNGs
├── check_contrast.js          # WCAG AA assertion over the theme tokens
├── check_dom_contract.js      # DOM id / class contract checker (+ .selftest.js)
├── generate_icons.py          # Pure Python icon generator
├── test_extension.js          # End-to-end browser verification (CDP)
├── package.mjs                # Builds the store zip from ship-files.json
├── verify_themes.js           # Rendered-theme contrast check (CDP)
├── CHROMEWEBSTORE.md          # Store metadata, permission justifications, privacy text
└── README.md
```
