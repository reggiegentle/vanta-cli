# Security

## What this CLI stores locally

- Vanta OAuth client id and client secret, and a cached bearer token, in
  `~/.config/vanta/config.json` (mode `0600`, XDG-honored). The cached
  token carries a `clientIdFingerprint` so it is never reused for a
  different client id than the one that minted it.
- Two short-lived lock files, `config.lock` (guards token minting) and
  `ledger.lock` (guards write-ledger access). They are never held by the
  same code path at the same time, and neither is ever reclaimed
  automatically; a stuck one is cleared only by `vanta auth unlock`.
- A local write ledger (`write-ledger.jsonl`) recording every confirmed
  write this CLI has run: file names and content hashes for uploads,
  target ids, and readback results. It is not a session cookie or a
  browser artifact, and it never contains the client secret or the bearer
  token.

## Supported versions

This project is pre-1.0 (`0.x`). Only the latest published release is
supported; upgrade before reporting an issue against an older one.

## Reporting a vulnerability

If you find a way to leak a credential, bypass the host allowlist, defeat
the write ledger's dedup or readback checks, or otherwise compromise the
security properties described here, report it privately rather than in a
public issue, so a fix can ship before the details are public. Everything
else (ordinary bugs, feature requests, documentation gaps) can go through
the normal public issue tracker.

## Secret handling

The client id and client secret are never accepted as a command-line
flag, only as environment variables or an env file; they are never
printed, logged, or included in any command's JSON or text output, in any
form, including truncated. Vanta enforces a single active access token per
OAuth application, tenant-wide: minting a new one revokes whatever token
that application had before. This CLI enforces that discipline on its own
side with a hard per-process mint guard (one mint attempt per process,
ever), an upfront scope-union computation done once per command before any
request, and `config.lock` to coordinate minting across processes on one
machine. `auth status` and `doctor` print only `clientIdFingerprint8`, an
8-character fingerprint prefix, never the id, secret, or full fingerprint.

## Host allowlist

Every request, including token minting, is checked against an allowlist
before it is made: only `https://api.vanta.com`, `https://api.vanta-gov.com`,
or a subdomain of either. Anything else fails closed with `VALIDATION`
before a request is sent, unless `VANTA_ALLOW_UNSAFE_API_BASE_URL=1` is
set, which is intended for this project's own synthetic tests only.

## Readback and the write ledger

Every write command re-reads its own destination, independently, before
and after its call, and only reports success if the destination actually
changed the way the call claimed; a call that returns success but whose
readback disagrees is reported as failed. A write's intent is recorded in
the ledger before its call, and its result is recorded immediately after.
A crash between those two lines leaves an unresolved intent: `ledger
list` surfaces it as such, and the duplicate check treats it as if the
operation already ran. If the API call itself succeeds but the result
line then fails to write, the command exits `CHECK_FAILED` and prints
both the call's returned id(s) and the exact ledger line an operator must
append by hand, so a real mutation is never silently missing from the
ledger, even though it can require that manual step to get there.

## Verifying a release

Run `npm run check:release` (typecheck, tests, the public-surface check,
and the secret sweep) against any checkout before trusting it.
