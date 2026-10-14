# Competitive Feature Matrix & Improvement Outline

_Research date: 2026-10-13. Sources: gc.ai (live-fetched), docs.claude.com, promptperfect.jina.ai, plus product knowledge. ✔ = verified from live pages this session; ◐ = from general product knowledge, re-verify before publishing._

---

## 1. Competitive Feature Matrix

Legend: ✅ strong · 🟡 partial/basic · ❌ absent · ❓ unknown

| Capability | **PromptOptimizer (yours)** | **GC AI – Easy Prompt** | **Anthropic Prompt Improver** | **PromptPerfect (Jina)** | **AIPRM / PromptStorm (extensions)** |
|---|---|---|---|---|---|
| **Form factor** | Chrome MV3 extension, in-page + popup + options ✔ | Web app (feature inside) ✔ | Console + API, developer-facing ◐ | Web app + plugin ecosystem ◐ | Chrome extensions ◐ |
| **Where it runs** | 7 AI chat sites in-page; any site via shortcut/popup ✔ | Inside GC AI only ✔ | Anthropic Console / API only ◐ | Their web app + partner plugins ❓ | Mainly ChatGPT (AIPRM); multi-site (PromptStorm) ◐ |
| **Core mechanic** | Framework-based rewrite (5 frameworks) + LLM engines ✔ | One-liner → structured "artisan" prompt via curated meta-prompt ✔ | Rewrites existing prompt; adds CoT, examples, XML structure; edit diff view ◐ | Iterative auto-refinement toward target model ◐ | Curated template library; user picks, fills variables ◐ |
| **Optimization engine** | Offline templates, Chrome Gemini Nano (on-device), BYOK: Gemini/OpenAI/Claude/OpenRouter ✔ | Proprietary hosted meta-prompt ✔ | Hosted (Claude) ◐ | Hosted proprietary ◐ | None (static templates) ◐ |
| **No-API-key path** | ✅ Offline heuristics + on-device Nano ✔ | ❌ (account required) ✔ | ❌ API key needed ◐ | ❌/🟡 freemium ◐ | ✅ templates need no key ◐ |
| **Domain specialization** | ❌ Generic (persona heuristics: code/writing/analysis) ✔ | ✅ Legal-only, deep ✔ | ❌ Generic, Claude-tuned ◐ | ❌ Generic multi-model ◐ | 🟡 SEO/marketing/business templates ◐ |
| **Model-aware output** | 🟡 Frameworks are model-agnostic today | 🟡 Single model target | ✅ Tuned for Claude (XML etc.) ◐ | ✅ Per-target-model optimization ◐ | ❌ ◐ |
| **Transparency (shows the rewrite)** | ✅ result shown before Insert ✔ | ✅ shows improved prompt ✔ | ✅ diff/strikethrough view of edits ◐ | 🟡 shows variants ◐ | ✅ templates are visible ◐ |
| **Prompt library** | ✅ Personal, 500 items, labels/search ✔ | ✅ Skill Library; team-shared on Team plan ✔ | ❌ (workbench sessions) ◐ | 🟡 prompt history ◐ | ✅ Community library 1000s of templates ◐ |
| **Team/sharing** | ❌ local-only storage ✔ | ✅ Team skill library, shared chats ✔ | 🟡 Console sharing ◐ | 🟡 paid tiers ❓ | ✅ Team plans (AIPRM) ◐ |
| **Eval/scoring** | ❌ | ❓ (citation-forcing baked into prompts) | ✅ Console evals workflow ◐ | 🟡 refinement iterations ◐ | ❌ ◐ |
| **Privacy posture** | ✅ On-device default; local storage only; fallback labelled honestly ✔ | ✅ SOC 2 II / SOC 3 / GDPR ✔ | 🟡 data sent to Anthropic ◐ | 🟡 cloud ◐ | 🟡 historically criticized (account wall, data use) ◐ |
| **Education layer** | ❌ docs only | ✅ AI Academy, CLE courses, prompting blog ✔ | ✅ docs ecosystem ◐ | ❌ ❓ | 🟡 blog content ◐ |
| **Price** | Free / BYO key ✔ | Subscription (free trial 14d) ✔ | Pay-per-token API ◐ | Freemium SaaS ◐ | Freemium → paid tiers ◐ |

### Gaps & openings this reveals

1. **Nobody combines in-page, multi-site, no-key, on-device, and model-aware rewriting.** You own cells 1+2+7+11 simultaneously — that is the positioning story.
2. **Your weakest column vs. GC AI/Anthropic is optimization *depth*:** frameworks are user-picked, static, and model-agnostic. Competitors inject techniques automatically and (for Anthropic) show *why* via diffs.
3. **The team/sharing cell is where monetizable value lives** (GC AI's whole pricing ladder is built on it: personal library → team library → analytics).
4. **AIPRM proves distribution > sophistication:** a mediocre optimizer with a huge template library dominated the category. Library UX and community packs are a growth lever, not an afterthought.

---

## 2. Improvement Outline for the Extension

Grounded in the current codebase: `manifest.json` (MV3, content scripts on 7 hosts), `shared/engines.js` (6 engines), `shared/frameworks.js` + `shared/optimizer-engine.js` (framework templates + offline heuristic with persona cues), `shared/library.js` (500-item local library), popup/options/content UIs, unit tests in `unit/`.

### P0 — Optimization depth (close the gap with Easy Prompt / Anthropic Improver)

1. **Technique injection layer.** Beyond structure, frameworks should inject proven techniques as explicit blocks: role/perspective ("act as X reviewing from Y's side"), chain-of-thought scaffolding, output-format contract, and citation/verification instructions ("quote exact sources before concluding"). These are exactly the habits GC AI teaches and bakes in. Implement as composable technique modules that each framework opts into, in `optimizer-engine.js` / framework system prompts.
2. **Model-aware rewriting.** The content script already knows the host — exploit it: emit XML-structured prompts on claude.ai, markdown-structured on ChatGPT/Gemini, citation-style on Perplexity. Add a per-host profile table; no competitor can match this because they're host-locked or host-blind.
3. **Explain-the-rewrite view.** Show a compact "what changed and why" (added persona; scoped task; requested citations) in the result panel — the Anthropic Console diff is the UX benchmark. Doubles as user education (their Academy funnel) at zero cost.

### P1 — Quality loop

4. **Self-scoring with Gemini Nano.** Rate the optimized prompt (specificity, role, format, constraints…) on-device, show a before/after score chip; retry once if below threshold. Private by construction.
5. **Multi-variant generation.** Offer 2–3 ranked variants (structure-emphasized vs. reasoning-emphasized vs. concise) — PromptPerfect's retention trick.
6. **Regression eval harness.** Build a fixed corpus (raw prompt → expected traits) in `unit/`; assert offline heuristics and framework templates keep required sections. You already have the testing discipline for it — extend it from DOM contracts to prompt quality contracts.

### P2 — Library → Skills (GC AI's monetization ladder, adapted)

7. **Library suggestions while typing.** Fuzzy-match the live textarea against saved prompts and ghost-suggest "Use saved: NDA review".
8. **Import/export packs** (JSON) — community packs downloadable from a repo; this is the AIPRM distribution play without the account wall.
9. **Variables in saved prompts** (`{{client}}`, `{{jurisdiction}}`) with a fill-sheet before insert — `library.js` + `save-sheet.js` already have the shape.
10. **(Later, opt-in) sync/share** via chrome.storage.sync or an export server for team packs — never default-on, privacy is your moat.

### P3 — Reach & polish

11. **More hosts**: Microsoft Copilot, Grok, Poe, plus generic contenteditable handling for webmail/docs editors.
12. **Context awareness**: optionally include the last assistant reply ("continue this thread") and page metadata to enrich context automatically.
13. **Onboarding + micro-education**: first-run tour; one-line "why this works" tips under each framework chip.
14. **Ports**: Firefox/Edge (MV3-compatible spots already modular) once the core loop is differentiated.

### Strategic rule

Don't out-GC-AI GC AI on vertical depth — win on the cells they can't touch: **everywhere-in-the-browser, works-without-a-key, privacy-first, and model-aware**. Every P0 item above reinforces exactly that.
