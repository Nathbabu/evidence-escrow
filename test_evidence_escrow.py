"""
Tests for EvidenceEscrow, written against GenLayer's gltest framework.

Run inside a working genlayer-simulator dev environment (these are
integration tests that talk to a locally running Studio instance, the
same way GenLayer's own tests/integration/icontracts/tests/*.py do):

    TEST_WITH_MOCK_LLMS=true pytest test_evidence_escrow.py -v

With TEST_WITH_MOCK_LLMS=true, setup_validators(mock_response) spins up
validators that return canned answers instead of calling a real LLM, so
these tests are deterministic and need no API key. Without that env var,
setup_validators() falls back to real providers (see conftest.py in
genlayer-simulator's tests/integration/icontracts/ for the provider
env vars, e.g. TEST_PROVIDER / TEST_PROVIDER_MODEL).

Mock matching works by substring: gltest checks whether a key from
mock_response["response"] appears anywhere in the actual prompt text
sent to gl.nondet.exec_prompt, and returns the matching canned JSON.
Since EvidenceEscrow only ever sends one distinct prompt shape (the
arbitration prompt), one distinctive key per test is enough.

Not covered here: the 24-hour response-window timeout path (resolving
with only one side's evidence after the window has elapsed). These
tests prove that path is correctly blocked before the window passes;
proving it correctly opens up afterward would need either waiting out
a real 24 hours or a way to feed resolve_dispute() a mocked
transaction datetime, which wasn't confirmed working outside gltest's
.analyze() method.

CONTRACT_PATH below assumes evidence_escrow.py sits next to this file.
Adjust it if you place the contract elsewhere in your checkout (e.g.
"tests/integration/icontracts/contracts/evidence_escrow.py" if you
follow genlayer-simulator's own layout).
"""

import json

from gltest import get_contract_factory, create_account
from gltest.assertions import tx_execution_succeeded
from gltest.types import TransactionStatus
from eth_account import Account

from tests.common.request import payload, post_request_localhost
from tests.common.response import has_success_status

CONTRACT_PATH = "evidence_escrow.py"
TERMS = "Landing page mockup delivered and live at the agreed preview link by Friday."
PROMPT_MATCH_KEY = "impartial arbitrator settling an escrow dispute"


def _get_eoa_balance(address: str) -> int:
    result = post_request_localhost(payload("eth_getBalance", address)).json()
    assert has_success_status(result)
    raw = result["result"]
    return int(raw, 16) if isinstance(raw, str) else raw


def _deploy(payee_address: str, terms: str = TERMS):
    factory = get_contract_factory(contract_file_path=CONTRACT_PATH)
    return factory.deploy(args=[payee_address, terms])


def _mock_ruling(reasoning: str, payer_refund_percent: int) -> dict:
    return {
        "response": {
            PROMPT_MATCH_KEY: json.dumps(
                {"reasoning": reasoning, "payer_refund_percent": payer_refund_percent}
            )
        },
        "eq_principle_prompt_comparative": {reasoning: True},
    }


def test_fund_and_confirm_complete(setup_validators, default_account):
    """Happy path: payer funds, confirms, payee is paid. No LLM involved."""
    setup_validators()
    payee = Account.create()  # fresh EOA, receives only, safe to assert exact balance
    contract = _deploy(payee.address)

    fund_tx = contract.fund(args=[]).transact(
        value=1000, wait_transaction_status=TransactionStatus.FINALIZED
    )
    assert tx_execution_succeeded(fund_tx)
    assert contract.get_status(args=[]).call() == "Funded"

    confirm_tx = contract.confirm_complete(args=[]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED,
        wait_triggered_transactions=True,
        wait_triggered_transactions_status=TransactionStatus.ACCEPTED,
    )
    assert tx_execution_succeeded(confirm_tx)
    assert contract.get_status(args=[]).call() == "Released"
    assert contract.get_balance(args=[]).call() == 0
    assert _get_eoa_balance(payee.address) == 1000


def test_only_payer_can_fund(setup_validators, default_account):
    setup_validators()
    payee = Account.create()
    stranger = create_account()
    contract = _deploy(payee.address)

    tx = (
        contract.connect(stranger)
        .fund(args=[])
        .transact(value=1000, wait_transaction_status=TransactionStatus.FINALIZED)
    )
    assert not tx_execution_succeeded(tx)


def test_cannot_fund_twice(setup_validators, default_account):
    setup_validators()
    payee = Account.create()
    contract = _deploy(payee.address)

    tx1 = contract.fund(args=[]).transact(
        value=1000, wait_transaction_status=TransactionStatus.FINALIZED
    )
    assert tx_execution_succeeded(tx1)

    tx2 = contract.fund(args=[]).transact(
        value=500, wait_transaction_status=TransactionStatus.FINALIZED
    )
    assert not tx_execution_succeeded(tx2)


def test_cannot_resolve_before_disputed(setup_validators, default_account):
    setup_validators()
    payee = Account.create()
    contract = _deploy(payee.address)

    contract.fund(args=[]).transact(
        value=1000, wait_transaction_status=TransactionStatus.FINALIZED
    )
    tx = contract.resolve_dispute(args=[]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED
    )
    assert not tx_execution_succeeded(tx)


def test_only_parties_can_submit_evidence(setup_validators, default_account):
    setup_validators()
    payee = Account.create()
    stranger = create_account()
    contract = _deploy(payee.address)

    contract.fund(args=[]).transact(
        value=1000, wait_transaction_status=TransactionStatus.FINALIZED
    )
    tx = (
        contract.connect(stranger)
        .submit_evidence(args=["not my dispute", ""])
        .transact(wait_transaction_status=TransactionStatus.FINALIZED)
    )
    assert not tx_execution_succeeded(tx)


def test_cannot_resolve_with_only_one_side_before_window(setup_validators, default_account):
    """The fix for the reviewer-reported issue: one side responding
    isn't enough to force a ruling before the 24-hour window passes."""
    setup_validators()
    payee = Account.create()
    contract = _deploy(payee.address)

    contract.fund(args=[]).transact(
        value=1000, wait_transaction_status=TransactionStatus.FINALIZED
    )
    contract.submit_evidence(args=["I don't think this was delivered.", ""]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED
    )
    assert contract.get_status(args=[]).call() == "Disputed"

    tx = contract.resolve_dispute(args=[]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED
    )
    assert not tx_execution_succeeded(tx)
    # still disputed, nothing was resolved out from under the silent party
    assert contract.get_status(args=[]).call() == "Disputed"


def test_evidence_submission_from_both_parties(setup_validators, default_account):
    """Pure state check: both sides' evidence lands in the right slot,
    and the first submission flips status from Funded to Disputed."""
    setup_validators()
    payee = create_account()  # needs to send its own tx here, so not a bare EOA
    contract = _deploy(payee.address)

    contract.fund(args=[]).transact(
        value=1000, wait_transaction_status=TransactionStatus.FINALIZED
    )

    tx1 = contract.submit_evidence(args=["Delivered on time.", ""]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED
    )
    assert tx_execution_succeeded(tx1)
    assert contract.get_status(args=[]).call() == "Disputed"

    tx2 = (
        contract.connect(payee)
        .submit_evidence(args=["Here is my side.", "https://example.com/proof"])
        .transact(wait_transaction_status=TransactionStatus.FINALIZED)
    )
    assert tx_execution_succeeded(tx2)

    evidence = contract.get_evidence(args=[]).call()
    assert evidence["payer_evidence"] == "Delivered on time."
    assert evidence["payee_evidence"] == "Here is my side."
    assert evidence["payee_evidence_url"] == "https://example.com/proof"


def test_dispute_full_release_to_payee(setup_validators, default_account):
    """Mocked ruling says the terms were met: payee gets everything.
    Both sides respond here so resolve_dispute clears the new
    both-responded gate without needing to wait out the time window.
    Payee has to send its own tx to respond, so its balance check is a
    before/after delta rather than an exact amount, to stay honest
    about gas it may have spent on that submission."""
    payee = create_account()
    payee_balance_before = _get_eoa_balance(payee.address)
    reasoning = "The delivered page matches the brief and was live on time."
    setup_validators(_mock_ruling(reasoning, payer_refund_percent=0))

    contract = _deploy(payee.address)
    contract.fund(args=[]).transact(
        value=1000, wait_transaction_status=TransactionStatus.FINALIZED
    )
    contract.submit_evidence(
        args=["I don't think this was delivered.", ""]
    ).transact(wait_transaction_status=TransactionStatus.FINALIZED)
    contract.connect(payee).submit_evidence(
        args=["It's live, here's the link.", "https://example.com/proof"]
    ).transact(wait_transaction_status=TransactionStatus.FINALIZED)

    resolve_tx = contract.resolve_dispute(args=[]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED,
        wait_triggered_transactions=True,
        wait_triggered_transactions_status=TransactionStatus.ACCEPTED,
    )
    assert tx_execution_succeeded(resolve_tx)

    assert contract.get_status(args=[]).call() == "Resolved"
    ruling = contract.get_ruling(args=[]).call()
    assert ruling["payer_refund_percent"] == 0
    assert contract.get_balance(args=[]).call() == 0
    assert _get_eoa_balance(payee.address) > payee_balance_before


def test_dispute_partial_refund(setup_validators, default_account):
    """Mocked ruling says the work was half-done: 50/50 split. Both
    sides respond, same reasoning as the test above."""
    payee = create_account()
    payee_balance_before = _get_eoa_balance(payee.address)
    reasoning = "Only half the agreed scope was delivered by the deadline."
    setup_validators(_mock_ruling(reasoning, payer_refund_percent=50))

    contract = _deploy(payee.address)
    contract.fund(args=[]).transact(
        value=1000, wait_transaction_status=TransactionStatus.FINALIZED
    )
    contract.submit_evidence(
        args=["Only the homepage was delivered, not the full site.", ""]
    ).transact(wait_transaction_status=TransactionStatus.FINALIZED)
    contract.connect(payee).submit_evidence(
        args=["Ran out of time, but the homepage was finished.", ""]
    ).transact(wait_transaction_status=TransactionStatus.FINALIZED)

    resolve_tx = contract.resolve_dispute(args=[]).transact(
        wait_transaction_status=TransactionStatus.FINALIZED,
        wait_triggered_transactions=True,
        wait_triggered_transactions_status=TransactionStatus.ACCEPTED,
    )
    assert tx_execution_succeeded(resolve_tx)

    ruling = contract.get_ruling(args=[]).call()
    assert ruling["payer_refund_percent"] == 50
    assert contract.get_balance(args=[]).call() == 0
    assert _get_eoa_balance(payee.address) > payee_balance_before
