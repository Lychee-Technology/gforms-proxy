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
in O(n·m) with no backtracking.

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

Matching is linear in the input, which the schema's `maxLength` now bounds:
like `maxItems`, it is terminal for its property, so an oversized string never
reaches the pattern check. A request body size limit would bound the remaining
case where a schema carries no `maxLength`; it is tracked separately (#29).

`gen-field-mapping --allow-unevaluable-patterns` turns the generator's failure
into a warning and records `unevaluablePatternsAllowed: true` in the definition,
which does the same for `validate:forms`. Some RE2 syntax will remain
unsupported however wide the matcher grows, and a UX-layer limitation should
never make a form permanently un-onboardable.

## Consequences

- Pattern matching is linear in input length for every accepted pattern, with
  no shape-dependent cliff. Exposure to a mis-authored regex is bounded by
  construction rather than by a syntactic guess.
- The subset a form author must respect is explainable in one sentence:
  standard regex syntax, minus the constructs the Decision above lists — chiefly
  Unicode property classes, inline flags, POSIX classes, lookarounds, named
  groups, negated class escapes inside a character class, and a handful of RE2
  escapes — with counted repetition capped at RE2's own maximum of 1000 and,
  beyond that, by the program budget. `SAFE_SUBSET_HINT` in `pattern-policy.ts`
  puts this summary, not the Decision's fuller enumeration, in front of whoever
  runs the generator; both are maintained by hand against the parser.
- We own a regex matcher. A bug in it produces a wrong 400, not a security
  failure. `src/lib/re2/to-js-source.ts` renders the same AST as JavaScript
  RegExp source purely so the matcher can be differentially fuzzed against the
  native engine; nothing in the Worker imports it.
- The matcher is slower than native `RegExp` on the same pattern. For
  form-sized inputs this does not matter; the request already parses its JSON
  body in linear time.
- ADR 0002's execution-safety subset is superseded by this ADR. Its fail-open
  contract, its cached single warning, and its `not` handling are unchanged.
