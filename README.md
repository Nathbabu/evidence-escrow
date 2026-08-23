# EvidenceEscrow

A two-party escrow where the release condition is written in plain
language instead of code, and disputes are settled by GenLayer
validators reading the evidence rather than by a deterministic check.

**Revision note:** this went through three rounds of review.

Round 1: a reviewer flagged that the original version let either
party trigger a final ruling the instant they submitted evidence,
with no guarantee the other side had a chance to respond. The fix
added a 24-hour response-window fallback using
`gl.message.raw["datetime"]`, which looked correct against GenLayer's
official SDK docs but turned out to be a newer API than the runtime
this contract is actually pinned to (`v0.2.16`); it failed on every
validator with `AttributeError: 'MessageType' object has no attribute
'raw'` the moment it was actually deployed. That got walked back to a
simpler fix: `resolve_dispute()` requiring both sides to have
responded, full stop, no clock involved.

Round 2: a reviewer pointed out the obvious tradeoff in that
simplification, a silent counterparty could now lock the funds up
forever. This time, instead of trusting documentation again, the
actual runtime got interrogated directly with a throwaway probe
contract that ran `dir()` across the relevant `gl` namespaces. That
turned up `gl.message_raw`, a separate top-level name, not the
`gl.message.raw` attribute path that failed before, and confirmed it
returns a working ISO 8601 `datetime` string. `resolve_dispute()` now
requires either both sides to have responded, or a 24-hour response
window to have passed, using that confirmed-working access path.

See "How a dispute gets resolved" and "Verified in Studio" below for
the details of both attempts.

**Later addition:** `cancel_deal()` was added after the contract had
already been reviewed and accepted, as part of building the frontend
around it. Real usage surfaced a real gap the original review didn't
need to cover: no way to back out of a deal created by mistake, or one
both sides agreed to settle outside the contract. Added with the same
one rule that keeps it safe: it stops working the moment the payee has
submitted evidence, so it can never be used to make a live claim
disappear.

**Second later addition:** every payout in this contract originally
sent value through `gl.get_contract_at(addr).emit_transfer(...)`. It's
documented as correct, and it passed every test, but on Bradbury the
actual balance move could sit unconfirmed for hours after the
transaction itself showed finalized. Confirmed this directly twice,
watching two separate refunds sit stuck against a real wallet, not
assumed from a single odd result. Switched to sending value through a
declared evm interface instead, which has been reliable in testing
since. All four transfer sites, `confirm_complete`, both sides of
`resolve_dispute`, and `cancel_deal`, now use the same updated pattern.

## Why this needs to be an Intelligent Contract

A normal EVM contract can only evaluate things it can compute
deterministically: balances, timestamps, signatures. It has no way to
read "the homepage doesn't match the brief, here's why" and decide if
that's true. That takes language understanding. `resolve_dispute()`
calls an LLM mid-execution specifically for that judgment, and the
funds move according to what it decides. Take the LLM call out and
there's no contract left. The AI step is the actual mechanism deciding
who gets paid, not a feature bolted onto otherwise-deterministic logic.

Trusting a single model's opinion on something this consequential
isn't good enough on its own, which is the actual problem GenLayer's
consensus solves. `resolve_dispute()` wraps its ruling in
`gl.eq_principle.prompt_comparative`, so a Lead Validator's proposed
split only finalizes if Co-Validators, often running different
underlying LLMs, independently land on the same number. The
`principle` argument tells validators which field has to match exactly
(`payer_refund_percent`) and which is allowed to vary in wording
(`reasoning`), since no two models explain a decision in identical
prose even when they agree on the outcome.

## State machine

```
AwaitingFunding --fund()--------------> Funded
       |                                    |
       | cancel_deal()      confirm_complete()|  submit_evidence()
       |                                    |         |
       v                                    v         v
   Cancelled <---------------------    Released    Disputed <--+
       ^                    |                          |        |
       |  cancel_deal()     |                          +--------+
       |  (only while       |                       submit_evidence()
       |   payee hasn't     |                       (either side, updates
       |   submitted yet)   |                        their own slot)
       +--------------------+                          |
                                       resolve_dispute(): only once both
                                       sides have responded, or the 24-hour
                                       response window has passed
                                                          |
                                                          v
                                                      Resolved
```

Every transition is access-controlled: only the payer can `fund()`,
`confirm_complete()`, or `cancel_deal()`; only the payer or payee can
`submit_evidence()` or `resolve_dispute()`; anyone else is rejected
before any LLM call happens. `cancel_deal()` has one extra rule beyond
sender-checking: it stops being available the moment the payee has
submitted their own evidence, since at that point the payee has a real
claim in play and a unilateral payer exit would defeat the whole point
of having a dispute path at all.

## How a dispute gets resolved

1. Either party calls `submit_evidence(evidence, evidence_url="")`.
   `evidence` is their free-text account of what happened.
   `evidence_url` is optional: a live preview link, a merged PR, a
   delivery-tracking page, anything checkable. The first submission
   also records the current time as when the dispute opened.
2. `resolve_dispute()` first checks that either both sides have
   submitted evidence, or that 24 hours have passed since the dispute
   opened. This is the guardrail against one party settling the case
   before the other has had a real chance to answer, while still
   giving the case a way to close if someone never responds at all.
3. Once that gate clears, `resolve_dispute()` fetches whichever URLs
   were provided with `gl.nondet.web.render(url, mode="text")`, the
   same primitive GenLayer's own prediction-market example uses, and
   builds one prompt containing the terms, both sides' written claims,
   and whatever was fetched.
4. That whole step (fetch + prompt) runs inside a single closure
   passed to `gl.eq_principle.prompt_comparative`, matching the
   pattern in GenLayer's own web-fetching examples: the fetch and the
   judgment are one non-deterministic unit that validators agree on
   together, not two separate consensus rounds.
5. The model returns `payer_refund_percent` as one of five fixed
   values (0/25/50/75/100) rather than an arbitrary number. This is
   deliberate: independent validators are far more likely to land on
   the same bucket than the same exact percentage, which matters for
   consensus actually finalizing instead of repeatedly disagreeing.
6. Funds split accordingly via `gl.get_contract_at(address).emit_transfer(value=...)`.

**Why one prompt instead of a per-source-then-aggregate pipeline**
(the pattern GenLayer's `IntelligentOracle` contract uses for
prediction markets): this is adversarial two-party arbitration, not
multi-source reconciliation. A prediction market benefits from judging
each independent source separately before reconciling contradictions.
An escrow arbitrator needs to weigh both sides' arguments *against
each other* in one pass. Judging each side in isolation first would
throw away the comparison that makes a ruling fair.

**Fetched content is treated as evidence, not instructions.** Since
either party can submit a URL the contract will fetch and feed to the
model, the prompt explicitly tells validators to ignore any text on a
fetched page that addresses them directly or claims authority over the
ruling, since otherwise a party could host a page containing a prompt
injection aimed at the arbitrator. This contract doesn't restrict
evidence to a domain allow-list the way a prediction-market oracle
reasonably can (there's no fixed set of legitimate domains for an
arbitrary freelance or P2P deal), so the defense here is at the prompt
level rather than a structural allow-list.

## Public interface

| Method | Caller | Purpose |
|---|---|---|
| `__init__(payee, terms)` | deployer (becomes payer) | Set up the deal |
| `fund()` — payable | payer | Deposit the escrowed amount, once |
| `confirm_complete()` | payer | Release full balance, no dispute |
| `cancel_deal()` | payer | Call off the deal, full refund if funded; blocked once payee has submitted evidence |
| `submit_evidence(evidence, evidence_url="")` | payer or payee | Record your side; first call opens the dispute and starts the response window |
| `resolve_dispute()` | payer or payee | Trigger the AI-arbitrated ruling, once both sides responded or the window passed |
| `get_terms/get_status/get_dispute_opened_at/get_parties/get_balance/get_evidence/get_ruling` | anyone | Read-only state |

## Verified in Studio

Both the happy path and the original dispute path were actually
deployed and run end to end in GenLayer Studio, real execution
backing these claims rather than a syntax check alone. This section predates the current response-window logic, so
it confirms the mechanics that logic doesn't touch: funding, the
transfer logic, the web fetch, and the consensus math. The
`gl.message_raw["datetime"]` access itself is separately confirmed
below, via direct probe, but the full both-or-timeout gate hasn't had
its own end-to-end redeploy yet; that's the next step, not something
already checked off.

- **Happy path**: deploy → `fund(100 GEN)` → `confirm_complete()` →
  `get_status()` returned `"Released"`, `get_balance()` returned `0`.
- **Dispute path**: deploy → `fund()` → `submit_evidence()` with a
  real URL (exercising the `gl.nondet.web.render` fetch for real) →
  `resolve_dispute()`. The ruling came back as `payer_refund_percent:
  100` with detailed reasoning that correctly noted the fetched page
  didn't actually support delivery and the payee submitted no
  counter-evidence. The model weighed the fetched content instead of
  just trusting that a link existed. `get_balance()` afterward was
  `0`, matching a full refund. Three of five validators, running three
  different underlying providers (OpenAI, MiniMax, Anthropic),
  independently agreed before quorum, at which point the protocol
  cancelled the remaining two validators. That's Optimistic Democracy
  and the model-diversity argument actually holding up under a real
  run, rather than staying a claim on paper.
- This also confirms the one thing that couldn't be checked from
  reading example code alone: `u256` correctly supports the
  multiplication and floor-division used in the refund-split math.
- Separately, the first fix attempt (the 24-hour window using
  `gl.message.raw["datetime"]`) was deployed and it failed cleanly:
  every validator agreed on the same `AttributeError`, confirming that
  attribute doesn't exist on this runtime rather than something
  flakier.
- Before writing the second attempt, a throwaway probe contract (not
  part of this submission) was deployed and called to run `dir()`
  across `gl`, `gl.message`, `gl.vm`, and related namespaces directly.
  That's what surfaced `gl.message_raw` as a working, separate name,
  and confirmed by direct call that `gl.message_raw["datetime"]`
  returns a real ISO 8601 string (`2026-07-24T20:50:14.809500Z` in
  the actual test call) on this exact runtime, real output rather
  than documentation written for a different one. The current
  response-window logic is built on that confirmed result.

## Known limitations

- **The response window's timeout path is untested against a real
  clock.** `resolve_dispute()` is confirmed to correctly block when
  only one side has responded and no time has passed (that's covered
  by an automated test), and `gl.message_raw["datetime"]` is confirmed
  to return a real value (via direct probe). What isn't yet confirmed
  end to end is the combination: that resolution actually proceeds on
  one-sided evidence once the full 24 hours have genuinely elapsed.
  That needs either waiting out a real 24 hours in Studio or a way to
  feed the test suite a mocked transaction datetime, neither of which
  was done as part of this pass.
- **No domain allow-list**, discussed above. An intentional scope
  decision for a generic primitive, not an oversight, but worth
  revisiting for any deployment where the deal has a known, narrow set
  of legitimate evidence sources.

## Running the tests

`test_evidence_escrow.py` is written against GenLayer's `gltest`
framework and follows the same conventions as
`genlayer-simulator/tests/integration/icontracts/tests/`. These are
integration tests that need a locally running GenLayer Studio/simulator
instance behind them; a bare `pip install` alone won't run them.

```bash
# from inside a genlayer-simulator checkout, with the local stack running
TEST_WITH_MOCK_LLMS=true pytest test_evidence_escrow.py -v
```

`TEST_WITH_MOCK_LLMS=true` makes `setup_validators(mock_response)` spin
up validators that return canned JSON instead of calling a real
provider, so the dispute-resolution tests are deterministic and need
no API key. Without it, tests fall back to a real provider (default
OpenAI/`gpt-4o`, overridable via `TEST_PROVIDER` / `TEST_PROVIDER_MODEL`
env vars, see `conftest.py` in that directory).

`CONTRACT_PATH` at the top of the test file assumes `evidence_escrow.py`
sits next to it; adjust if you place it elsewhere in your checkout.

## Provenance

Every syntax pattern actually used in the final contract was checked
against GenLayer's own `genlayer-simulator` repository
(`examples/contracts/` and `tests/integration/icontracts/`) rather
than written from memory: the `gl.Contract` base class, the
`@gl.public.write/.view/.payable` decorators, `gl.nondet.exec_prompt`,
`gl.nondet.web.render`, `gl.eq_principle.prompt_comparative`,
`gl.get_contract_at(...).emit_transfer(...)`, and the `gltest`
conventions in the test file.

One exception, and the lesson from it: `gl.message.raw["datetime"]`
was checked against GenLayer's official SDK API reference
(sdk.genlayer.com) and looked solid, but that reference documents the
current development branch, not the specific pinned runtime
(`v0.2.16`) this contract actually depends on, and the two don't fully
match. It failed the moment it was deployed for real. Matching a claim
against official docs isn't the same as matching it against the exact
version in the `Depends` header.

The correction came from empirical testing rather than better
documentation: a throwaway probe contract called `dir()` directly
against the live runtime's `gl`, `gl.message`, and `gl.vm` namespaces
and reported back the real results. That's what surfaced
`gl.message_raw` (a separate top-level name, not an attribute of
`gl.message`) and confirmed `gl.message_raw["datetime"]` actually
returns a usable value on this exact runtime. That confirmed result,
not a second reading of the docs, is what the current timeout logic
is built on.
