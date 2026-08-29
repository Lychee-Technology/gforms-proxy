# ADR 0007: The Worker serves registered forms only; no live schema extraction

**Status:** Accepted
**Date:** 2026-08-28
**Source:** issue #9, whose scope changed during design; recorded on that issue

## Context

The Worker shipped with `GET /schema?url=...` and `POST /schema` (PR #1,
`a33707c`). At that point those two routes plus `GET /` were the entire Worker:
the conversion from a local CLI to an HTTP service lifted the CLI's capability
onto HTTP, and both the submission endpoint and the bundled registry (ADR 0001)
came afterwards. `/schema` was never built for a known caller.

Issue #9 reported the cost of that. Every `/schema` call fetched the form from
Google, including for forms already registered — whose schema is bundled into
the Worker and needs no network at all. A frontend calling `/schema` on each
render paid an outbound round trip per page load, and because the endpoint is
unauthenticated, anyone could use it as a free traffic amplifier aimed at
Google.

The issue proposed caching `/schema` behind a short TTL. Two findings made
removal the better answer:

- **Nothing called it.** No code in this repository issues an HTTP request to
  `/schema`; `scripts/gen-field-mapping.ts` imports `fetchAndParseForm` from
  `src/lib/parser.ts` directly. The repo owner confirmed nothing outside the
  repository called it either.
- **The production use case never wanted it.** README's "website for small
  business" describes a frontend rendering a *registered* form. What that
  frontend needs is the bundled schema, not a live re-parse of a form whose
  structure the Worker already ships.

A cache narrows an amplifier. Removing the endpoint closes it.

## Decision

The Worker performs no live schema extraction. `GET /schema` and `POST /schema`
are removed, along with the root health-check route `GET /`, which served
nothing in an API-only project.

Two routes remain:

```
GET  /api/v1/forms/:formId/schema     → the registered form's bundled schema
POST /api/v1/forms/:formId/responses  → submission
```

The schema endpoint reads `definition.schema` from the registry and returns it
verbatim, answering `404 {"error": "Form not found"}` for an unregistered ID —
the same wording the submission endpoint uses. It carries no `Cache-Control`
header: a bundled schema changes only on deploy, so a TTL would buy a stale
window after every deploy in exchange for saving a request the Worker answers
from memory.

Because Hono's default 404 is plain text while every other error this API emits
is JSON, an `app.notFound` handler returns `404 {"error": "Not found"}`. That
wording stays deliberately distinct from `Form not found`, so a caller can tell
a mistyped path from an unregistered form.

Turning a form into a schema remains `scripts/gen-field-mapping.ts`'s job, run
offline. Registration is still manual (ADR 0001).

## Consequences

**The Worker no longer fetches a caller-supplied URL.** Its runtime outbound
requests are now two, both to fixed addresses: Google's `formResponse` and
Turnstile's siteverify. There is no path where the caller decides what the
Worker fetches, which is what made the amplifier possible.

**`parser.ts` and `schema.ts` become build-time-only modules.** `src/index.ts`
was their only Worker-side importer; `scripts/gen-field-mapping.ts` is now the
sole consumer. Both files and all their tests stay — they are load-bearing for
generation, not dead code.

**`validateFormUrl` / `GOOGLE_FORMS_REGEX` stops being a runtime defence.** The
anchoring added in issue #8 (PR #25) closed a path-traversal bypass on a URL
that arrived over HTTP. No such URL reaches the Worker any more, so that regex
now guards the offline generator only: it protects a developer running the CLI
against a mistyped or hostile URL, not a public endpoint. It is still worth
keeping and still worth being strict about — but a later reader finding
URL-hardening code with no runtime caller should not conclude it is dead.

**Clients embedding a registered form must call the new endpoint.** Nothing was
calling `/schema`, so this broke no deployed caller, but the removal is a
breaking change to the public surface for anyone who finds the old README.

**A form that is not registered can no longer be inspected over HTTP.** Reading
an arbitrary public form's structure now means running the generator locally.
That is the intended trade: the ability was a convenience for exploration, and
it was paid for with an open outbound proxy.
