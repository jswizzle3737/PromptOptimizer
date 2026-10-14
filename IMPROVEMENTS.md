# PromptOptimizer — Self-Improvement Plan

_Grounded in the current codebase (v1.1.0) + GC AI competitive research (`.research/`)._
_Priorities: **P0** = do first (high value, low effort), **P1** = differentiators, **P2** = roadmap._

---

## Where we already beat GC AI's Easy Prompt

| Capability | GC AI Easy Prompt | PromptOptimizer today |
|---|---|---|
| Works across AI platforms | GC AI app only | ✅ ChatGPT, Claude, Gemini, Perplexity, DeepSeek, Mistral + any opt-in site |
| Prompt frameworks | 1 fixed style | ✅ 5 frameworks (Smart Expand, RTF, CREATE, CoT, Concise), user-editable |
| Engine choice | Black box | ✅ Nano (on-device), OpenAI, Anthropic, Gemini, OpenRouter, offline |
| Works offline / private | ❌ | ✅ Offline heuristic + Gemini Nano on-device |
| Prompt library | ✅ Skill Library (personal + team) | ✅ Local library w/ labels & search |
| Saved prompt variables | ❌ | ⚠️ Templates have `{{persona}}` etc. but library entries aren't fillable |
| Shows the rewrite | ✅ | ✅ (modal output) |
| Explains/teaches | ✅ (courses) | ❌ No "what changed / why" feedback |
| Clarifying questions | ❌ one-shot | ❌ one-shot |

**Our gap vs. them is not technology — it's the trust/teaching loop and iteration.** Their wedge: show the rewrite, explain the technique, save what works, share with team. We have save + cross-site; we're missing explain + iterate.

---

## P0 — Trust, reliability, speed (fix the foundations)

1. **Streaming responses.** `shared/optimizer-engine.js` waits for the full body (worst case 45s spinner). All four providers support SSE. Stream tokens into the modal output → perceived latency drops ~5–10×. Add `AbortController` + a Cancel button while you're in there.
2. **Truncation guard.** `MAX_OUTPUT_TOKENS = 2048` with no `finish_reason` check. If the provider returns `length`/`max_tokens`, warn "output was cut off" and offer one-tap "Continue." Right now a cut-off rewrite is silently half a prompt (`cleanModelOutput` just returns it).
3. **Retry + per-provider error mapping.** 429/5xx should retry once with backoff; map error bodies to actionable messages ("Invalid Anthropic key — fix in Options", "Model `X` not found on OpenRouter") instead of generic console-warn → silent degraded offline result. `degradedReason` exists but surfaces should show *what to do about it*.
4. **"What changed" panel (the GC AI lesson, done better).** After each optimization, show 3–5 bullets: "Added persona: Principal Engineer · Added output format · Added edge-case handling." Cheap to generate (the frameworks are structured — the engine already knows which slots it filled) and it's their #1 trust mechanism. Optionally word-level diff view original → optimized.
5. **Iterative refinement chips** on the result: *Shorter · More formal · Add examples · Ask me questions first*. One extra `optimizePrompt` call with a follow-up system instruction. Turns one-shot into a loop without a chat UI.

## P1 — Differentiators (things GC AI *can't* do)

6. **Target-model–aware rewriting.** We know which site the user is on (`content.js` already routes per-host). Add per-target suffixes to framework system prompts: Claude → XML tags + explicit thinking steps; GPT → markdown structure; Gemini → Google-style instructions; Nano → compact prompt (see #8). "Optimized for Claude" is a headline feature nobody else has.
7. **Fill-in-the-blank library.** Library entries already store `framework`; templates use `{{prompt|persona|audience|deliverable}}`. Let users save prompts with `{{variables}}` and get a small fill form on insert (save-sheet.js is the natural home). This turns the library from "saved outputs" into *reusable prompt templates* = GC AI's skill library, locally.
8. **Clarify-first mode.** Framework setting or Alt+Shift+O: instead of rewriting immediately, the model returns ≤3 questions ("Who is the audience? What's the deliverable?"), then rewrites with the answers. Directly addresses the "garbage in" failure mode of every one-shot optimizer (GC AI included).
9. **Prompt-quality score (local, instant, free).** Offline heuristic in `frameworks.js` already detects persona cues. Extend it: score 0–100 on length/specificity/format/constraints/examples, show a tiny meter on the trigger pill *as the user types*. Education-as-feature, zero API cost, works on every site. Also drives "you improved +32 points" delight.
10. **Page/selection context toggle.** Context menu already handles selected text; add an "include page context" checkbox that grabs selection or `<title>`+URL and injects it into the system prompt's context slot. Massive real-world quality boost.

## P2 — Engineering hardening & growth

11. **Test the engine seams.** `optimizePrompt`'s providers should take an injectable `fetch` for Node-based tests; `unit/` already has `engine.test.mjs` — extend with mock provider endpoints (429 retry, truncation, malformed JSON in `sendProviderRequest`). Add a Puppeteer E2E that loads the unpacked extension and clicks through modal → optimize on a stub page.
12. **Fallback chain setting.** Today: chosen engine → offline template (silent-ish). Let users order fallbacks (`anthropic → openai → nano → offline`) in Options; the `degraded` plumbing already exists.
13. **Nano context guard.** Gemini Nano has a small input budget; large framework system prompts (~500+ words in `DEFAULT_FRAMEWORKS`) + long drafts will overflow. Add a compact system-prompt variant per framework for `engine === 'nano'`.
14. **History → library → export.** `addHistoryEntry` exists in service worker; surface History in Options with pruning cap (check `chrome.storage.local` quota, `LIMITS` in library.js), plus import/export JSON for backup + portability.
15. **New hosts + generic textbox detection.** grok.com, copilot.microsoft.com, poe.com are quick manifest additions. Longer-term: detect any focused `textarea`/contenteditable and offer the pill on opt-in sites, not just known AI chats.
16. **Secret-warning nudge.** Before sending, regex-scan drafts for likely API keys/tokens (`sk-…`, `AKIA…`, JWT shape) and warn once. Fits the privacy positioning; costs ~20 lines in the content script.
17. **i18n scaffolding + store listing polish.** `CHROMEWEBSTORE.md` exists; add `_locales` skeleton and screenshot refresh (design-preview/ assets) before launch push.
18. **Analytics-light:** local-only counters (optimizations per engine/framework, library reuse count) powering an Options "dashboard" — GC AI's Team analytics, but private-by-default. No telemetry without explicit opt-in.

---

## Suggested execution order

| Phase | Items | Why |
|---|---|---|
| Sprint 1 | 1, 2, 3 | Streaming + no-silent-truncation + retry = the product feels 10× better |
| Sprint 2 | 4, 5 | Trust loop + iteration — the GC AI lesson, generalized |
| Sprint 3 | 6, 9, 10 | Target-aware + score + context = the differentiation story for the store listing |
| Sprint 4 | 7, 8, 11 | Library-as-templates, clarify-first, test hardening before scaling hosts (15–18) |
