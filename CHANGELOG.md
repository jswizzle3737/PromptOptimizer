# Changelog

## 1.7.0 — 2026-11-24

### Added
- **Gmail tools.** Turn on the Gmail reply button from the toolbar popup while Gmail is open. Above each reply box, Compose window and popped-out reply:
  - **✦ Draft reply** or **✦ Write email**: writes into the box, treating any text already there as notes or a brief. A new email also gets a subject line.
  - **Polish**: rewrites the text in the box in your saved writing style.
  - **Revise**: Shorter, More formal, Friendlier, or a change you type.
  - **Summarize** (replies only): key points, what's asked of you, and dates. Shown in a panel; nothing is inserted.
  - **Undo** puts back the text that was in the box. The toolbar follows Gmail's light or dark theme.
- **Emoji icons for optimizer types.** One icon picker offers emoji and the stroke icons side by side, plus a box for any emoji.
- **"Don't ask again until Chrome restarts"** on the send approval for Gmail tools and Email replies. It is never offered when a request may contain a credential or when a fallback provider is about to be used.
- **Developer tools** in `tools/`: a preview server for every page, a WCAG contrast check for all themes, a real-Chromium load check, and an end-to-end approval test. See `tools/README.md`.

### Changed
- Your email writing style is stored in extension storage so Gmail can use it. A style saved by an earlier version moves over the next time you open Email replies.
- Popup: **Optimized / Compare** tabs sit above the output, and Compare shows the diff in the output's place. The result was previously shown twice.
- Popup: the optimizer-type chips fill each row evenly, and the Save/Copy bar sits flush at the bottom.
- Anthropic models: Claude Sonnet 5.5 (default), Opus 5.5 and Haiku 5.5. A saved Claude Haiku 4.5, retired on 2026-10-15, moves to the default.
- Email replies: the writing-sample file picker matches the app's buttons.
- The in-page panel's stylesheet, markup and editor helpers moved out of `content/content.js` into `content/panel.css`, `content/panel-template.js` and `content/editor-dom.js`.
- Requires Chrome 116 or later, which on-device (Nano) runs already needed.

### Fixed
- Dropdown lists could not be scrolled. Every wheel tick snapped the list back to the top.
- OpenAI reasoning models (o-series, GPT-5 family), directly or through OpenRouter or OmniRoute, rejected every request because a temperature was set.
- Opening a history item switched the engine picker to whichever provider produced it, so the next Optimize could go to a cloud fallback you had not chosen.
- The Compare tab showed a stale result after Undo, a history restore, an edit, a variant switch or loading a saved prompt.
- A library import that reached the 500-prompt limit reported a failure and did not refresh, although the prompts before the limit were saved.
- Nine color pairs across seven themes fell below WCAG AA: button hover text in Ink, Ember and Harbor, and status text in Paper, Sand, Rose and Meadow.
- The approval notice was unreadable on Gmail's light page.
- Dialogs could squeeze their header and footer, and an open dropdown in the in-page panel did not move when the panel scrolled.

### Security
- Credential detection also catches GitHub fine-grained tokens (`github_pat_…`) and GitLab tokens (`glpat-…`), and names OpenRouter keys correctly.
- The background worker recognises the extension's own pages by origin rather than by comparing URL strings.

## 1.6.0
Baseline before version control. See the first commit.
