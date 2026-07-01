# EvidenceEscrow

A two-party escrow where the release condition is written in plain
language instead of code, and disputes are settled by GenLayer
validators reading the evidence rather than by a deterministic check.

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
                                            |
                          confirm_complete()|  submit_evidence()
                                            |         |
                                            v         v
                                       Released    Disputed <--+
                                                       |        |
                                                       +--------+
                                                    submit_evidence()
                                                    (either side, updates
                                                     their own slot)
                                                       |
                                          resolve_dispute()
                                                       |
                                                       v
                                                   Resolved
```

Every transition is access-controlled: only the payer can `fund()` or
`confirm_complete()`; only the payer or payee can `submit_evidence()`
or `resolve_dispute()`; anyone else is rejected before any LLM call
happens.

## How a dispute gets resolved

1. Either party calls `submit_evidence(evidence, evidence_url="")`.
   `evidence` is their free-text account of what happened.
   `evidence_url` is optional: a live preview link, a merged PR, a
   delivery-tracking page, anything checkable.
2. `resolve_dispute()` fetches whichever URLs were provided with
   `gl.nondet.web.render(url, mode="text")`, the same primitive
   GenLayer's own prediction-market example uses, and builds one
   prompt containing the terms, both sides' written claims, and
   whatever was fetched.
3. That whole step (fetch + prompt) runs inside a single closure
   passed to `gl.eq_principle.prompt_comparative`, matching the
   pattern in GenLayer's own web-fetching examples: the fetch and the
   judgment are one non-deterministic unit that validators agree on
   together, not two separate consensus rounds.
4. The model returns `payer_refund_percent` as one of five fixed
   values (0/25/50/75/100) rather than an arbitrary number. This is
   deliberate: independent validators are far more likely to land on
   the same bucket than the same exact percentage, which matters for
   consensus actually finalizing instead of repeatedly disagreeing.
5. Funds split accordingly via `gl.get_contract_at(address).emit_transfer(value=...)`.

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
| `submit_evidence(evidence, evidence_url="")` | payer or payee | Record your side; first call opens the dispute |
| `resolve_dispute()` | payer or payee | Trigger the AI-arbitrated ruling |
| `get_terms/get_status/get_parties/get_balance/get_evidence/get_ruling` | anyone | Read-only state |

## Verified in Studio

Both paths were deployed and run end to end in GenLayer Studio, not
just checked against reference syntax:

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
  cancelled the remaining two validators. Optimistic Democracy and the
  model-diversity argument both worked as described above, not just
  asserted on paper.
- This also confirms the one thing that couldn't be checked from
  reading example code alone: `u256` correctly supports the
  multiplication and floor-division used in the refund-split math.

## Known limitations

- **No evidence window / time lock.** `resolve_dispute()` can be
  called the instant either party submits evidence, even if the other
  side hasn't had a chance to respond yet. A production version would
  probably add a minimum waiting period, but that needs a block-time
  API this build doesn't rely on since it wasn't confirmed against a
  working example.
- **No domain allow-list**, discussed above. An intentional scope
  decision for a generic primitive, not an oversight, but worth
  revisiting for any deployment where the deal has a known, narrow set
  of legitimate evidence sources.

## Running the tests

`test_evidence_escrow.py` is written against GenLayer's `gltest`
framework and follows the same conventions as
`genlayer-simulator/tests/integration/icontracts/tests/`. These are
integration tests, they need a locally running GenLayer Studio/simulator
instance, not just a bare `pip install`.

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

Every syntax pattern here was checked against GenLayer's own
`genlayer-simulator` repository (`examples/contracts/` and
`tests/integration/icontracts/`) rather than written from memory: the
`gl.Contract` base class, the `@gl.public.write/.view/.payable`
decorators, `gl.nondet.exec_prompt`, `gl.nondet.web.render`,
`gl.eq_principle.prompt_comparative`, `gl.get_contract_at(...).emit_transfer(...)`,
and the `gltest` conventions in the test file.
