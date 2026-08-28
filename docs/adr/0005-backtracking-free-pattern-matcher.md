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
reason.

This budget is ranges multiplied by repetitions, so it is not out of reach of
patterns an operator would plausibly onboard. `\w` contributes 4 ranges, `\s` 3
and `\d` 1, so `\w{1000}` sits exactly on the budget and `\w{1000}\w` is
refused. More to the point, a class of about 8 ranges caps counted repetition
around 500: `^[a-zA-Z0-9 .,'-]{1,500}$` compiles, `^[a-zA-Z0-9 .,'-]{1,501}$`
is refused, and `^[\w\s.,;:!?'"()-]{1,300}$` is refused. "Allowed characters,
up to N of them" is an ordinary Google Forms validation, so this is a real
constraint on the subset rather than a theoretical one. The escape hatch is the
same one every other refusal has: `--allow-unevaluable-patterns` onboards the
form with that field checked only by Google. `SAFE_SUBSET_HINT` states the
arithmetic, not just the existence of a budget, so whoever hits it can see how
to get under it.

n is bounded at the matcher's call site, and bounded per request rather than
per value. A schema's `maxLength` already bounds a single value where one
exists: like `maxItems`, it is terminal for its property, so an oversized
string never reaches the pattern check. But bounding each value would not bound
the request, because one body carries many pattern checks — `schema.ts` can put
two `{pattern}` members in one field's `allOf` and a `{not: {pattern}}` on top,
and a form has as many text fields as its author wrote. Ten near-cap values
cost ten times one.

So `validate()` spends a single budget of 10,000 code points of pattern
matching, shared by every pattern check the call makes — code points, not
UTF-16 units, matching how the matcher measures its input. Before each check,
a value larger than what is left of the budget has that check skipped; a value
that fits is charged and run. A single 15,000-code-point value therefore skips,
and so does the second of two 6,000-code-point values. The budget is threaded
down the recursion rather than held in a module-level counter: module state
would persist across requests in a Worker isolate, so one large body would
starve every later request the isolate served. It logs once per pattern rather
than once per request, so an attacker cannot flood the log with oversized
bodies.

The budget lives in the validator, not in `match.ts`: `Matcher.test` returns a
boolean and must not acquire a third "don't know" state. Skipping is the trade
the module already makes for unsupported syntax — local validation is a UX
affordance and Google remains the authority (ADR 0002) — and it extends to
`not` for the same reason an uncompilable pattern does: skipping the forward
check while letting the `not` branch run would invert an unevaluable constraint
into rejecting a valid submission. The `not` branch asks whether a check is
evaluable without charging the budget, because the recursive call it then makes
is what charges; charging twice would reintroduce exactly that inversion.

The worst case is therefore a bounded product, and it was measured rather than
estimated. The measurement matters because an earlier draft of this ADR quoted
a figure roughly seven times too low: its probe pattern matched, so the
simulation returned at the first `match` instruction, about 40% of the way
through the input, and never carried a saturated thread set.

Measured on a developer laptop (Node 22, darwin/arm64), over a non-matching
input of 10,000 `a`s, the worst pattern found was
`(?:[^bd]|[^ce]){999}b` — 3998 instructions and 3997 ranges — at about 750 ms
warm, and up to about 1.1 s across runs. Because the budget is per request,
that is also the worst case for a whole request: ten such fields each holding a
10,000-code-point value cost the same 750 ms, since the budget is spent once.
Under the earlier per-value cap the same body cost 7.5 s.

The shape of the worst case corrects the causal story too. `m` dominates: every
top candidate saturates the instruction budget, and the alternation shapes are
slower than the range-saturated ones because thread count and epsilon-closure
structure — both governed by `MAX_PROGRAM_SIZE` — cost more than range
scanning. `(?:[^b]|[^c]){999}b` uses only 1999 of the 4000 ranges and still
runs at about 900 ms, while `\w{1000}` saturates R exactly and takes 18 ms. The
range budget is worth having: it closes the case of 4000 instructions each
scanning thousands of ranges, which `MAX_PROGRAM_SIZE` alone does not bound.
But it is not the binding factor in the worst case, and this ADR should not be
read as saying the worst case saturates it.

Roughly a second of CPU for one request is a real cost and is worth watching.
It is a bound: it holds for every pattern the parser accepts, and no request
can exceed it however many fields or constraints it carries.

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
  factors are capped — n at 10,000 code points per request by the validator's
  budget, m at 4000 by the program budget, R at 4000 total ranges by the range
  budget. The measured worst case is roughly 750 ms of CPU for a whole request,
  so "bounded by construction" is literally true rather than a statement about
  shape.
- The follow-ups keep their scope, with the reasoning sharpened. #29, a request
  body size limit, remains defence in depth: the matcher's total work per
  request is now bounded without it, but the request's other linear scans —
  `JSON.parse`, `uniqueItems` hashing, the per-property walk — are still
  proportional to body size, and a ~400 KB body still buys the attacker the
  full matching budget plus those scans. Bounding the matcher is not a reason
  to accept an unbounded body. #30, sorting the ranges at parse time and
  binary-searching them, is a performance optimisation that turns R into log R
  inside an already bounded budget rather than a safety fix — and the
  measurements above say it would not move the worst case much, because R is
  not the term that dominates it.
- The price of bounding n is one more fail-open case, and it is now
  request-shaped. A value that does not fit the request's remaining budget has
  its pattern check skipped, so a body large enough — one oversized value, or
  several ordinary ones — accepts those fields locally and leaves them for
  Google to reject. That is the same trade ADR 0002 makes for unsupported
  syntax, and it is preferable to spending CPU proportional to an
  attacker-chosen body. It applies to `not` identically, so an unevaluable
  constraint is never inverted into a rejection.
- The subset a form author must respect is explainable in one sentence:
  standard regex syntax, minus the constructs the Decision above lists — chiefly
  Unicode property classes, inline flags, POSIX classes, lookarounds, named
  groups, negated class escapes inside a character class, and a handful of RE2
  escapes — with counted repetition capped at RE2's own maximum of 1000 and,
  beyond that, by the program budget, the compiler's work counter and the
  class-range budget, whose arithmetic — ranges times repetitions — caps an
  eight-range class around 500 repetitions.
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
