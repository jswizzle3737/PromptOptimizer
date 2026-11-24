# PromptOptimizer — merge plan for the 8-phase proposal

Scope: merge the pasted implementation plan into the existing extension **without breaking
provider connections, saved frameworks, preferences, or browser integrations**.

> **Implementation note:** the active working copy is
> `C:\Users\jswiz\Desktop\Apps\PromptOptimizer-v2`, branch `merge/optimizer-v2`. Slices 0, 1
> and 2 are implemented there (composable engine, explicit target, unknown-by-default
> capability registry); Slice 3 adds weighted evaluation with hard-failure checks. This folder is the older unpacked 1.4.0 build and was not edited;
> it lacks the repo's `unit/` suite and CI. The authoritative, updated plan is
> `MERGE-PLAN.md` in the working copy.

This document is a plan only. No source files in this folder were modified by writing it.

---

## 1. Where the app actually stands (verified against this folder)

| Fact | Evidence |
| --- | --- |
| MV3 extension, name `PromptOptimizer`, version `1.4.0` | `manifest.json:3-5` |
| 7 optimization engines: nano, offline, omniroute, openrouter, gemini, openai, anthropic | `shared/engines.js:9-45` |
| 12 supported AI sites; target tuning is derived from the **host page** | `manifest.json:24-48`, `shared/target-profiles.js:19-105` |
| 3 user surfaces: popup, in-page Shadow DOM modal, options page; service worker orchestrates by message | `popup/popup.js`, `content/content.js:336-367`, `options/options.js`, `background/service-worker.js:255-288` |
| `shared/engines.js` exists specifically to stop three UI copies drifting apart | `shared/engines.js:1-7` |
| 5 editable built-in frameworks, persisted under `promptcraft_frameworks` | `shared/frameworks.js:12-140`, `options/options.js:22,782-800` |
| Settings schema v6; `migrateSettings()` is additive and never throws | `shared/storage.js:20,126-161,177-237` |
| Structural score is already labelled "Framework coverage" in the UI | `popup/popup.js:534`, `content/content.js:1226` |
| Secret scan runs on system prompt + user message before approval | `background/service-worker.js:270` |
| Page context is opt-in and capped at 4,000 chars | `shared/storage.js:154`, `shared/optimizer-engine.js:105-113` |
| **This folder has no `.git`, no `unit/`, no `test_extension.js`, no `package.json`** | directory listing |
| Public GitHub repo exists at v1.4.0 with CI for unit tests | `https://github.com/jswizzle3737/PromptOptimizer`, releases/tag/v1.4.0, PR #1 |

### The three weaknesses named in the proposal are real

1. `buildSystemPrompt()` (`shared/optimizer-engine.js:82-97`) always appends
   `QUALITY_TECHNIQUES`, which mandates an expert persona and ordered decomposition.
2. `SCORING_TRAITS` (`shared/scorer.js:35-64`) rewards `role` (20), `steps` (15), `format` (20),
   i.e. structure, not task performance.
3. `getTargetProfile(hostOrUrl)` (`shared/target-profiles.js:111-122`) resolves a **hostname**,
   not the capabilities of the model that will execute the prompt.

These must be fixed before new modes are added, or every new mode inherits the same bias.

---

## 2. Merge verdict

**Merge selectively, in five additive slices. Do not do a big-bang rewrite.**

The proposal's own advice is sound: Phases 1, 2, 3 and 6 first. Its proposed ~20-file
directory tree is not. Consolidate it into four modules so the merge stays reviewable:

| Proposal asks for | Merge to | Why |
| --- | --- | --- |
| `optimization/{core,composer,intensity,validator,diagnostics}.js` | `shared/optimization.js` | Pure, Chrome-free functions; unit-testable in isolation |
| `modes/{registry + 11 modes}.js` | `shared/modes.js` | One registry, built-ins as data; ship P0 modes first |
| `profiles/{capabilities,openai,anthropic,google,universal}.js` | `shared/capabilities.js` | Model-keyed, versioned entries; providers stay in `engines.js` |
| `evaluation/{rubric,fidelity,benchmark}.js` | `shared/evaluation.js` | Keeps scoring out of engine and UI code |

New modules used by the content script must be added to `manifest.json` →
`web_accessible_resources` (content.js dynamically imports from `shared/` at line 357-367).

---

## 3. Governing rules for the merge

1. **Additive only.** New settings get defaults in `DEFAULT_SETTINGS` and a v6→v7 step in
   `migrateSettings()`. Never overwrite an existing user value.
2. **Modes are not frameworks.** A mode is *what* is being optimized; a framework is *how*
   the result is organized. Store modes under a new key `promptcraft_modes`; never rewrite
   `promptcraft_frameworks`. Editing `DEFAULT_FRAMEWORKS` does not reach existing installs
   (`shared/frameworks.js:5-7`), so silently converting frameworks to modes would lose user data.
3. **Host inference stays the default.** Add explicit target selection as an override;
   `optimizePrompt()` must still derive the profile from the tab host when no target is set.
4. **Capability-gated parameters.** Unknown model ⇒ provider-neutral instructions and no
   new API parameters. Never send a parameter the endpoint has not declared support for.
5. **One registry, three surfaces.** Any new selector must be defined once and consumed by
   popup, modal and options, following the `engines.js` precedent. Do not copy arrays.
6. **Default-off for anything that changes output.** Behaviour changes land as their own
   slice with a captured baseline, not as a side effect of a UI feature.

---

## 4. Slice-by-slice merge

### Slice 0 — Baseline and safe workspace (prerequisite)

The proposal's first release-checklist item is a dedicated branch; locally there is no repo.

- Clone/pull `jswizzle3737/PromptOptimizer` (the local folder is missing `unit/` and
  `test_extension.js`, so its tests cannot be run here).
- Create `merge/optimizer-v2`; confirm the CI test command from PR #1.
- Record baseline output for a fixed corpus: 10 prompts × 5 frameworks × {offline, nano}.
- **Gate:** existing `unit/` tests all pass before any source edit.

### Slice 1 — Foundation: split core / mode / target / intensity (Phases 1 + 2, P0)

- Add `shared/optimization.js`: `composeSystemPrompt({ framework, mode, target, intensity,
  preferences })`, `validatePreservation(original, optimized)`, technique constants.
  Keep it free of `chrome.*` so tests run in Node.
- Replace the blanket `QUALITY_TECHNIQUES` with discrete techniques. Default core becomes
  intent preservation, accuracy, isolation and efficiency — **no forced persona, no forced
  ordered steps**. This is a deliberate output change; ship it in this slice and measure it
  against the Slice 0 baseline.
- Refactor `buildSystemPrompt()` to delegate to `composeSystemPrompt()` with the current
  signature intact, so all existing callers keep working.
- Add `shared/modes.js` with P0 modes only: `general`, `system`, `reasoning`, `agentic`, `coding`.
  Each is `{ id, name, description, instructions, validate }`. P1/P2 modes are data additions
  and need no engine change.
- Add `shared/intensity.js` (`light | balanced | aggressive`) as instruction modifiers plus
  a max-drift guard; `settings.optimizationIntensity` defaults to `balanced`.
- Extend `migrateSettings()` to v7 with `modeId: 'general'`, `optimizationIntensity:
  'balanced'`, `preferredTarget: ''`, `advancedSettingsOpen: false`, `diagnosticsEnabled: false`.
- **Gate:** all 5 built-in frameworks preserve user-created entries; adding a mode requires
  zero changes to `optimizer-engine.js`; baseline diffs reviewed and accepted.

### Slice 2 — Model capability intelligence (Phase 3)

- Add `shared/capabilities.js`: entries keyed by **model id**, each with
  `{ capability, support: 'yes'|'no'|'unknown', source, verified }` for native reasoning,
  structured output, function calling, caching, long context, streaming, local execution.
- Add explicit target resolution: `options.targetId || settings.preferredTarget ||
  getTargetProfile(options.host)`. Engine selection, keys and base URLs are untouched.
- Gate every new API parameter in `buildProviderRequest()` on a `yes` capability. `unknown`
  falls back to the existing provider-neutral path (`target = null`).
- **Gate:** unknown models get neutral instructions; no unsupported parameter is emitted;
  host auto-detection still works for all 12 sites with `preferredTarget` empty.

### Slice 3 — Evaluation replaces structural scoring as the primary measure (Phase 6)

- Leave `scorePrompt()` and `contractTraitIds()` in place, shown as **coverage**, not quality.
- Add `shared/evaluation.js` with three layers:
  - deterministic fidelity: every `{{variable}}`, `@file:`, `@mention`, `/command`, URL,
    path, code identifier and quoted constraint survives;
  - weighted rubric from the proposal (intent 25 / clarity 20 / reliability 15 / output 15 /
    security 10 / efficiency 10 / target fit 5), normalized;
  - AI-assisted semantic layer: generalize `judgeWithNano()` behind an engine-neutral
    interface, keeping it opt-in so offline use stays offline.
- A lost critical requirement is a **hard validation failure**, independent of the number.
- Result tabs: Optimized / Compare / Analysis / Evaluation. Reuse the existing diff behind
  `showDiffView` (`shared/storage.js:150`) rather than building a second diff engine.
- **Gate:** 100% placeholder and constraint preservation on the release corpus; all
  existing regression tests pass; zero silent remote calls in privacy tests.

### Slice 4 — Interface, context and security (Phases 4 + 5)

- Compact popup with an expandable Advanced section: strict wording preservation, minimize
  tokens, diagnostics, preview target, mode/intensity selectors.
- Wire the same controls into `popup.js`, `content.js` modal and `options.js` from one
  registry; add new shared modules to `web_accessible_resources`.
- Preserve Insert, Copy, Save, Continue, Cancel, refinement, `Alt+O`, Shadow DOM isolation,
  Gmail draft flow and native editor insertion.
- Security: extend `detectSecrets()` coverage from `systemPrompt`/`userMessage` to all
  serialized payloads, including variants, refine instructions and page context. Add prompt
  injection fixtures for drafts and page context. Keep `includePageContext: false` default
  and the 4,000-char cap. Request no new permissions.
- **Gate:** popup/in-page parity; no regression in secret detection; no silent transmission.

### Defer — Phase 7

Diagnostics, multi-model comparison, iterative refinement, runtime parameter recommendations,
version history and the prompt laboratory. Every one depends on the Slice 3 evaluator; do not
start them before it has a measured baseline.

---

## 5. Proposal items to change or drop as written

| Proposal item | Decision | Reason |
| --- | --- | --- |
| ~20 new files under `optimization/`, `modes/`, `profiles/`, `evaluation/` | Consolidate to 4 | Smaller diff, same separation of concerns |
| "Deep Optimization" mode | Defer to Phase 7 | It is iterative optimization under another name |
| "Structured output" as a universal instruction | Capability gate | Unknown models would receive unsupported guidance |
| "Compression" as a separate mode | Keep, but fold into `intensity: light` initially | Avoids two controls doing the same job |
| 80-hour estimate | Treat as rough | Based on an audit that had not been done; re-estimate after Slice 0 |
| Release order in §5 | Accept, map as S0→S1 Foundation, S2 Optimization, S3/S4 Reliability, defer Advanced | Matches the product-quality-first recommendation |

---

## 6. Acceptance checklist at the end of the merge

- [ ] Existing frameworks and user-created frameworks unchanged and still editable
- [ ] Provider keys, custom endpoints, fallback slots and Gemini Nano offline path unchanged
- [ ] All 12 site integrations, `Alt+O`, Shadow DOM insertion and Gmail draft flow unchanged
- [ ] Every mode produces materially different, purpose-appropriate instructions
- [ ] Unknown target models receive provider-neutral instructions
- [ ] No unsupported API parameter is silently introduced
- [ ] Placeholder and mandatory-constraint preservation at 100% on the release corpus
- [ ] Structural score demoted to a supplementary coverage indicator
- [ ] Secret detection covers all outgoing payloads; zero silent remote transmissions
- [ ] Popup, modal and options expose the same controls from one registry
- [ ] `unit/` tests and packaging script pass; clean install and upgrade both verified

---

## 7. Open items before implementation

1. Restore `unit/` tests from GitHub; the local folder cannot verify any acceptance criterion.
2. Decide whether the forced persona / ordered-steps removal in Slice 1 is a 1.5.0 behaviour
   change or an opt-in flag. It changes existing output, so it should not be silent.
3. Confirm the source/verification date for each capability-registry entry before publishing it.
