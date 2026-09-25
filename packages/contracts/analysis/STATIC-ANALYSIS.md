# Static analysis: AdagBills

Scope: `src/AdagBills.sol` and `src/interfaces/*.sol`. Tests, scripts and `lib/` are left out of the findings.
Run on 25 September 2026.

## Result

86 findings across three tools. None is a bug that changes what the contract does.

| Verdict | Count | What it means |
| --- | --- | --- |
| Real bug | 0 | Nothing that moves money wrongly, skips a check or breaks a rule in the threat model. |
| Real, documentation only | 27 | Missing NatSpec on public constants, events and two return values. A comment-only edit to `src/AdagBills.sol` clears all 27. Listed as recommendations below. |
| False positive | 18 | The tool's pattern matched, but the danger it looks for cannot happen here. Reason given per row. |
| Accepted by design | 41 | A true observation about a deliberate choice, tied to the threat model or `DECISIONS.md`. |

By tool: slither 14, solhint 65 (plus 4 from a rule later switched off, see below), arc-forge lint 3.

## How to reproduce

From the repo root on Windows:

```
bash packages/contracts/analysis/run-analysis.sh
```

It re-runs itself inside WSL Ubuntu, builds `src/` with arc-forge into a throwaway folder (never the shared `out/` or `cache/`), then writes `slither-output.txt`, `solhint-output.txt` and `lint-output.txt` in this folder. It exits non-zero if the build fails or any tool crashes. Findings alone do not fail it.

Slither must read arc-forge's build, not upstream forge's. The script builds with `arc-forge build --build-info`, runs slither with `--ignore-compile` against that build, and puts a small `forge` shim on the path that calls arc-forge, because crytic-compile still asks `forge config --json` for the project settings.

## Versions

| Tool | Version | Installed where |
| --- | --- | --- |
| arc-forge (Arc Foundry v0.8.0-2) | forge 1.7.1-dev, commit d497bee | `~/.local/bin` in WSL |
| solc | 0.8.30, optimizer 200 runs, EVM prague | from `foundry.toml` |
| slither-analyzer | 0.11.6 | `~/.venvs/slither`, Python 3.14.4 |
| crytic-compile | 0.4.2 | same virtual environment |
| solhint | 6.2.4 | `~/.npm-global`, Node 24.21.0 LTS in `~/.local/opt/node` |

WSL has no `ensurepip` and no password-free sudo, so the virtual environment was made with `--without-pip` and pip was added with the official `get-pip.py`. Node came from the official nodejs.org tarball, checked against its published SHA-256.

## Configuration

`slither.config.json`: all 102 detectors on, including informational and optimisation. `filter_paths` hides `lib/`, `test/` and `script/`. `fail_on` is `none`, so the exit code only reports crashes.

`.solhint.json`: `solhint:recommended` with one rule switched off.

| Rule off | Why |
| --- | --- |
| `import-path-check` | It only looks for imports inside `node_modules` folders and cannot read Foundry remappings, so every `@openzeppelin/...` import fails it even though the file is there. The first run gave 4 such warnings (lines 4 to 7 of `AdagBills.sol`). The arc-forge build in the same script is the real import check: it stops the run if any import is missing. |

`arc-forge lint` runs with the default settings. Running it with every severity turned on (`--severity high med low info gas code-size`) gives the same 3 findings.

## Slither (14)

| # | Detector | Location | Severity | Meaning | Verdict |
| --- | --- | --- | --- | --- | --- |
| S1 | reentrancy-no-eth | `_applyNewDebtRule`, lines 306 to 319 (write at 311 after the call at 325) | Medium | `_seenShares` is written after the call to Morpho's `accrueInterest`, so a callback could see the old value. | False positive. The call goes to the fixed Morpho address, which calls only the market's own interest-rate model and makes no callback. `pay` holds the reentrancy guard for the whole call. If the check fails the whole call reverts, so the write order cannot matter. |
| S2 | reentrancy-no-eth | `pay`, lines 167 to 193 (writes at 311 and 316 after the calls at 189 and 190) | Medium | Same pattern, seen from `pay`. The bill itself is marked paid at 175, before any external call. | False positive, same reason as S1. The only other reader of `_seenShares` is the `seenShares` view, and nothing on chain acts on it mid-call. |
| S3 | uninitialized-local | `_params`, `expectedLoan`, line 380 | Medium | A local variable is declared without a starting value. | False positive. Every branch either sets it (381, 382) or reverts (383) before it is read. |
| S4 | unused-return | `_applyNewDebtRule`, line 307, `position` | Medium | Some return values are thrown away. | False positive. Only the borrow shares are needed; the other two fields are skipped on purpose. |
| S5 | unused-return | `_checkLoan`, line 324, `market` | Medium | Same. | False positive. Only `lastUpdate` is needed. |
| S6 | unused-return | `_readFeed`, line 355, `latestRoundData` | Medium | Same. | False positive. The answer and `updatedAt` are the whole freshness rule (C11). `answeredInRound` is deprecated by Chainlink, and `updatedAt` covers what it used to. |
| S7 | unused-return | `_debt`, line 362, `position` | Medium | Same. | False positive. Supply shares are not part of the debt. |
| S8 | unused-return | `_debt`, line 365, `market` | Medium | Same. | False positive. Only total borrow assets and shares enter the debt formula (C10). |
| S9 | timestamp | `pay`, lines 185 and 186 | Low | Slither thinks the balance comparison depends on the block time. | False positive. The time only goes into `paidAt` on the same bill; slither's tracking marks the whole bill record, so the amount read back from it looks time-tainted. The C1 check compares two token balances and nothing else. |
| S10 | timestamp | `priceStatus`, line 301 | Low | The returned freshness flag depends on the block time. | Accepted by design. This view reports the same freshness rule `pay` enforces (`DECISIONS.md`, preview views and `priceStatus`). A block producer can move the time by seconds; the windows are 26 and 96 hours. |
| S11 | timestamp | `_checkLoan`, line 325 | Low | The choice to accrue interest depends on the block time. | Accepted by design. It copies Morpho's own shape (`BlueBundlesV1.requireMaxLtv`, verified in `DECISIONS.md`). Morpho's `accrueInterest` does nothing when no time has passed, so either branch gives the same debt figure (C10). |
| S12 | timestamp | `_readFeed`, line 358 | Low | Price freshness depends on the block time. | Accepted by design. This is the 26 hour BTC/USD and 96 hour EUR/USD rule (`DECISIONS.md`, threat model C11). Seconds of drift cannot matter against windows of hours. |
| S13 | naming-convention | `IOracleMinimal.BASE_FEED_1()`, line 10 | Informational | The function name is not mixedCase. | False positive. The name must match Morpho's `MorphoChainlinkOracleV2` getter exactly, because the function selector comes from the name. Renaming would break the call. |
| S14 | naming-convention | `IOracleMinimal.QUOTE_FEED_1()`, line 12 | Informational | Same. | False positive, same reason as S13. |

## arc-forge lint (3)

| # | Lint | Location | Severity | Meaning | Verdict |
| --- | --- | --- | --- | --- | --- |
| L1 | block-timestamp | `AdagBills.sol` 325:13, `_checkLoan` | Warning | The block time is used in a comparison. | Accepted by design, same as S11. |
| L2 | block-timestamp | `AdagBills.sol` 358:36, `_readFeed` | Warning | Same: rejects a feed time that is in the future. | Accepted by design, same as S12. |
| L3 | block-timestamp | `AdagBills.sol` 358:68, `_readFeed` | Warning | Same: the feed's age against the limit. | Accepted by design, same as S12. |

## solhint (65, plus 4 from the switched-off rule)

All are warnings; solhint reported 0 errors.

### src/AdagBills.sol (35)

| # | Rule | Location | Count | Meaning | Verdict |
| --- | --- | --- | --- | --- | --- |
| H1 | use-natspec | contract `AdagBills`, line 19 | 1 | No `@author` tag. | Accepted by design. `@author` is optional NatSpec; the project's bar (NatSpec on every public and external function, backend-build 6d) does not include it, and authorship lives in the repo and README. |
| H2 | use-natspec | public constants `MORPHO`, `USDC`, `EURC`, `CIRBTC`, `MARKET_USDC`, `MARKET_EURC`, `MAX_LTV_WAD`, `BTC_USD_MAX_AGE`, `EUR_USD_MAX_AGE`, `MAX_REFERENCE_BYTES`, `MAX_PAGE`, lines 47 to 63 | 11 | No `@notice` on a public constant. Each one is a public getter in the ABI, and some only carry `@dev`. | Real, documentation only. Recommend a one-line `@notice` on each (for example "Morpho Blue on Arc" for `MORPHO`). |
| H3 | use-natspec | events `BillCreated` 79, `BillVoided` 82, `BillPaid` 83, `DebtRecorded` 91 | 12 | Each event has no `@notice` and no `@param` tags (three warnings per event). | Real, documentation only. The app and any indexer read these events as proof of payment (C16, C17), so each field should say what it holds. Recommend `@notice` plus one `@param` per field. |
| H4 | use-natspec | `loanToValue` 252, `collateralNeeded` 269 | 4 | No `@return` tag for the named return value (two warnings per function). | Real, documentation only. Recommend `@return ltvWad ...` and `@return extraCollateral ...`. |
| H5 | gas-struct-packing | struct `FeedRead`, line 41 | 1 | The struct's fields could be ordered to fill fewer storage slots. | False positive. `FeedRead` only ever lives in memory, where every field takes a full word whatever the order. It is never stored. |
| H6 | gas-indexed-events | `DebtRecorded` fields `borrowShares` and `checked`, line 91 | 2 | These fields could be indexed. | False positive. An event can index at most three fields and two are taken, so both cannot be indexed. Moving a word from data to an index costs about 119 more gas per emit, not less, and nobody searches by an exact share count or a true/false flag. |
| H7 | gas-strict-inequalities | `_readFeed` 358:36 and 358:68, `_params` 388:20, `_page` 399:13 | 4 | A `<=` or `>=` could be made strict to save about 3 gas. | Accepted by design. Each bound is the stated rule: a feed time no later than now and an age "no older than" the limit (C11, `DECISIONS.md` freshness windows); a market whose liquidation line is at or below 40% is refused (fail closed, C11 and C12); an offset at or past the end returns an empty page. Making them strict changes behaviour by one unit to save 3 gas. |

### src/interfaces (30)

| # | Rule | Location | Count | Meaning | Verdict |
| --- | --- | --- | --- | --- | --- |
| H8 | use-natspec | `IOracleMinimal`, lines 6 to 12: no `@title`, no `@author`, no `@notice` on `price`, `BASE_FEED_1`, `QUOTE_FEED_1` | 5 | Missing NatSpec tags. | Accepted by design. These interfaces are minimal copies of Morpho's audited contracts, checked line by line against Morpho's source (`DECISIONS.md`, R&D brief sources). They are never deployed and are not Adag's API. Each already has a file-level `@notice` saying what it mirrors; the full docs are upstream. |
| H9 | use-natspec | `IMorphoMinimal`, lines 14 to 37: no `@title`, no `@author`; no `@notice`, `@param` or `@return` on `idToMarketParams`, `position`, `market`, `accrueInterest` | 20 | Missing NatSpec tags. | Accepted by design, same reason as H8. |
| H10 | use-natspec | `IChainlinkFeed`, lines 5 to 6: no `@title`, no `@author`, no `@notice` or `@return` on `latestRoundData` | 5 | Missing NatSpec tags. | Accepted by design, same reason as H8, mirroring Chainlink's `AggregatorV3Interface`. |

### Switched-off rule, first run only (4)

| # | Rule | Location | Count | Meaning | Verdict |
| --- | --- | --- | --- | --- | --- |
| H11 | import-path-check | `AdagBills.sol` lines 4 to 7 (IERC20, SafeERC20, Math, ReentrancyGuardTransient) | 4 | solhint could not find the imported file. | False positive. The files exist through the `@openzeppelin/contracts/` remapping in `foundry.toml`; arc-forge compiles them. The rule is off, see Configuration. |

## Recommended source edits (not made: `src/` is outside this work order)

1. H2: add a `@notice` line to each of the 11 public constants.
2. H3: add `@notice` and one `@param` per field to the 4 events.
3. H4: add `@return` to `loanToValue` and `collateralNeeded`.

After those edits, re-running the script should show 38 solhint warnings, exactly rows H1 and H5 to H10. Slither and arc-forge lint would not change.

## After WO-2c

Re-run on 25 September 2026 after three source changes to `src/AdagBills.sol`:
1. `createBill` picks the market from the currency first and reads only that market, so a broken USDC market no longer blocks EURC bills.
2. `_applyNewDebtRule` stores the new borrow shares before the 40% check's external calls and emits `DebtRecorded` after the check passes.
3. The NatSpec edits recommended above (H2, H3, H4).

The tables above keep the line numbers of the first run. The output files in this folder now hold the new ones.

| Tool | Before | After |
| --- | --- | --- |
| slither | 14 | 14 |
| solhint | 65 | 38 |
| arc-forge lint | 3 | 3 |
| Total | 82 | 55 |

What changed:
- **Gone:** S1 (the write now comes before the call inside `_applyNewDebtRule`), H2 (11), H3 (12) and H4 (4). The 38 solhint warnings left are exactly rows H1 and H5 to H10.
- **Still there, S2:** `pay`, lines 203 to 229. What remains is across markets: the EURC market's write (lines 349 and 355) follows the USDC market's `accrueInterest` call (line 364) inside the same `pay`. Same verdict as before: false positive. The call goes to the fixed Morpho address, which makes no callback, `pay` holds the reentrancy guard, and a failed check reverts the whole call. Clearing it would mean reading and storing both markets' shares before running either check, which WO-2c did not ask for.
- **New, S15:** uninitialized-local, `createBill`, `marketId`, line 158. False positive, same as S3: each branch either sets it or reverts before it is read.
- **Moved only:** S3 is now at line 419, the slither timestamp rows at 364 and 397, lint L1 to L3 at 364:13, 397:36 and 397:68, and solhint H7 at 397, 427 and 438.

## After the head chef's ordering change (25 September)

`pay` now records both markets' borrow shares before the token transfer, then runs the 40% checks, then emits `DebtRecorded` and `BillPaid` last. Behaviour is unchanged (a failed check still reverts everything), and no storage write follows an external call that can change state. Re-run of `run-analysis.sh`: slither reports 13 results, with no reentrancy finding left (S2 is gone); all three tools exit 0. 48 of 48 tests pass.
