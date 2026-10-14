# Chrome Web Store Listing — PromptOptimizer

> Last Updated: 2026-10-02 · Manifest version: 1.1.0
>
> Items marked **TODO (you supply)** need a real value before submission. They are placeholders on purpose; the review team checks them.

## Store Listing

**Extension Name** [REQUIRED]
PromptOptimizer

**Short Description** [REQUIRED]
Elevate rough prompts into structured, high-performance directives directly in ChatGPT, Claude, and Gemini.

**Detailed Description** [REQUIRED]
PromptOptimizer rewrites rough, ambiguous drafts into structured prompts built for clearer, more accurate answers from AI chat assistants.

Features:
- An Optimize button beside the chat box on ChatGPT, Claude, Google Gemini, Perplexity, DeepSeek, and Mistral. On any other site, turn it on for that site only from the toolbar popup.
- Five prompt frameworks: Smart Expand, RTF (Role-Task-Format), CREATE, Reasoning (step-by-step with self-checking), and Concise. Edit them, or add your own.
- Choose where the rewrite happens: Chrome's on-device model (nothing leaves your computer), built-in offline templates (no network at all), or a cloud provider with your own API key: Google Gemini, OpenAI, Anthropic Claude, or OpenRouter.
- One click puts the optimized prompt back into the chat box you started from, or copies it.
- Works on any page without extra permissions: press Alt+O, or right-click selected text or a text field and choose "Optimize with PromptOptimizer". Alt+O can be remapped at chrome://extensions/shortcuts.
- A library of saved prompts: save any result with a name and labels, then search, filter by label, edit, and copy them from the options page.
- Fifteen interface designs to choose from, from a dark terminal look to a cream serif one, all with accessible contrast.
- A toolbar popup with recent history, and an options page for engines, API keys, frameworks, saved prompts, and the design.

How to use:
1. Open ChatGPT, Claude, Gemini, or another AI chat.
2. Type a draft question or rough idea into the chat box.
3. Click the Optimize button that appears beside it, or press Alt+O.
4. Pick a framework and click Optimize.
5. Click Insert to replace your draft with the improved prompt, or Copy.

Privacy & Security:
PromptOptimizer has no servers, analytics, or tracking. Your prompts, history, settings, and any API keys are stored only in your browser. With Chrome's on-device model or Offline templates, nothing is sent anywhere. If you choose a cloud provider, the prompt you ask it to optimize is sent directly to that provider with your own key, under that provider's terms. The extension never reads a field until you click the button, press the shortcut, or use the right-click menu, and it ignores password and other credential fields.

**Category** [REQUIRED]
Productivity

**Single Purpose** [REQUIRED]
Optimizes and structures draft text prompts for conversational AI models directly inside web chat interfaces.

**Primary Language** [REQUIRED]
English

---

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|---|---|---|---|
| Store Icon [REQUIRED] | 128×128 PNG | Ready | `icons/icon-128.png` |
| Small Icon | 16×16 PNG | Ready | `icons/icon-16.png` |
| Medium Icon | 48×48 PNG | Ready | `icons/icon-48.png` |
| Screenshot 1 [REQUIRED] | 1280×800 | **TODO (you supply)** | `assets/screenshot-inpage.png` |
| Screenshot 2 [RECOMMENDED] | 1280×800 | **TODO (you supply)** | `assets/screenshot-popup.png` |
| Screenshot 3 [RECOMMENDED] | 1280×800 | **TODO (you supply)** | `assets/screenshot-options.png` |

`design-preview/` holds earlier design captures, including themes that have since been retired. Do not use them as listing screenshots.

---

## Permissions Justification

| Permission | Type | Justification |
|---|---|---|
| `storage` | permissions | Stores the user's engine choice, frameworks, chosen design, recent optimization history, saved prompts and their labels, and any API keys the user enters, locally in the browser. Also remembers which extra sites the user has turned the button on for. |
| `contextMenus` | permissions | Adds the "Optimize with PromptOptimizer" item to the right-click menu when text is selected or a text field is right-clicked. |
| `activeTab` | permissions | When the user presses the keyboard shortcut or uses the right-click menu on a page that is not one of the listed AI sites, this temporary access lets the optimizer panel open on that one page. It is never used in the background. |
| `scripting` | permissions | Opens the optimizer panel on the current page in the situation above, and on sites the user has turned the button on for. Only the extension's own panel is injected. |
| `offscreen` | permissions | Hosts Chrome's built-in on-device language model (the Prompt API), which Chrome exposes to documents but not to extension service workers. The offscreen document runs only that model; it loads no remote content and has no UI. |
| Content script on `chatgpt.com`, `chat.openai.com`, `claude.ai`, `gemini.google.com`, `www.perplexity.ai`, `chat.deepseek.com`, `chat.mistral.ai` | content_scripts (host access) | Shows the Optimize button beside the chat box and, only when the user asks, reads the draft in that box and writes the optimized prompt back. These are the AI chat sites the extension is built for. The script ignores password and credential fields. |
| `https://*/*`, `http://*/*` | optional_host_permissions | Not requested at install. Requested for one site at a time, only when the user clicks "Turn on" for that site in the popup, so the Optimize button can appear there. The user can turn it off again, which removes the permission. |
| `https://generativelanguage.googleapis.com/*` | host_permissions | Lets the extension call the Google Gemini API directly when the user selects Gemini and supplies their own key. |
| `https://api.openai.com/*` | host_permissions | Lets the extension call the OpenAI API directly when the user selects OpenAI and supplies their own key. |
| `https://api.anthropic.com/*` | host_permissions | Lets the extension call the Anthropic API directly when the user selects Claude and supplies their own key. |
| `https://openrouter.ai/*` | host_permissions | Lets the extension call the OpenRouter API directly when the user selects OpenRouter and supplies their own key, and load OpenRouter's public model list in Options. |
| `web_accessible_resources` (`shared/*.css`, `shared/*.js`) | manifest | The optimizer panel runs inside a page and loads the extension's own stylesheets and scripts from the extension package. No page content is exposed through these files. |
| Keyboard command `open-optimizer` (Alt+O) | commands | Opens the optimizer panel from the keyboard. The user can change or remove the shortcut at chrome://extensions/shortcuts. |

---

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** The developer does not receive any user data.

PromptOptimizer has no developer-operated server. Everything it stores stays in the browser. The text of a prompt leaves the device only when the user selects a cloud provider (Google, OpenAI, Anthropic, or OpenRouter) and runs an optimization; it then goes directly to that provider using the user's own API key.

| Data Type | Handled? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|---|---|---|---|---|
| Personally identifiable info | No | No | N/A | No |
| Health info | No | No | N/A | No |
| Financial info | No | No | N/A | No |
| Authentication info (API keys the user enters) | Stored locally | Only to the provider the key belongs to | Authenticating the user's own requests | Only to that provider |
| Personal communications / website content (the draft the user chooses to optimize) | Read only on a user action (button, shortcut, right-click) | Only if the user selects a cloud engine; then only to that provider | Rewriting the prompt | Only to the provider the user selected |
| Location | No | No | N/A | No |
| Web history | No | No | N/A | No |
| User activity | No | No | N/A | No |

Recent optimizations (original and optimized text) are kept in the browser's local extension storage, up to a limit the user sets, and can be cleared from the popup. Prompts the user chooses to save, with their names and labels, are kept the same way, up to 500, and can be edited or deleted one by one from the options page.

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

---

## Privacy Policy

**Privacy Policy URL**: **TODO (you supply)** — must be a live page that matches this section before submission.

### Summary
PromptOptimizer is local-first. It has no servers, analytics, or trackers. Settings, history, and API keys are stored in the browser's extension storage (`chrome.storage.local`) and are never sent to the developer. Chrome's on-device model and the Offline templates make no network requests. A cloud provider receives a prompt only when the user selects that provider, and receives it directly from the user's browser under the user's own account.

---

## Distribution

**Visibility**: Public
**Regions**: All regions
**Pricing**: Free

---

## Developer Info

**Publisher Name**: **TODO (you supply)**
**Contact Email**: **TODO (you supply)**
**Support URL**: **TODO (you supply)**

---

## Version History

| Version | Date | Changes | Status |
|---|---|---|---|
| 1.2.0 | 2026-10-14 | Cloud engines return their own rewrites again: a half-built "offline-first" mode had replaced every slow answer with the offline template. Rewrites stream as they are written, with Cancel. Cut-off answers are flagged with Continue. One-tap Shorter, More formal and Add examples refinements; Ask me first; optional page context; a warning before a draft holding credentials reaches a cloud provider. Saved prompts can hold {{variables}} and are listed in the popup and the in-page panel. A failed engine falls back to any other provider with a saved key before the offline template. Gemini Nano runs in an offscreen document, since the Prompt API is unavailable to service workers. First-run setup in the popup. The engine menu shows every engine. Grok, Copilot and Poe added. | Draft |
| 1.1.0 | 2026-10-02 | Renamed to PromptOptimizer, with the yourlegalaid logo and wordmark at the top of the popup and options page. The Optimize button now runs only on the listed AI chat sites; any other site is opt-in, one site at a time. Password and credential fields are never read. Alt+O is a remappable browser command and also works on any page; the right-click item now works on an empty text field. The default engine is Chrome's on-device model; the shared developer API key that earlier builds carried has been removed, and stored copies are cleared on update. Chrome's on-device model was rewritten against the current API. Every engine now receives the draft in the same delimited form, so models rewrite it rather than answer it. Requests time out after 45 seconds and fall back visibly. The Offline templates pick personas by whole words. Provider model defaults updated; Gemini keys moved out of the URL. Framework chips wrap instead of hiding options behind an invisible scroll; unified the action verb on "Optimize"; engine failures surface as a visible offline fallback instead of reporting success; ten interface designs to choose from, each with its own palette, type and corners; a library of saved prompts with names and labels; icon set replaces emoji; first-run guidance moved inline to the popup. | Draft |
| 1.0.0 | 2026-09-12 | Initial Manifest V3 build with In-Page Shadow DOM widget, multi-framework optimizer, Chrome Gemini Nano support, BYOK integrations, and offline templates. Never published. | Draft |
