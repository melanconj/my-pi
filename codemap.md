# Codemap

## Overview

A personal [pi coding agent](https://github.com/badlogic/pi-mono) package providing a development workflow pipeline (brainstorm → architect → test-write → test-review → impl-plan → implement → review → handle-review → manual-test → cleanup), standalone utility skills, a subagent orchestration system, an Azure AI Foundry provider, and quota-aware provider support. Built as a pi package with TypeScript extensions and Markdown skills.

```mermaid
graph LR
  Workflow --> Skills
  Workflow --> Subagents
  Subagents --> Subagents
  PersonaWorkspaces --> Subagents
  ManualTesting
  SessionResume
  SessionName
  Worktree
  ModelPromptOverlays
  ToolscriptExtension
  UserEdit
```

### Key Flows

```mermaid
sequenceDiagram
  participant W as Workflow
  participant S as Skills (pipeline)
  participant SA as Subagents
  W->>S: route to phase skill
  S->>SA: delegate investigation/implementation
  SA-->>S: results
  S-->>W: artifact produced, phase complete
```

## Modules

### Workflow

The ten workflow skills and the autoflow orchestration skill that drives them. Autoflow is invoked via the `/skill:autoflow` skill command (or automatically on a new session's first message via the Autoflow Autostart extension); the skills define each phase's behavior and autonomous pipeline execution. A bundled transition-check script (`skills/autoflow/check-transition.ts`) validates phase artifacts between subagent handoffs.

**Responsibilities:** pipeline phase routing, artifact-driven handoffs, context boundary management, autonomous pipeline orchestration, autonomous phase transition validation, brainstorming facilitation, architectural decision-making (with lo-fi interactive HTML mocks for UI work, listed in the plan's handoff manifest, consumed by downstream phases, and deleted at cleanup), test writing, test review, implementation planning, dual-mode implementation execution, plan-based code review, review finding resolution, human-style manual testing with a persistent smoke suite, post-workflow cleanup with DR extraction

**Dependencies:** Skills (decision-records skill delegated from cleanup; autoflow orchestrates the pipeline from brainstorm through cleanup), Subagents (workflow skills delegate to subagents at runtime — scout investigation in architecting/impl-planning, worker orchestration in implementing, parallel fan-out in code review, autonomous phase execution in autoflow)

**Files:**
- `skills/autoflow/SKILL.md`
- `skills/autoflow/check-transition.ts`
- `skills/autoflow/check-transition.test.ts`
- `skills/brainstorming/SKILL.md`
- `skills/architecting/SKILL.md`
- `skills/test-writing/SKILL.md`
- `skills/test-review/SKILL.md`
- `skills/impl-planning/SKILL.md`
- `skills/implementing/SKILL.md`
- `skills/code-review/SKILL.md`
- `skills/handle-review/SKILL.md`
- `skills/manual-testing/SKILL.md`
- `skills/cleanup/SKILL.md`
- `docs/brainstorms/**`
- `docs/plans/**`
- `docs/reviews/**`
- `docs/manual-tests/**` — topic-specific manual-test reports, including persona-workspaces checks T1–T13/R1–R7/D1–D2 and their results
- `tools/manual-test/**` — permanent live-pi harnesses and journey plan: `persona-workspaces/run.mjs` (+ README) covers root takeover, spawned identity/override, binding, resume/reload, restore and fork; `model-tiers/run.mjs` is MT-provider/model-parameterized with provider-agnostic prompt extraction and devpass quota support; `resume-restore/README.md` documents `PI_CODING_AGENT_DIR` passthrough; `PLAN.md` includes journeys J8/J9 and updated J1/J2

### Skills

Standalone utility skills not tied to the workflow pipeline.

**Responsibilities:** codemap generation and maintenance, structured debugging, decision record management (format, numbering, supersession), skill authoring guidance (invocation axis, information hierarchy, pruning, leading words), domain language maintenance (glossary.md convention, active term-sharpening discipline), code design doctrine (deep modules/seams at module level, function-level principles in FUNCTIONS.md — referenced by the pipeline skills), periodic architecture review (user-invoked deepening scan with HTML report), tool prompt design (which field holds which fact: snippet for the planner, guidelines for cross-tool routing, description for the caller)

**Dependencies:** none

**Files:**
- `skills/codemap/SKILL.md`
- `skills/debugging/SKILL.md`
- `skills/decision-records/SKILL.md`
- `skills/skill-writing/SKILL.md`
- `skills/skill-writing/GLOSSARY.md`
- `skills/domain-modeling/SKILL.md`
- `skills/domain-modeling/FORMAT.md`
- `skills/codebase-design/SKILL.md`
- `skills/codebase-design/FUNCTIONS.md`
- `skills/codebase-design/DEEPENING.md`
- `skills/codebase-design/DESIGN-IT-TWICE.md`
- `skills/improve-code/SKILL.md`
- `skills/tool-design/SKILL.md`
- `docs/decisions/**`

### Web Tools

Typed `web_search` and `web_fetch` tools replacing the former brave-search shell-script skill. Search: Brave adapter with result normalization (canonical URL dedupe, domain filters) and compact card output, backed by a TTL/LRU memory cache. Fetch: URL/redirect SSRF policy gate, bounded HTTP fetch with retries and `Retry-After` handling, Readability→Turndown extraction with a quality gate (cookie-wall/shell/title-only signals), disk-backed page cache under the pi agent dir (atomic writes, lazy TTL, mtime pruning), offset pagination, case-insensitive `findText` passage retrieval, and bounded-concurrency batch fetch (max 8 URLs). Fetched pages are stored in full on disk so continuation and passage search are cache hits across restarts. Research grounding in `docs/research/web-search-landscape.md`.

**Responsibilities:** web discovery (Brave), known-URL retrieval, main-content extraction, page caching, bounded context delivery (slice/offset/findText), URL/redirect policy enforcement, structured results (`outputSchema`/`structuredContent` over the normalized search response and per-URL fetch metadata including the page slice, so codemode scripts get data instead of cards)

**Dependencies:** Brave Search API (`BRAVE_API_KEY`), `@mozilla/readability`, `jsdom`, `turndown`, `turndown-plugin-gfm` (from the package root), `lib/truncate.ts`

**Dependencies:** Brave Search API (`BRAVE_API_KEY`), `@mozilla/readability`, `jsdom`, `turndown`, `turndown-plugin-gfm` (from the package root)

**Files:**
- `extensions/web-tools/**` — `index.ts` (tool registration), `web-search.ts`/`search/brave.ts`/`search/normalize.ts` (discovery), `web-fetch.ts`/`http.ts`/`extract.ts` (retrieval/extraction), `url-policy.ts` (SSRF/redirect policy), `fetch-store.ts` (disk page cache), `cache.ts` (search memory cache), `find-text.ts` (passage search), `types.ts` (canonical types), with colocated tests and HTML fixtures
- `docs/research/web-search-landscape.md`

### Subagents

Long-lived in-process subagent orchestration extension — creates and manages SDK child sessions with channel-based messaging and incremental membership. Each child owns an SDK-created `ModelRuntime`, backed by the common persisted Pi configuration rather than a parent in-memory auth or model registry. Includes agent definitions and skills for using/creating agents.

**Responsibilities:** per-root/child session ownership and lifecycle wiring, subagent lifecycle management, spawn-time persona selection (one active persona file per child — a workspace `AGENTS.md` with `kind: persona` at the child's effective cwd wins wholesale over the discovered spawned definition; the active file's `model`/`tools`/`skills` feed the construction bindings and the discarded file's fields never reach construction; a wholesale override of a requested `persona` is surfaced to the orchestrator as a note line in the `subagent` tool result (`persona 'X' overridden by workspace persona 'Y' (<cwd>)`); a persona's `model` pin outranks an explicit `model` spawn argument, which is gap-filling only; restores/resurrections re-resolve tools/skills from the active file while the persisted model survives), spawn-declared persona payload carriage (the spawned definition's `{name, body}` rides as a first-class persona payload marked on each child SessionManager via the extended `child-session-marker.ts` registry — no longer flattened into `appendSystemPrompt` — so Persona Workspaces can bind it as the child's preamble; the public `subagent` item field `persona` maps onto the internal `RegularAgentSpec.agent` / persisted `agent` name, keeping historical lifecycle JSONL readable without migration, with legacy `agent` call keys still accepted as a compatibility fallback), model-intelligence tier resolution (`cheap`/`medium`/`smart`/`frontier` tier names — the advertised vocabulary for the `subagent` tool's `model` field and agent-definition pins — resolved to concrete model IDs at spawn time from a JSON config overlay: `~/.pi/agent/model-tiers.json` global + `.pi/model-tiers.json` project override, both read unconditionally — tier remapping is user configuration, not a trust boundary; malformed config is tolerated by dropping bad entries; unconfigured or unavailable tiers fall back to the child's session default with a once-per-extension-load notice; raw model IDs and thinking-level suffixes pass through unchanged; tier config values stay plain strings (`TierConfig` type unchanged); system-prompt injection contributes a `subagents` section through structured options mutation (not a forced-prompt append) carrying the discovered agent-definitions block and a Model Tiers table — via `renderTierTable` — replacing the former Available Models list and now advertises the `model:<level>` shorthand with the seven valid levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); model resolution is suffix-aware: the `stripThinkingSuffix` pure helper splits a trailing `:<valid-level>` off a model string (only if the suffix is one of the six levels, so colon-bearing model IDs like `openai/gpt-x:exacto` are left whole), and both `resolveModelRef` and `renderTierTable` judge availability on the model part alone while passing the full suffixed string through as the `--model` value), on-demand model catalog discovery (`list_models` tool — full available-model table with context window and pricing, for the rare case a concrete model id is explicitly required), persistent per-parent child-session storage, append-only agent lifecycle logging for restore/replay, faithful subagent status recomputation on parent-session resume (each restored child's own pi session JSONL is re-parsed via a pure forward-pass parser to seed `state: idle` plus snapshot-derived usage/model/lastOutput/context-fill/`hasSubgroup`, following a recompute-over-replicate principle rather than a fabricated `running`/zeroed seed; event-driven transitions flip back to `running` if the child auto-resumes), managed SDK child-session construction and replacement with isolated services and cooperative cancellation, parent-local in-memory routing, channel topology and deadlock detection, fork-based session branching, blocking await with interrupt handling (`await_agents`), notification queue with waiting-mode drain and abort-aware settling (an aborted run never triggers the next one: queued notifications are parked on the next turn via `deliverAs: "nextTurn"` instead of flushed with `triggerTurn`, so `interrupt`/Escape actually stops the agent and `session.abort()`'s `waitForIdle` can resolve, while nothing is lost), bounded interrupt settling (`SubagentManager.interrupt` returns `settled`/`pending` rather than awaiting idle forever, so a tool that ignores its abort signal cannot hang the caller), whole-subtree presentation on both UI paths (the TUI dashboard widget and the pimote panel cards render every live descendant of the root — via `registry.listDescendants` and `SubagentManager.getDisplayStatuses` — as one flat list whose entries are labelled with their path-qualified id, `worker/scout`, so the tree shape is inferable from the label; the TUI elides leading ancestors rather than the leaf when a label outgrows its card, and this widening is presentation-only: tools, routing, channel validation and notifications stay scoped to immediate children), pimote idle-reap responder (root scope answers `@pimote/sdk/activity`'s synchronous poll — DR-054 — through the pure flat-liveness predicate in `activity.ts` over registry snapshots: live iff any descendant is `running` or is `waiting` on a target that is not the root session), agent definition discovery (four-tier package merge), orchestration guidance, specialist agent authoring guidance, generic prompt-failure surfacing (when a child emits an error-level notify while marked running with no `agent_start` since its last prompt, the entry settles as `errored`), a five-state agent lifecycle (`running`/`waiting`/`idle`/`errored`/`dead`, where `idle` and `errored` are both settled-with-a-live-session and a later `send` revives either — `errored` merely records that the last run failed, and `agent_start` clears it — while `dead` is the single terminal state, produced only by a child runtime requesting shutdown, tombstoning the routing endpoint until teardown + resurrect replaces the id; see DR-046), post-teardown resurrection (`resurrect` tool — revive a torn-down agent from its persisted session file, surfacing `session_id` in completion reports and `<group_complete>` summaries with a usage hint), per-agent working-directory overrides on `subagent` (`agents[].cwd` resolved relative to the parent's cwd, validated batch-atomically as an existing directory, persisted in the agent's session record and replayed on restore, pruned at restore time if the directory has since been deleted; `fork` and `resurrect` deliberately inherit cwd rather than accept overrides). Runtime model: one root session registry contains live descendants while each manager owns only immediate-child orchestration and routing; bulk spawn/teardown operations are convenience APIs, not durable group identities. Result seam (DR-060): every model-facing surface passes one truncation point (tool results wrap `truncateForModel` at the session-owner boundary; queue flushes/deferred deliveries use sync `truncateMiddle`), the codemode-reachable tools declare `outputSchema` with `structuredContent` built by `tool-results.ts` (typed reports, per-agent usage, session ids), and usage follows the lifecycle — each manager entry records a usage baseline at creation (zero for spawn/resurrect, replayed for parent-session restore) so `teardown` reports the per-agent delta and labels a non-zero baseline. Idle notifications carry `session_id`.

**Dependencies:** Persona Workspaces (imports its pure `declaration.ts` persona parser for spawn-time active-persona selection; a one-way code dependency — see that module for the reciprocal registry dependency)

**Files:**
- `extensions/subagents/**` — includes `session-owner.ts` (per-scope active session owner, fixed manager lifetime, environment/presentation/turn/incoming-message state owners, tool/event adapters — the `subagent` tool's public item field is `persona`), `tool-results.ts` (typed tool-result payloads, matching TypeBox output schemas, and the status/usage builders behind them), `agent-session-registry.ts` (per-root canonical tree, immutable snapshots, atomic lifecycle, presentation attachment), `managed-child-session.ts` (isolated SDK child runtime and cooperative lifecycle — the child cwd is always trusted: no trust hook is passed and pi's default project-trusted state stands, so a child loads all project resources of whatever directory it is opened into; the former headless ask→no trust adapter is removed), `delegating-extension-ui.ts` (stable headless/attached UI seam), `child-tool-policy.ts` and `agent-path.ts` (pure policy/path helpers), `child-session-marker.ts` (process-global registry identifying subagent child session managers and carrying their spawn-declared persona payload so other extensions can stay silent in children), `message-router.ts` (parent-local in-memory routing), `agent-set.ts` (manager orchestration, active-persona selection, and failure detection), `notification-queue.ts` (waiting-mode notification drain), `session-snapshot.ts` (forward-pass restore parser), `panel-cards.ts` (pure subagent-status → pimote panel-card projection — plain-text tags only, the web client has no nerd-font glyphs), `activity.ts` (pure flat-liveness predicate behind the pimote idle-reap responder, DR-054), `status-display.ts` (shared state naming/detail/color mapping used by both UI surfaces), and `model-tiers.ts` (tier resolution/rendering), with corresponding tests
- `vitest.config.ts` (repo root — test runner config)
- `skills/orchestrating-agents/SKILL.md`
- `skills/orchestrating-agents/PATTERNS.md`
- `skills/orchestrating-agents/COORDINATION.md`
- `skills/orchestrating-agents/MODEL-SELECTION.md`
- `skills/orchestrating-agents/ADVANCED.md`
- `skills/specialist-design/SKILL.md`
- `agents/scout.md`
- `agents/comment-sicko.md`

### Persona Workspaces

Extension that lets a persona file take over a session — a *persona file* is either a discovered agent definition or a working directory's `AGENTS.md` with `kind: persona` front matter. The persona IS the personality: the body displaces pi's default identity at the head of the prompt and never stacks under it by choice — stacking is only the self-healing fallback on an unpatched host. Persona presence is orthogonal to root-vs-subagent: all four root/child × persona/plain combinations are valid.

**Responsibilities:** strict cwd-only workspace persona declaration parsing (`<cwd>/AGENTS.md` exactly — one directory deep, no ancestor walk; unknown `kind` values silently ignored and a non-persona file left entirely alone as project context), per-run prompt binding (`before_agent_start`; the active persona's body binds as `sections.preamble` — pi's first slot — every run, so pi's own tool declarations, rules, docs, project context, and skills stay untouched below it in default order; mid-session edits take effect at the next run and record as a small preamble-only delta; an explicit launch `--system-prompt` outranks the ambient persona and touches nothing; the workspace's own AGENTS.md is filtered from `contextFiles` so pi cannot append it twice — ancestor AGENTS.md files and `AGENTS.<model>.md` overlays are untouched; a declared `skills` list filters the per-run skills view, while root sessions keep unlisted skills' slash commands loaded — extensions can add skills at discovery but not subtract), session-start front-matter binding (`session_start`; root `model`/`tools` rebind at every boundary, including resume/reload/fork, via `pi.setModel`/`pi.setActiveTools` with child-side `resolveChildToolPolicy` normalization; child construction is owned by Subagents), and the child-side transcript-visible `customType: "persona-notice"` override message with a registered pi-tui renderer and transcript-based deduplication (the only notice — persona takeovers are silent by design, with `/sysprompt`'s projection as the pre-run visibility surface). Persona sources are exclusive: a workspace declaration wins wholesale over a spawned definition — one active persona file per session, fields never merged, absent fields fall to defaults/baseline.

**Dependencies:** Subagents (reads spawn-declared persona payload from `child-session-marker.ts` via `ctx.sessionManager`; Subagents also imports this module's pure `declaration.ts` parser to resolve active child construction fields).

**Prompt composition:** every prompt contribution in the package goes through the structured prompt options (`sections`) — Subagents contributes a `subagents` section and Model Prompt Overlays a `model-overlays` section, and nothing returns a forced `systemPrompt` — so extension load order carries no correctness weight.

**Deployment (self-healing host patch):** unpatched pi throws on a section named `preamble`, so `host-patch.ts` rewrites the host's unbundled prompt module and, for the standard CLI, its minified `dist/bundle/chunks` prompt builder at extension activation — three exact-string touches (validation guard, `customSections.preamble ??` override under the `customPrompt`-unset branch, merge-loop precedence), atomic, idempotent, once per runtime directory. The running process keeps its in-memory module: the override tier activates from the next session start, and the extension notifies once. Until then — the first session after a pi/pimote update, or an incompatible runtime — the persona stacks as a plain `<persona>` custom section on top of pi's preamble. The transform is all-or-nothing with per-snippet verification, so an incompatible pi never gets a partial write.

**Files:**
- `extensions/persona-workspaces/**` — `declaration.ts` (pure `kind: persona` front-matter parsing + strict cwd loader), `host-patch.ts` (self-healing host runtime patch enabling `sections.preamble`: pure exact-string transform + atomic file application), `index.ts` (the `session_start` and `before_agent_start` handlers, tier selection, and the `persona-notice` renderer), `package.json` (pi extension manifest), with colocated tests

### Session Resume

Extension that detects interrupted sessions and injects resume markers so the agent can orient on restart.

**Responsibilities:** idle-state tracking on agent_end, resume detection on session_start, session-resume debug tooling

**Dependencies:** none (standalone extension loaded by pi)

**Files:**
- `extensions/session-resume/**`
- `scripts/pi-resume-debug.ts`

### Session Name

Extension that provides a `set_session_name` LLM tool — lets the model name (or clear) the current session's display name, the same `session_info` mechanism behind `/name` and the session-selector rename. The name shows in session lists and resume pickers. Each session names itself: a subagent's call names its own child session (overriding its agent-path-derived name), never the parent's.

**Responsibilities:** set_session_name tool registration, name normalization (line breaks to spaces, trim, empty clears), length validation (200 chars after normalization), unchanged-name no-op to keep session files free of redundant `session_info` entries. Result carries `details` ({name, previous}); the seam exemplar.

**Dependencies:** none (standalone extension loaded by pi)

**Files:**
- `extensions/session-name/**`

### Autoflow Autostart

Extension that opt-in triggers the autoflow pipeline at the start of a new session: the session's first user message is rewritten to an autoflow invocation with that message appended (`/skill:autoflow <message>` by default), so it enters the pipeline exactly as if the user had invoked it in one send.

**Responsibilities:** opt-in config loading (`~/.pi/agent/autoflow.json` — `autoStart` flag plus a configurable invocation `command`; a missing or malformed file degrades to opt-out with a one-time warning), new-session trigger arming (fresh root sessions only — resumes, forks, and subagent child sessions never autostart), first-message rewrite via the `input` event (other slash commands and `!`/`!!` bash pass through and stay armed; a manual autoflow invocation or input queued during streaming consumes the trigger)

**Dependencies:** Subagents (queries `child-session-marker.ts` to stay silent inside subagent child sessions, which load this extension too)

**Files:**
- `extensions/autoflow-autostart/**` — `index.ts` (pi wiring), `config.ts` (pure config parsing + agent-dir loading), `trigger.ts` (pure arming and rewrite decisions), with colocated tests

### Worktree

Extension that manages git worktree–based branch sessions — create a worktree, optionally transfer working changes and session context, resume an existing worktree, or clean up by merging back and removing the worktree.

**Responsibilities:** worktree lifecycle (create, resume, cleanup), branch creation via `git worktree add`, stash-based change transfer between worktrees, merge orchestration (delegates to agent via `sendUserMessage`), cross-cwd session transitions (fork/create/continue), interactive prompts for context transfer and pending-changes policy, `/worktree` command argument parsing and branch-name autocomplete

**Dependencies:** none (standalone extension; uses pi core extension APIs and git CLI at runtime)

**Files:**
- `extensions/worktree/**`

### Quota Providers

Generic quota-aware provider extension. Out-of-repo provider implementations plug in through typed seams (model discovery, auth, usage, retryable-error classification). Core adds pro-rated spend backpressure so a provider's billing window isn't burned early. Native implementations extend existing built-in providers under the same ID while preserving auth, discovery, routing, and host model overrides; both implementation forms use the same dollar quota pipeline. Modules are loaded via jiti from `~/.pi/agent/quota-providers.json`, with a package-relative `builtin:copilot` alias for portable setup.

**Responsibilities:** config-driven discovery and registration, provider model discovery (block-once cold start, background refresh), out-of-band token/usage polling, local dollar ledger or provider-authoritative accounting, provider-call-boundary soft pacing and opt-in hard caps, tree-scoped bypass propagated to in-process subagents, optional gateway retry classification, `/quota` status/bypass and footer, validated usage caches with shared poll locks and failure backoff, native-provider wrapping (`lib/native-provider.ts`) preserving host auth/catalog/model overrides while guarding both streaming methods

**Dependencies:** Subagents' tree-scoped key/value store; uses `@earendil-works/pi-ai` for catalog metadata, memory credential storage and API stream fallback, and pi's public `ModelRuntime` for native-provider/catalog layers

**Files:**
- `extensions/quota-providers/**`
- `lib/session-tree-store.ts` — shared interface for tree-scoped extension state
- `lib/tool-args.ts` — shared schema-driven normalizer (`dropEmptyOptionals`, `registerLooseTool`): treats empty optional tool parameters (`""`, `[]`, `false` for booleans) as omission via the `prepareArguments` hook

### Quota Provider Implementations

Built-in quota-provider implementation modules for Azure AI Foundry, the LLM Gateway DevPass service, and native GitHub Copilot. They are loaded through the Quota Providers extension rather than as standalone extensions.

**Responsibilities:** Azure deployment discovery and AD tokens via `az`; LLM Gateway catalog, auth, and billing windows; Copilot usage via the existing GitHub OAuth login, converting AI credits at $0.01 into shared monthly dollar snapshots without catalog-cost estimates

**Dependencies:** Quota Providers (typed implementation seams), Azure CLI for Foundry, provider environment variables

**Files:**
- `extensions/quota-providers/impls/foundry.ts`
- `extensions/quota-providers/impls/devpass.ts`
- `extensions/quota-providers/impls/copilot.ts` (and colocated tests)

### Toolscript Extension

Extension that integrates toolscript by spawning it as a long-lived MCP child process and surfacing its tools as pi tools.

**Responsibilities:** toolscript process lifecycle (spawn via `StdioClientTransport`, graceful shutdown), MCP client management via `@modelcontextprotocol/sdk`, pi tool registration from MCP tool definitions (prefixed `toolscript_`), layered config file resolution (user `~/.pi/toolscript/toolscript.toml` + project `toolscript.toml`), crash recovery with auto-restart on next tool call, MCP seam fidelity (every result wrapped as `{content, structuredContent, isError}` under a wrapper `outputSchema` mirroring pi's MCP bridge, upstream `isError` surfaced as a real tool error, image blocks forwarded, model-facing text middle-truncated with a full-output temp file)

**Dependencies:** none as a standalone extension (runs as MCP child process); uses `lib/truncate.ts`

**Files:**
- `extensions/toolscript/**`

### Shared Tool Seam

Model-facing result/truncation helpers shared by every local tool.

**Responsibilities:** `truncateMiddle`/`truncateForModel` mirroring pi's unexported MCP-bridge behavior (20 KiB middle truncation around the `…N chars truncated…` marker, full text to a temp file named in the result, graceful degradation when the save fails); the seam contract itself is DR-060

**Dependencies:** `@earendil-works/pi-coding-agent` (`withFileMutationQueue`)

**Files:**
- `lib/truncate.ts`
- `lib/truncate.test.ts`

### Ask User

Extension providing the root-session `ask_user` LLM tool and reusable `showAskUser` TUI helper — a keyboard-driven single-choice dialog with inline annotation support; child sessions are prevented from invoking it by Subagents' normalized SDK tool policy.

**Responsibilities:** ask_user tool registration for root sessions, interactive option-list TUI component, selection and annotation flow, result `details` ({label, index, annotation} or {cancelled}) for rendering; no `outputSchema` — model-only exposure means codemode scripts can never call it

**Dependencies:** Subagents (child tool policy excludes `ask_user`; root sessions register it normally)

**Files:**
- `extensions/ask-user/**`
- `lib/components/ask-user.ts`

### User Edit

Extension that provides a `user_edit` LLM tool — opens a file in pi's built-in editor UI so the user can manually edit it. On save, the file is written to disk. Supports new file creation (opens empty, creates on save including parent dirs).

**Responsibilities:** user_edit tool registration, editor UI integration, file read/write with mutation queue, new-file creation with parent directory creation, result `details` ({path, saved}); no `outputSchema` — model-only exposure means codemode scripts can never call it

**Dependencies:** none (standalone extension loaded by pi)

**Files:**
- `extensions/user-edit/**`

### Model Prompt Overlays

Extension that discovers AGENTS.*.md overlay files, matches them against the active model ID via glob patterns, and contributes matching content to the system prompt as a `model-overlays` section (structured options mutation, not a forced-prompt append).

**Responsibilities:** context root discovery (global agent dir + ancestor walk, mirroring pi's AGENTS.md resolution), overlay file loading and frontmatter validation (models field), glob-based model ID matching with specificity ranking, deterministic sort order (root order → broad-to-narrow specificity → path), overlay block rendered into a `model-overlays` section, per-session deduplicated diagnostic notifications

**Dependencies:** none (standalone extension; hooks `before_agent_start`)

**Files:**
- `extensions/model-prompt-overlays/**`

### My-pi Documentation

Extension configuration reference and the prompt pointer that makes it discoverable to agents.

**Responsibilities:** maintain the canonical extension/configuration reference; inject its absolute path into a small `before_agent_start` system-prompt section without copying the full document into every turn

**Dependencies:** none beyond pi's extension API

**Files:**
- `docs/extensions.md`
- `extensions/my-pi-docs/index.ts`
- `extensions/my-pi-docs/index.test.ts`

### Prompts

Slash-command prompts distributed with the package.

**Responsibilities:** `tidy` runs repo tidying; `resolve-conflicts` works an in-progress merge/rebase conflict by intent; `experiment` runs a goal-driven experiment campaign (candidate queue, single-variable A/B trials with baseline and keep-or-revert, living experiment log).

**Dependencies:** none.

**Files:**
- `prompts/tidy.md`
- `prompts/resolve-conflicts.md`
- `prompts/experiment.md`

### Conventions

Repo working rules for this package (`docs/conventions.md`): codebase rules that hold when working in `my-pi` — skill format, raw-TS extensions with no build step, agent definition format, subagents as a local extension. Cross-repo rules (dependency changes, git hooks, tone, initiative) live in `~/.pi/agent/AGENTS.md` and are not repeated here.

**Dependencies:** none.

**Files:**
- `docs/conventions.md`
