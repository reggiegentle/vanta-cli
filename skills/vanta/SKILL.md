---
name: vanta
description: Query and act on Vanta SOC 2 and compliance evidence (frameworks, controls, tests, documents, policies, vendors, and people) through the vanta CLI. Summarizes by default, requires an exact confirmation for every write, and never prints the OAuth secret or the bearer token.
---

# Vanta CLI

Unofficial command-line client for the official Vanta Manage API. Not
affiliated with or endorsed by Vanta. Every command returns one JSON
object: `{ok: true, data}` on success, `{ok: false, error: {code,
message}}` on failure. Pass `--json` on every command invoked from an
agent.

## First checks

Before doing anything else in a session, run:

```
vanta auth status --json
vanta doctor --json
```

`auth status` reports whether credentials are configured and whether a
cached token is present and unexpired, without ever printing the client
id, client secret, or the token itself. `doctor` performs one real round
trip to confirm those credentials still work against the configured host.
If either reports `AUTH_MISSING`, stop and tell the operator to run `vanta
auth login`; do not attempt to supply credentials on the command line,
since this CLI never accepts them as a flag.

## Best starting commands

- `vanta soc2 report --json`: the one aggregate report. Counts and
  enum-bucketed groupings only, no control or document names and no ids,
  by design, so it is safe to summarize back to a user without a second
  sanitization pass.
- `vanta evidence gaps --json`: the one worklist, not an aggregate report.
  It lists the controls with no evidence mapped or not started, and the
  documents needing a new upload or an update, by name and category,
  because an operator needs those names to act on the list. It is still
  sanitized (no emails, URLs, secrets, or raw ids unless `--show-ids` is
  passed); it is just a different, real gate than `soc2 report`'s, never
  a weakened version of it.

Read commands beyond these two (`frameworks`, `controls`, `tests`,
`documents`, `policies`, `people`, `users`, `vendors`, `risk-scenarios`,
`integrations`) follow the same `list`/`get` shape and are summarized the
same way; add `--raw` only when the full upstream row is genuinely needed.

## Safety rules for writes

- `documents upload` is dry-run by default: without `--write`, it prints
  the full plan (file names, sizes, content types, hashes, destination
  ids) and makes zero requests. `--write` alone is not enough; it also
  requires `--confirm` to match an exact expected value, usually the
  destination id, never a filename.
- Every write confirms by an exact upstream value, never by filename or
  title: `documents upload` and `documents submit` confirm with the
  document id; `documents link` confirms with the URL being linked;
  `documents set-owner` and `controls set-owner` confirm with the user
  id; `controls add-document` confirms with the document id being added
  (not the control id positional argument).
- A duplicate file (same content hash) uploaded to the same document is
  refused unless `--allow-duplicate` is passed.
- Every write's JSON output includes a `readback` block. Check
  `readback.verified` before treating the write as done; a write whose
  call returned success but whose readback disagrees is a real failure
  (`CHECK_FAILED`), not a soft warning.
- Before uploading anything, run `vanta ledger list --json` to see what
  has already run on this machine; it groups every prior write by command
  and shows whether it was verified.

## Locking

A `LOCKED` error means another `vanta` process on this same machine is
currently running. Retry later; do not run `vanta auth unlock`
reflexively. `auth unlock --force` clears a lock even if its owner is
still running, which can interrupt work that process is still doing, so
only use it once you have confirmed no other `vanta` process on this
machine is genuinely still active.

## Cross-machine rule

This CLI's lock only coordinates processes on the machine it runs on.
Vanta allows exactly one active access token per OAuth application,
tenant-wide: running the same client id and secret from a second machine
will still revoke this machine's token the moment that second machine
mints one, regardless of any lock. If you operate this CLI from more than
one machine against the same tenant, each machine should have its own
Manage Vanta application credentials, not a shared client id and secret.
