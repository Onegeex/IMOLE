# Security review

**Status: reviewed with automated tools and property tests, not audited.** Don't route large amounts through Imole until it has a professional audit.

Reviewed: `contracts/src/ImolePAYG.sol` and `contracts/src/ImoleKYC.sol`, exactly as deployed and verified on QIE Mainnet (`0xae6501e9…d8AD`, `0x98CcF6f3…54D1`). The deployed source is not edited after the fact, so findings below are either acknowledged or scheduled for a v2.

## Tests

| Kind | What | Result |
|---|---|---|
| Unit tests | 26 scenarios: listing, KYC gating, power on/off, grace, payoff, refunds, repossession timing, relisting, oracle guards, fee cap | Pass |
| Fuzz test | Random payment sequences never exceed the price and never leave QUSDC in the contract | Pass (256 runs) |
| Invariant tests | 4 invariants under random sequences of QUSDC payments, QIE payments, time jumps and repossession attempts across three plans | Pass (256 runs × 60 calls, 61,440 calls, 0 reverts) |

Invariants (`contracts/test/Invariants.t.sol`):

1. **The contract never holds money.** Every payment goes straight to the installer and the treasury.
2. **Nobody pays more than the price.**
3. **A paid-up customer is always powered**, and a paid-off kit is always powered and owned by the customer.
4. **Accounting adds up.** Total volume equals deposits plus every accepted payment, and installer plus treasury balances equal total volume, split 99/1.

The handler also asserts on every call that **repossession succeeds if and only if the customer is past the overdue line.**

Run them: `cd contracts && forge test`.

## Static analysis (Slither 0.11.6, 76 detectors)

No high-severity findings. Medium and low findings, triaged:

| Finding | Where | Assessment |
|---|---|---|
| Reentrancy (balance read before external call) | `payWithQIE` → `router.swapExactETHForTokens` | **Acknowledged, mitigated.** `payWithQIE` is `nonReentrant`, the router address is immutable, and the QUSDC received is measured as a balance difference and then checked against the oracle floor. A malicious router could only return less QUSDC, which reverts with `SwapBelowOracle`. |
| Reentrancy (state written after token transfers) | `_credit` | **Acknowledged, low.** Every entry point that reaches `_credit` (`acceptPlan`, `pay`, `payWithQIE`) is `nonReentrant`. The token is QUSDC, a standard ERC-20 with no transfer hooks, fixed at deploy. **v2:** move the state updates above the transfers (checks-effects-interactions) so safety doesn't depend on the token. |
| Divide before multiply | `_oracleFloor` | **Acknowledged, negligible.** The floor can round down by less than 1 base unit of QUSDC (0.000001). |
| Unused return values | router swap, `latestRoundData` | **Intended.** The swap result is measured by balance difference; only `answer` and `updatedAt` are needed from the feed. |
| Missing zero-address check | constructor `treasury_` | **Low.** Set once by the owner at deploy (deployed with a non-zero treasury) and changeable with `setTreasury`. **v2:** add the check. |
| Strict equality on enum / timestamp comparisons | `_openPlan`, `ImoleKYC.isVerified` | **False positives.** Enum status checks, not balance or time equality. |

## Trust assumptions

- **Owner** (deployer key): can change the fee (capped at 5% in code), treasury, oracle guard settings and verified-installer badges, and can add or remove KYC attesters. The owner **cannot** move anyone's funds, change a plan's terms, or switch off a paid-up kit.
- **KYC attesters**: can mark customers as verified. No funds involved.
- **Code service** (`/api/code`): holds the master key that derives each kit's device key. It only issues codes for time the chain says is paid, and it can't move money. Compromise would let someone forge unlock codes for kits, which is a loss for installers, not for customers.
- **External contracts:** QUSDC (trusted token), QIEDEX router (source not verified on the explorer, so its output is checked against the oracle), and the QIE/USD oracle (only used for QIE payments; QUSDC payments never touch it).

## Reporting

Open a GitHub issue marked `security`, or contact the maintainer privately through the repository owner's profile.

## Controller and off-chain services

- **Tamper lid.** Opening the case locks the kit until a reset code made from the kit's device key with the current tamper count, so each reset code works once. Reset codes use a reserved time value (2^23 - 2) that the public code service never issues. Shared test vector: `web/scripts/test-codes.mts` and the firmware's boot self-test.
- **Keypad brute force.** 16-bit MACs with five tries per ten minutes: on average about 45 days of continuous guessing per valid code, for one kit only. Production kits can widen the code or slow the lockout further.
- **Mobile-money webhook (`web/api/momo.ts`).** Requests must carry a valid HMAC-SHA512 signature from the payment partner. Without a float-wallet key it only reports what it would pay. Processed references are kept in memory, so production needs a persistent store before the float wallet is funded. Tested end to end on a local chain (`web/scripts/test-momo.mts`).
