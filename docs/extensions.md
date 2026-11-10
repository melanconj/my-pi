# my-pi extension and configuration reference

This document is the user-facing reference for the extensions shipped by `my-pi`.
Read it before changing extension behavior. Read `codemap.md` for module ownership
and source paths. Read pi's own documentation for the host extension API.

## How configuration is layered

`my-pi` is a pi package. The root `package.json` registers `./extensions`,
`./skills`, `./prompts`, `./themes`, and `./agents` as package resources.
Every prompt contribution composes through pi's structured prompt options, so
extension load order carries no correctness weight. Extensions are raw
TypeScript. Pi loads them at runtime. There is no build step.

Unless an extension says otherwise, the pi agent directory is `~/.pi/agent`.
Pi's `PI_CODING_AGENT_DIR` setting changes that directory for extensions that use
pi's agent-directory helper. A project-local file normally lives under the
current project's `.pi/` directory or in the current working directory.

Configuration is not one shared schema. Each extension owns its files, fields,
defaults, and failure behavior. Unknown fields are ignored only where the
extension says so.

## Configuration at a glance

| Extension or feature | Configuration surface | Main options |
| --- | --- | --- |
| Autoflow autostart | `~/.pi/agent/autoflow.json` | `autoStart`, `command` |
| Subagent model tiers | `~/.pi/agent/model-tiers.json` and `.pi/model-tiers.json` | `cheap`, `medium`, `smart`, `frontier` |
| LLM Gateway provider | Environment and pi provider ID | `LLMGATEWAY_API_KEY`, provider ID `llmgateway` |
| Quota attachments | `~/.pi/agent/quota-providers.json` | Provider IDs, usage-source modules, and quota policy fields |
| Workspace personas | `<cwd>/AGENTS.md` | `kind`, `name`, `description`, `tools`, `model`, `skills`, body |
| Model prompt overlays | `AGENTS.<model>.md` files | `models` front matter and Markdown body |
| Subagent definitions | `~/.pi/agent/agents`, `.pi/agents`, package `pi.agents` | `name`, `description`, `tools`, `model`, `skills`, body |
| Web tools | Environment and cache location | `BRAVE_API_KEY`, `PI_CODING_AGENT_DIR` |
| Prompt template creator | `/nprompt <name>` | Project-local `.pi/prompts/<name>.md` |

The remaining extensions have no configuration file. They expose behavior or
commands: `worktree`, `session-resume`, `session-name`, `print-prompt`,
`ask-user`, `user-edit`, `new-prompt`, and the core `subagents` orchestration tools.

## Autoflow autostart

Create `~/.pi/agent/autoflow.json` to opt into rewriting the first plain user
message of each new root session as an autoflow invocation:

```json
{
  "autoStart": true,
  "command": "/skill:autoflow"
}
```

Options:

- `autoStart` is a boolean. It defaults to `false`.
- `command` is a slash command. It defaults to `/skill:autoflow`.
  It must start with `/` and contain no surrounding whitespace.

A missing or unreadable file disables autostart. Invalid JSON or invalid fields
use the defaults and emit a warning. Resumed, forked, and subagent child
sessions do not autostart.

## Subagent model tiers

The subagents extension accepts four advertised tier names: `cheap`, `medium`,
`smart`, and `frontier`. Map them to available model IDs with JSON files:

```json
{
  "cheap": "provider/fast-model",
  "medium": "provider/balanced-model",
  "smart": "provider/strong-model:xhigh",
  "frontier": "provider/frontier-model"
}
```

- Global configuration: `~/.pi/agent/model-tiers.json`.
- Project configuration: `<cwd>/.pi/model-tiers.json`.
- The project file overlays the global file for matching tier names.
- Only the four known keys with string values are used. Bad files and entries
  are ignored without throwing.
- A configured model must be available in pi's model catalog. An unavailable
  model falls back to the session default.
- A model may use pi's thinking suffixes: `off`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, or `max`, for example `provider/model:xhigh`.

Tier names work in `subagent` model arguments and agent-definition `model`
fields. Omit `model` to inherit the current session's model and thinking level.
A concrete model ID passes through unchanged. Resurrect also accepts a
`model`, resolved by the same precedence as spawning: the persona `model` pin
wins, then the explicit value, then the model the session last ran on. A
resurrected agent that declares nothing keeps its persisted concrete model.

`/fmodel <model>` in a root session forces every subagent in that session tree
onto one model, ahead of persona pins and explicit arguments. A `:<level>`
suffix carries effort and outranks the level a fork or pin would otherwise
bind. The force lasts for the session and is never persisted. Run `/fmodel`
with no argument to clear it.

## LLM Gateway provider

The `llm-gateway` extension registers the normal pi provider ID `llmgateway`.
It uses the OpenAI Completions API at `https://api.llmgateway.io/v1` and sends
`LLMGATEWAY_API_KEY` as a bearer key. Set the key before starting pi:

```sh
export LLMGATEWAY_API_KEY="..."
```

The provider fetches `/v1/models` when its stored catalog is missing, older than
one hour, or explicitly refreshed. It restores a fresh catalog without a
network request and restores the stored catalog when network access is disabled.
The provider owns model discovery and streaming. It does not enforce quota.

Use `llmgateway` in pi settings and model references. The provider ID replaced
`devpass-openai-completions`. Migrate existing references before resuming old
sessions:

1. Set `defaultProvider` to `llmgateway` in pi settings.
2. Replace `devpass-openai-completions` with `llmgateway` in the pi model store
   (`<agentDir>/models.json`) and session JSONL records.
3. Keep model IDs unchanged. Only the provider ID changed.

The migration applies to session and model-store data.

## Quota attachments

Quota attachments enforce usage policy for providers that already exist in pi.
They do not register providers or discover model catalogs. Create
`~/.pi/agent/quota-providers.json` to attach a usage source to a provider ID:

```json
{
  "providers": {
    "llmgateway": {
      "module": "~/src/my-pi/extensions/quota-providers/impls/devpass-quota.ts",
      "billingCycleAnchor": "2026-11-01T13:33:00.000Z",
      "bypassAllowed": true,
      "lookaheadHours": 6,
      "maxPollSeconds": 300,
      "enforceHardCap": false
    }
  }
}
```

Use the path to your checkout for `devpass-quota.ts`. The top-level `providers`
value must be an object. Each attachment requires `module`. A module path can
start with `~/`. Other fields pass to the quota source unchanged.

Policy fields have these defaults:

- `enabled` defaults to `true`.
- `bypassAllowed` defaults to `true`.
- `lookaheadHours` defaults to `6`.
- `maxPollSeconds` defaults to `300`.
- `enforceHardCap` defaults to `false`.

Malformed JSON and malformed attachments are skipped with warnings. A missing
file means no attachments. Set `PI_CODING_AGENT_DIR` to move this file and its
cache. The extension stores state under
`<agentDir>/cache/quota-providers/<provider-id>/`.

### Built-in DevPass quota source

`extensions/quota-providers/impls/devpass-quota.ts` is a quota source for the
`llmgateway` attachment. It reads usage from `/v1/key` and model membership from
`/v1/models`. `LLMGATEWAY_API_KEY` is required for both requests.

`billingCycleAnchor` must be an ISO-8601 UTC timestamp at a known monthly
renewal boundary. It can also be a `$ENV_VAR` reference. The source uses that
anchor to calculate the monthly window. When the account reports a premium
pool, it adds an independently resetting `premium-weekly` snapshot and maps
premium model IDs from catalog prices.

### Built-in GitHub Copilot quota source

`extensions/quota-providers/impls/copilot.ts` is a quota source for the
`github-copilot` attachment. Set its `module` to that file in
`quota-providers.json`. It reads the stored GitHub OAuth login from
`auth.json`, queries Copilot's account-usage endpoint, and reports AI-credit
usage as a calendar-month dollar quota. It requires token-based AI-credit
billing; legacy premium-request billing and Enterprise logins are unsupported.

Quota sources are TypeScript modules. Follow the seam types in
`extensions/quota-providers/lib/types.ts` when writing one outside this repo.

## Workspace personas

A workspace persona is declared only by the current working directory's
`AGENTS.md`. The extension does not walk parent directories or subdirectories.
The file needs `kind: persona` and a non-empty `name`:

```markdown
---
kind: persona
name: release-engineer
description: Prepare safe production releases.
tools: read, bash, edit
model: provider/release-model:xhigh
skills: debugging, codemap
---

You are the release engineer for this workspace.
```

Supported front matter fields:

- `kind: persona` enables the declaration. Any other value leaves the file as
  ordinary project context.
- `name` is required.
- `description` is optional.
- `tools` is a comma-separated allowlist.
- `model` is a tier name or concrete model ID. It can carry a thinking suffix.
- `skills` is a comma-separated skill allowlist.
- The Markdown body becomes the persona preamble.

The body replaces pi's default identity — the persona IS the personality.
The mechanism is a self-healing host patch: at extension activation,
persona-workspaces rewrites the host's prompt builders to accept
`sections.preamble` as an override of the default identity sentence. It
patches both the unbundled SDK module and the minified CLI bundle when both
are present (an explicit `--system-prompt` still outranks it). On a patched
host the body is
the preamble — pi's first slot — with pi's own tool declarations, rules,
docs, project context, skills, and working directory untouched below it, and
a body edit records as a small preamble-only delta. The running process keeps
its in-memory module, so the patch activates from the next session start; the
extension notifies once. On an unpatched or incompatible host the persona
stacks as a plain `<persona>` custom section on top of pi's preamble until
the patch activates. Ancestor `AGENTS.md` files still load as project
context; only the persona file itself is dropped from context so its body
does not appear twice. `AGENTS.<model>.md` overlays are separate files and
keep applying. Other package prompt contributions (subagent definitions,
model overlays) ride as tagged sections, so extension load order does not
matter.

The workspace persona wins wholesale over a spawned persona. Fields do not
merge. An explicit launch `--system-prompt` wins over the ambient persona.
The declaration is re-applied when a session starts, resumes, reloads, or
forks. Keep front matter flat: this parser does not support nested YAML,
inline comments, or escape decoding.

## Model prompt overlays

Model overlays are Markdown files named `AGENTS.<something>.md`. They can live
in the global agent directory or in trusted project ancestor directories:

```markdown
---
models:
  - anthropic/claude-*
  - provider/special-model
---

Use the repository's review checklist for this model.
```

`models` is required and must be a non-empty string or string array. Values are
simple `*` globs matched against the active model ID. A pattern-matching file
without front matter is not an overlay and is ignored silently. The body is
added to the system prompt as a `model-overlays` section when a pattern matches.

The global agent directory always participates. Project ancestors participate
only when pi marks the project trusted. Overlays apply from broad to narrow,
with nearer roots taking precedence through ordering. Malformed overlays produce
one warning per diagnostic and are skipped.

## Subagent definitions

A subagent definition is a Markdown file with flat front matter. The required
fields are `name` and `description`:

```markdown
---
name: scout
description: Read-only codebase search agent.
tools: read, bash
model: cheap
skills: codemap
---

You investigate the repository and report relevant files.
```

Optional fields are `tools`, `model`, and `skills`. Each list is comma-separated.
The body is the specialist system prompt.

Definitions can come from:

- `~/.pi/agent/agents/` (user definitions)
- the nearest `<project>/.pi/agents/` (project definitions)
- package resources declared by `pi.agents`

More-local definitions with the same `name` replace less-local definitions.
This package contributes `agents/scout.md`, `agents/comment-sicko.md`, `agents/spaghetti-sicko.md`, and `agents/test-sicko.md`.

## Web tools

`web_search` requires `BRAVE_API_KEY`:

```sh
export BRAVE_API_KEY="..."
```

`web_search` accepts `query`, optional `count` (1–20), and optional
`freshness` (`pd`, `pw`, `pm`, `py`, or a date range). `web_fetch` accepts up
to eight URLs and supports `format`, `maxCharacters`, `offset`, and `findText`.
These are tool-call parameters, not extension config files.

Fetched pages are cached under `<agentDir>/web-tools/cache/`, where
`<agentDir>` is `PI_CODING_AGENT_DIR` or `~/.pi/agent`. The cache uses a
24-hour TTL and keeps at most 1,000 entries. Search results use an in-memory
five-minute, 100-entry cache.

## Extensions with no external configuration

These extensions are configured through their commands or tool calls rather
than files:

- `subagents`: use `subagent`, `fork`, `await_agents`, `interrupt`, `resurrect`,
  and related tools. Agent definitions and model tiers are documented above.
  Child sessions bind extensions in print mode without a UI context, so
  `ctx.hasUI` is false and Pi supplies no-op UI methods. Subagents do not expose
  tools with `model-only` exposure; attempted calls are blocked.
- `worktree`: use `/worktree` with `create`, `resume`, or `cleanup` arguments.
- `session-resume`: detects interrupted sessions automatically. It has a
  developer debug script at `scripts/pi-resume-debug.ts`.
- `session-name`: use `set_session_name` with `oldName` set to the current name,
  or `""` when unnamed; names are trimmed, line breaks become spaces, and names
  are limited to 200 characters.
- `print-prompt`: use `/sysprompt` to inspect the last rendered system prompt.
- `ask-user`: root sessions use `ask_user`.
- `user-edit`: use `user_edit` to open the built-in editor.
- `new-prompt`: use `/nprompt <name>` to create or edit `.pi/prompts/<name>.md` in the built-in editor. New files open with a compact scaffold that demonstrates prompt-template front matter and argument substitutions. Save, then run `/reload` to load the template as `/<name>`.

## Downstream code customization

To change behavior beyond these files, fork or clone the package and edit the
raw TypeScript in `extensions/`. The package manifest registers extension
resources through `package.json`:

```json
{
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"],
    "agents": ["./agents"]
  }
}
```

Use the extension's entry point (`extensions/<name>/index.ts`) and its colocated
tests as the contract. Add dependencies with the package manager. Do not add a
build step: pi loads these `.ts` files directly.

For pi extension APIs, lifecycle events, custom tools, and package installation,
read pi's upstream documentation. This document describes only the additional
configuration and behavior supplied by `my-pi`.
