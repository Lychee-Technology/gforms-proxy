# ADR 0005: Backtracking-free matcher for Google Forms patterns

**Status:** Accepted
**Date:** 2026-08-27
**Source:** design spec "Backtracking-Free Pattern Matcher" (2026-08-27); posted on issue #21

## Context

ADR 0002 originally evaluated a Google Forms (RE2) `pattern` locally only when
it was both semantically compatible with JavaScript and safe to run on
JavaScript's backtracking engine. The execution-safety half was a syntactic
heuristic: at most one repetition, quantifying a single atom, unbounded
repetition only behind a leading `^`, and no alternation.

The heuristic was far narrower than the danger it guarded. `^\d{3}-\d{4}$`,
`^(yes|no)$` and `[a-z]+@[a-z]+\.[a-z]+` were all refused, and the generator
would not write a definition containing one, so such a form could not be
onboarded at all. The anchor rule was also unsatisfiable for regex `contains`
and `does_not_contain`, which `schema.ts` emits unanchored.

Widening the heuristic does not scale. The hard case is not a nested
quantifier but `(?:a|aa)` concatenated thirty times, which is exponential with
no quantifier anywhere; deciding that a concatenation of alternations is
unambiguous is NFA determinization.

Patterns come from forms the operator registers, not from request bodies, so
catastrophic backtracking requires an operator to onboard a pathological regex
by accident. Local validation is a UX affordance that produces a fast,
structured 400; Google remains the authority.

## Decision

Execute patterns on a Thompson NFA simulation we own (`src/lib/re2/`) instead
of on `RegExp`. A recursive-descent parser produces an AST, a compiler expands
it into a flat instruction program, and a simulation without captures runs it
in O(n·m·R) with no backtracking, where n is the input length in code points,
m the instruction count, and R the number of ranges in a single `char`
instruction's character class (`[a-c0-9]` has two). R is a real factor, not a
constant: the matcher tests membership with a linear scan over the class's
ranges. It is bounded rather than eliminated — see "Bounding the product"
below. Sorting and merging the ranges at parse time and binary-searching them
would make that factor `log R`; that is a performance improvement on an already
bounded quantity, and it is tracked separately (#30).

Execution safety stops being a property of the pattern. Alternation, multiple
quantifiers, quantified groups and nested quantifiers are all accepted. What
remains is a purely semantic question — which RE2 constructs the parser can
model faithfully. Unsupported constructs — among them `\p{…}`, `(?i)`, POSIX
classes, named groups, lookarounds, `\A`, `\z`, `\Q…\E`, `\x{…}`, `\a`, octal
and backreference escapes such as `\101`, negated class escapes inside a
character class (`[\S]`, which is set subtraction the range representation
cannot express; where the escape is the class's only member, `[^\s]` is the
rewrite), and lone surrogates — still return no matcher and still fail open.

Four narrower refusals round the list out. A character class may not take `]`
as its first member (`[]a]`, `[^]a]`), which RE2 reads as a literal `]`;
escaping it, `[\]a]`, compiles. Nor may it take `:` as its first member
(`[:abc]`, `[^:abc]`), the POSIX form's prefix. A quantifier may not be applied
to a zero-width assertion (`^*`, `$*`, `\b*`, `(?:^)*`). Groups may not nest
deeper than 200. RE2-only escapes from the families already named (`\pL`,
`\P{…}`, `\C`, `\0`) are refused too.

What is left over is mostly patterns RE2 rejects outright — an operand-less or
doubled quantifier, unbalanced parentheses, an unterminated class, an inverted
range. But `src/lib/re2/parser.ts` is the boundary; a list kept in prose is the
wrong place to look for an exhaustive answer, and this one has read narrower
than the code before.

Three simplifications follow from answering only "does this match": capturing
and non-capturing groups compile identically, greedy and lazy repetition accept
the same language so greediness is not represented at all, and no
leftmost-longest bookkeeping is needed.

Repetition is bounded on two axes. RE2's own maximum repeat count of 1000 is
retained as a semantic limit — RE2 rejects `a{1001}`, so a Google Form cannot
contain one, and honoring it keeps us in agreement with Google. A total budget
of 4000 instructions caps the compiled program, so `a{1000}` compiles while
`(?:a{1000}){1000}` is refused as "pattern too large".

A second limiter sits beside that budget, because compiler work and emitted
instructions are not the same quantity. An empty repetition body such as
`(?:){1000}` emits no instructions yet still costs a node visit per iteration,
so a nested stack of them would compile forever without ever reaching
`MAX_PROGRAM_SIZE`. A work counter, budgeted at four times the instruction
limit, bounds visits as well as output: `a{1000}a{1000}a{1000}a{996}` compiles
to 3997 instructions, while `(?:(?:(?:(?:){1000}){1000}){1000}){1000}` is
refused at once. Both limiters report the same "pattern too large".

### Bounding the product

`O(n·m·R)` with no cliff is a claim about shape. Making it a claim about
magnitude takes a bound on each of the three factors, and the instruction
budget only supplies one of them.

m is bounded by `MAX_PROGRAM_SIZE` (4000), above.

R is bounded by a third compile-time limiter, `MAX_TOTAL_CLASS_RANGES`, also
4000. It counts the ranges of every `char` instruction the program emits, not
the largest single class: the simulation's work at one input position is the
ranges reachable across all active instructions, so the program's total is the
quantity that actually caps the per-character cost. An overrun is refused as
"pattern too large" like the other two, deliberately introducing no new refusal
reason. Real patterns are nowhere near it — `\w` contributes 4 ranges, `\s` 3,
`\d` 1, and a hand-written class usually fewer than 10 — so the limiter cannot
bite a form an operator would onboard; `\w{1000}` sits exactly on it.

n is bounded at the matcher's call site. A schema's `maxLength` already bounds
it where one exists: like `maxItems`, it is terminal for its property, so an
oversized string never reaches the pattern check. For a schema without one,
`validator.ts` caps the input at 10,000 code points — code points, not UTF-16
units, matching how the matcher measures its input — and skips the pattern
check for anything longer, logging once per pattern rather than once per
request so an attacker cannot flood the log with oversized bodies. The cap
lives in the validator, not in `match.ts`: `Matcher.test` returns a boolean and
must not acquire a third "don't know" state. Skipping is the trade the module
already makes for unsupported syntax — local validation is a UX affordance and
Google remains the authority (ADR 0002) — and it extends to `not` for the same
reason an uncompilable pattern does: skipping the forward check while letting
the `not` branch run would invert an unevaluable constraint into rejecting a
valid submission.

The worst case is therefore a bounded product, and it was measured rather than
estimated. `[^b]{1000}[^b]{1000}[^b]{1000}[^b]{995}` — 3996 instructions and
3995 ranges, near both compile-time budgets, with every thread kept alive by an
input of 10,000 `a`s, so the simulation carries the maximum thread set at every
position — takes about 150 ms, and at most 200 ms across runs, on a developer
laptop under Node 22. Saturating R instead of m is cheaper: `\w{1000}` (4000
ranges) over the same input takes about 14 ms. Hundreds of milliseconds is a
real cost for one field and is worth watching, but it is a bound, it holds for
every pattern the parser accepts, and no pattern can exceed it.

`gen-field-mapping --allow-unevaluable-patterns` turns the generator's failure
into a warning and records `unevaluablePatternsAllowed: true` in the definition,
which does the same for `validate:forms`. Some RE2 syntax will remain
unsupported however wide the matcher grows, and a UX-layer limitation should
never make a form permanently un-onboardable.

## Consequences

- Pattern matching is linear in input length for every accepted pattern, with
  no shape-dependent cliff, and the cost is now bounded in magnitude as well as
  in shape. The exponential blowup is gone unconditionally: no pattern the
  parser accepts can cost more than n·m·R, whatever its shape, and all three
  factors are capped — n at 10,000 code points by the validator, m at 4000 by
  the program budget, R at 4000 total ranges by the range budget. The measured
  worst case is roughly 150 ms of CPU for one field, so "bounded by
  construction" is literally true rather than a statement about shape. The two
  follow-ups are re-scoped accordingly. #29, a request body size limit, still
  matters, but for the request's other linear scans — `JSON.parse` and
  `uniqueItems` hashing — not for the matcher, which no longer depends on it.
  #30, sorting the ranges at parse time and binary-searching them, becomes a
  performance optimisation that turns R into log R inside an already bounded
  budget, not a safety fix.
- The price of bounding n is one more fail-open case. A value over 10,000 code
  points has its pattern check skipped, so a schema with no `maxLength` accepts
  such a value locally and leaves it for Google to reject. That is the same
  trade ADR 0002 makes for unsupported syntax, and it is preferable to spending
  unbounded CPU on an attacker-chosen length.
- The subset a form author must respect is explainable in one sentence:
  standard regex syntax, minus the constructs the Decision above lists — chiefly
  Unicode property classes, inline flags, POSIX classes, lookarounds, named
  groups, negated class escapes inside a character class, and a handful of RE2
  escapes — with counted repetition capped at RE2's own maximum of 1000 and,
  beyond that, by the program budget, the compiler's work counter and the
  class-range budget.
  `SAFE_SUBSET_HINT` in `pattern-policy.ts` puts this summary, not the
  Decision's fuller enumeration, in front of whoever runs the generator; both
  are maintained by hand against the parser.
- We own a regex matcher. A bug in it produces a wrong 400, not a security
  failure. `src/lib/re2/to-js-source.ts` renders the same AST as JavaScript
  RegExp source purely so the matcher can be differentially fuzzed against the
  native engine; nothing in the Worker imports it.
- The matcher is slower than native `RegExp` on the same pattern. For
  form-sized inputs this does not matter; the request already parses its JSON
  body in linear time.
- ADR 0002's execution-safety subset is superseded by this ADR. Its fail-open
  contract, its cached single warning, and its `not` handling are unchanged.
