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
| Quota providers | `~/.pi/agent/quota-providers.json` | Provider modules and quota policy fields |
| Toolscript | `~/.pi/toolscript/toolscript.toml` and `toolscript.toml` | Toolscript's TOML; `TOOLSCRIPT_BIN` selects the executable |
| Workspace personas | `<cwd>/AGENTS.md` | `kind`, `name`, `description`, `tools`, `model`, `skills`, body |
| Model prompt overlays | `AGENTS.<model>.md` files | `models` front matter and Markdown body |
| Subagent definitions | `~/.pi/agent/agents`, `.pi/agents`, package `pi.agents` | `name`, `description`, `tools`, `model`, `skills`, body |
| Web tools | Environment and cache location | `BRAVE_API_KEY`, `PI_CODING_AGENT_DIR` |
| Azure Foundry provider | Quota-provider settings and environment | `account`, `resourceGroup`, `subscription`, `tokenResource`, `AZURE_FOUNDRY_ENDPOINT` |
| DevPass provider | Quota-provider settings and environment | `billingCycleAnchor`, `LLMGATEWAY_API_KEY` |

The remaining extensions have no configuration file. They expose behavior or
commands: `worktree`, `session-resume`, `session-name`, `print-prompt`,
`ask-user`, `user-edit`, and the core `subagents` orchestration tools.

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
fields. A concrete model ID passes through unchanged. Tier resolution happens
when a child is spawned. A resurrected child keeps its persisted concrete model.

## Quota providers

Create `~/.pi/agent/quota-providers.json` to load out-of-repository provider
implementations:

```json
{
  "providers": {
    "foundry": {
      "module": "~/src/my-pi-foundry.ts",
      "account": "my-azure-account",
      "resourceGroup": "my-resource-group",
      "subscription": "my-subscription",
      "tokenResource": "https://cognitiveservices.azure.com",
      "bypassAllowed": true,
      "lookaheadHours": 6,
      "maxPollSeconds": 300,
      "enforceHardCap": false
    }
  }
}
```

The top-level `providers` value must be an object. Each provider block requires
`module`. A module path may start with `~/`. The module-specific settings pass
through unchanged to the implementation.

Core policy fields:

- `enabled` defaults to `true`.
- `bypassAllowed` defaults to `true`.
- `lookaheadHours` defaults to `6`.
- `maxPollSeconds` defaults to `300`.
- `enforceHardCap` defaults to `false`.

Use `/quota` for status and `/quota bypass on|off` (or `/quota bypass` to toggle)
to override soft pacing within the current agent tree. An enforced hard cap is
never bypassable, even if the service permits paid overage. Bypass does not
persist across restarts.

Session activity and provider requests trigger asynchronous usage refreshes,
respecting `maxPollSeconds`. The next activity updates the footer. Decisions use the
latest valid active snapshot; without one, no local quota block is applied.
Refresh failures retain the previous snapshot, show a stale/error status, and
back off before retrying. Expired windows are not enforced.

Malformed JSON and malformed provider entries are skipped with warnings. A
missing file means no providers. Set `PI_CODING_AGENT_DIR` to move this file
and its cache. The extension stores provider state under
`<agentDir>/cache/quota-providers/<provider-id>/`.

### Built-in provider implementations

The repository includes implementation modules under
`extensions/quota-providers/impls/`.

**Azure Foundry** uses the following provider settings:

- `account` and `resourceGroup` are required.
- `subscription` is optional.
- `tokenResource` is optional and defaults to
  `https://cognitiveservices.azure.com`.
- `AZURE_FOUNDRY_ENDPOINT` supplies the API base URL.
- The Azure CLI must be installed and authenticated with `az login`.

**DevPass** uses the following settings and environment variable:

- `LLMGATEWAY_API_KEY` is required.
- `billingCycleAnchor` is an ISO-8601 UTC timestamp, or a `$ENV_VAR` reference.

### GitHub Copilot

Copilot extends pi's built-in `github-copilot` provider, preserving its login,
catalog, routing, and `models.json` overrides. It uses the same quota evaluation,
pacing, hard-cap policy, statusline, and tree-scoped bypass as the other providers.
Requires pi 1.4 or newer.

Enable `extensions/quota-providers/index.ts` in the my-pi package's extension
filter (`pi config`), then add this entry to `~/.pi/agent/quota-providers.json`:

```json
{
  "providers": {
    "copilot": {
      "module": "builtin:copilot"
    }
  }
}
```

The built-in alias resolves within the installed package; no checkout-specific
path or additional dependency is needed. Each user signs in normally through
`/login` → GitHub Copilot. Reload pi or start a new session, select a Copilot
model, and run `/quota`.

Usage is converted at **1 AI credit = $0.01**, using entitlement and its
compatible remaining balance (percentage is a fallback). The provider reports
UTC calendar-month windows. Retail model prices are not guaranteed to match
Copilot charges, so only authoritative usage snapshots count toward this budget.
Polling and backend reporting can lag; this is not per-request reservation.

The quota GET reads the current stored GitHub OAuth credential without refreshing
or writing it. No PAT or separate API key is needed. Optional `authPath` selects
another pi `auth.json` file (supports `~/`); arbitrary custom/in-memory SDK
credential stores are not discovered automatically. Credentials and raw account
responses are never cached.

Supported: AI-credit billing with calendar-month windows. Explicit unlimited
allowances have no finite cap. Legacy premium-request billing, Enterprise
logins, and non-calendar windows are rejected rather than assigned invented
dollar budgets. The internal GitHub quota endpoint is not a stable public API.

The guard covers both streaming methods for native Copilot APIs; unrelated APIs
added through custom `models.json` entries are unsupported. Each quota-owning
session needs its own model runtime, as used by standard my-pi roots and children;
sharing a runtime between separately loaded quota extension instances is unsupported.

### Provider implementation seams

Managed gateways implement `ProviderImplementation` in
`extensions/quota-providers/lib/types.ts`. Built-in native integrations implement
`NativeProviderImplementation`, declaring `nativeProviderId` and the same
`getUsage(ctx)` seam. Both use the shared usage runner/cache, dollar snapshots,
policies, and bypass store. Native registration keeps authentication and catalog
refresh delegated to pi.

Implementation-level `accounting: "provider"` excludes local model-cost ledger
estimates. Native implementations default to this mode; managed gateways default
to `"ledger"`. Use ledger accounting only when local costs match provider billing.

## Toolscript

The toolscript extension starts the `toolscript` MCP server when it finds at
least one configuration file:

- User config: `~/.pi/toolscript/toolscript.toml`.
- Project config: `<cwd>/toolscript.toml`.

Both files are passed to toolscript in that order. The project file can add or
override settings according to toolscript's TOML rules. The extension does not
parse TOML itself.

Set `TOOLSCRIPT_BIN` when the executable is not named `toolscript` or is not on
`PATH`:

```sh
export TOOLSCRIPT_BIN="$HOME/bin/toolscript"
```

If no config file exists, the extension stays inactive. Toolscript tools appear
in pi with a `toolscript_` prefix. The server restarts on the next tool call
after a crash.

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
simple `*` globs matched against the active model ID. The body is added to the
system prompt as a `model-overlays` section when a pattern matches.

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
This package contributes `agents/scout.md` and `agents/comment-sicko.md`.

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
- `worktree`: use `/worktree` with `create`, `resume`, or `cleanup` arguments.
- `session-resume`: detects interrupted sessions automatically. It has a
  developer debug script at `scripts/pi-resume-debug.ts`.
- `session-name`: use `set_session_name`; names are trimmed, line breaks become
  spaces, and names are limited to 200 characters.
- `print-prompt`: use `/sysprompt` to inspect the last rendered system prompt.
- `ask-user`: root sessions use `ask_user`.
- `user-edit`: use `user_edit` to open the built-in editor.

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
