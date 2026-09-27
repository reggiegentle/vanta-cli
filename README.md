# vanta-cli

Unofficial, agent-first command-line client for the official Vanta Manage
API. Not affiliated with or endorsed by Vanta. It is a generic tool for
any Vanta customer: it does not assume or encode any one tenant's
workflow, and it never sends data anywhere other than the Vanta host you
configure.

## Install

```
npm install -g @reggiegentle/vanta-cli
```

Requires Node.js 22 or newer. Installs two identical binaries, `vanta`
and `vanta-cli`.

## Quick start

```
vanta auth login
vanta doctor --json
vanta soc2 report --json
```

`auth login` resolves credentials (below), reuses a cached token or mints
one, and confirms it against Vanta. `doctor` re-checks that same
connectivity and prints a short, sanitized status summary. Every command
supports `--json` for machine-readable output; without it, the CLI prints
the same data as human-readable text.

## Auth setup

Vanta issues OAuth client credentials (a client id and client secret) for
a Manage API application. This CLI never accepts either as a command-line
flag. It resolves them, highest precedence first, from:

1. `VANTA_CLIENT_ID` / `VANTA_CLIENT_SECRET` environment variables.
2. `VANTA_OAUTH_CLIENT_ID` / `VANTA_OAUTH_CLIENT_SECRET` environment
   variables.
3. An env file of `KEY=VALUE` lines, passed with `--env-file <path>` on
   `auth login`, or read by default from `~/.config/vanta/.env` if that
   file exists and no environment variables were set.
4. The credentials already saved by a previous `auth login`, in
   `~/.config/vanta/config.json` (XDG-honored via `$XDG_CONFIG_HOME`),
   file mode `0600`.

The client id, client secret, and bearer token are never printed, logged,
or included in any command's output. `auth status` and `doctor` print
`clientIdFingerprint8`, the first 8 characters of a hash of the client id,
so you can visually confirm which application a machine is configured
with, without ever exposing the id itself.

**Single active token, per application, tenant-wide.** Vanta allows
exactly one active access token per OAuth application at a time; minting
a new one immediately revokes whatever token that application had before,
regardless of which process or machine minted it. This CLI coordinates
processes on one machine with two local lock files, `config.lock` (token
minting) and `ledger.lock` (write-ledger access), so that two `vanta`
commands running on the same machine never race each other into a mint or
a duplicate write. **That coordination has no reach across machines.**
Running the same client id and secret on a second machine will still
revoke the first machine's token the moment the second one mints, lock or
no lock. If you run this CLI from more than one machine against the same
tenant, give each machine its own, separate Manage Vanta application (its
own client id and secret), so their mints stay independent.

Neither lock file is ever reclaimed automatically. If a `vanta` process is
killed mid-command, its lock can be left behind; the next command that
needs that lock will exit with a `LOCKED` error naming the lock and the
process that holds or held it. Run `vanta auth unlock` to clear a lock
whose owning process has already exited (it never removes a lock whose
owner is still running). `vanta auth unlock --force` clears a lock even
if its owner is still running; only use it when you are certain no other
`vanta` process on this machine is genuinely still working, since it can
interrupt that process mid-command.

## Command reference

Every command supports `--json`. `list` commands (and the nested,
per-resource listings such as `controls tests <id>`) support `--limit
<n>`, `--all` (walk every page instead of stopping at the limit), and
`--raw` (skip summarization, print the parsed upstream rows unchanged).
`get <id>` commands take neither `--limit` nor `--all` (there is exactly
one row to fetch), but still support `--raw` (skip summarization, print
the parsed upstream row unchanged).

### auth

- `auth login [--env-file <path>] [--force-mint]`: resolve credentials,
  reuse a cached token or mint a new one, and persist it. `--force-mint`
  always mints a fresh token, revoking the tenant's current one for this
  application; the CLI warns about this on stderr first.
- `auth status`: report whether credentials are configured, whether a
  cached token exists and is unexpired, and its granted scopes.
- `auth clear`: delete the saved config file (credentials and cached
  token). Never touches the write ledger or either lock file.
- `auth unlock [--force]`: clear a dead or malformed `config.lock` or
  `ledger.lock`. `--force` also clears a lock whose owner is still
  running.

### doctor

- `doctor`: the same status computation as `auth status`, plus one real
  round trip against the configured Vanta host (reusing the cached token
  or performing the one necessary mint) to confirm the credentials
  actually work.

### frameworks

- `frameworks list`
- `frameworks get <id>`
- `frameworks controls <id>`

### controls

- `controls list [--framework <id>] [--with-status]`: without
  `--with-status`, returns the base control fields (no status; the list
  endpoint does not carry it). With `--with-status`, fetches per-control
  detail for every row afterward, which costs roughly two minutes of wall
  time for a 75-control framework at Vanta's rate limit; `--framework` is
  required unless the tenant has exactly one framework.
- `controls get <id>`: already includes status and evidence counts.
- `controls tests <id>`
- `controls documents <id>`
- `controls set-owner <control-id> --user-id <id> [--write] [--confirm <value>]`
- `controls add-document <control-id> --document-id <id> [--write] [--confirm <value>]`

### tests

- `tests list [--status <s>] [--framework <id>] [--category <c>] [--integration <id>]`
- `tests get <id>`
- `tests entities <id> [--entity-status <s>]`

### documents

- `documents list [--status <s>] [--framework <id>]`
- `documents get <id>`
- `documents uploads <id>`
- `documents controls <id>`
- `documents links <id>`
- `documents upload <files...> --document-id <id> [--link-control-id <control-id>...] [--effective-date <date>] [--description <text>] [--allow-duplicate] [--write] [--confirm <document-id>]`
- `documents link <document-id> --url <url> --title <title> [--description <text>] [--effective-date <date>] [--write] [--confirm <value>]`
- `documents set-owner <document-id> --user-id <id> [--write] [--confirm <value>]`
- `documents submit <document-id> [--write] [--confirm <value>]`

### policies

- `policies list`
- `policies get <id>`

### people

- `people list [--task-status <s>] [--task-type <t>] [--employment-status <s>]`
- `people get <id>`

### users

- `users list`

### vendors

- `vendors list [--name <s>] [--status <s>]`
- `vendors get <id>`

### risk-scenarios

- `risk-scenarios list [--type <t>] [--review-status <s>]`

### integrations

- `integrations list`

### api

- `api get <path> [--query key=value...] --unsafe-raw`: pass-through GET
  to any Manage API read path, accepting either a bare relative path
  (`frameworks`) or a `/v1/`-prefixed one. Requires `--unsafe-raw`; fails
  closed without it, before making any request.

### soc2

- `soc2 report [--format json|markdown] [--out <path>]`: the one
  aggregate report. Counts and enum groupings only, by design; no control,
  document, or person names, titles, or ids appear anywhere in it.

### evidence

- `evidence gaps [--framework <id>] [--show-ids] [--format json|markdown] [--out <path>]`:
  the one worklist. `--framework` defaults to the tenant's SOC 2 framework
  when it has exactly one framework; otherwise it is required. Unlike
  `soc2 report`, it is allowed to show control and document names,
  because an operator needs them to act on the list. Upstream ids are
  still omitted unless `--show-ids` is passed.

### ledger

- `ledger list [--limit <n>] [--show-ids]`: a summary of every write this
  CLI has run on this machine (by command, by day, and the most recent
  operations), sourced from the local write ledger.

## Safety model

- **Summarized by default, `--raw` opt-in.** Every read command
  summarizes upstream rows, replacing free-text names, emails, and URLs
  with presence flags or a stable local display reference (`control-001`,
  `document-014`), so agent output is safe to log or paste without
  accidentally exposing tenant content. `--raw` returns the parsed
  upstream JSON unchanged, for a human operator who explicitly asked for
  it.
- **Two sanitization gates, never mixed.** `soc2 report` is an aggregate
  report: it is checked to contain only counts and closed-enum groupings,
  never a name, title, email, URL, or raw id. `evidence gaps` is a
  worklist: it is allowed to show control and document names (an operator
  needs them to act), but is still checked for emails, URLs, secrets, and
  raw ids, which stay hidden unless `--show-ids` is passed.
- **Dry-run by default.** Every write command (`documents upload`,
  `documents link`, `documents set-owner`, `documents submit`, `controls
  set-owner`, `controls add-document`) prints its full plan and makes zero
  requests and zero token acquisitions unless `--write` is passed.
  `--write` alone is not enough: it also requires `--confirm <value>`
  matching an exact expected value, so a copy-pasted command cannot
  silently mutate the wrong tenant object. The expected value is the
  document id for `documents upload` and `documents submit`, the URL
  being linked for `documents link`, the user id for `documents
  set-owner` and `controls set-owner`, and the document id being added
  for `controls add-document` (not the control id positional argument).
- **Readback, not trust.** Every write re-reads its own destination,
  independently, before and after the call, and only reports success if
  that identity or attribute actually changed the way the call claimed. A
  write whose call succeeds but whose readback disagrees is reported as
  failed (`CHECK_FAILED`), never as a silent success.
- **One stop rule.** If a write's call or its readback fails, the command
  stops immediately. For `documents upload`'s multi-file, multi-link
  packet, that means the next file or link is never attempted; the
  command reports exactly which prior steps completed.
- **Write ledger.** Every write sub-operation records an intent line
  before its call and a result line immediately after, in `<config
  dir>/vanta/write-ledger.jsonl`. A crash between the two leaves an
  unresolved intent, which `ledger list` surfaces and which the duplicate
  check treats as if the operation already ran; if the call succeeds but
  the result line itself fails to write, the command exits
  `CHECK_FAILED` and prints the returned id(s) plus the exact line to
  append by hand. `documents upload` hashes every file up front and
  refuses to upload the same file to the same document twice unless
  `--allow-duplicate` is passed, checked against this ledger, not against
  filenames. `ledger list` reads it back as a summary.

## Contract

Every command prints one JSON object on success or failure:

```json
{ "ok": true, "data": { "...": "..." } }
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "..." } }
```

Exit codes: `0` on success, `1` for an execution, upstream, or lock
failure, `2` for anything auth-shaped (missing or invalid credentials).

Stable error codes: `AUTH_MISSING`, `AUTH_INVALID`, `NOT_FOUND`,
`RATE_LIMITED`, `TIMEOUT`, `UPSTREAM_5XX`, `VALIDATION`, `CHECK_FAILED`,
`LOCKED`, `UNKNOWN`. `LOCKED` means another `vanta` process on this same
machine currently holds `config.lock` or `ledger.lock`, or a dead process
left one behind; the error message directs you to `vanta auth unlock`.
