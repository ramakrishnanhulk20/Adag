// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IMorphoMinimal, MarketParams} from "./interfaces/IMorphoMinimal.sol";
import {IMorphoRepay} from "./interfaces/IMorphoRepay.sol";
import {IIrmMinimal, Market} from "./interfaces/IIrmMinimal.sol";
import {IOracleMinimal} from "./interfaces/IOracleMinimal.sol";

// Pays down part of a borrower's own Morpho loan from their own wallet once it crosses the trigger they chose,
// just enough to bring it back to their target. Their token approval to this contract is the most it can ever take.
contract AdagGuard is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    struct Rule {
        uint64 triggerWad;
        uint64 targetWad;
        uint64 expiry;
    }

    struct Loan {
        uint256 shares;
        uint256 totalAssets;
        uint256 totalShares;
        uint256 debt;
        uint256 value;
    }

    address public constant MORPHO = 0x34CD04070dD72b14E241112F6d83812Df5Af7fCD;
    address public constant USDC = 0x3600000000000000000000000000000000000000;
    address public constant EURC = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;
    address public constant CIRBTC = 0x171A4217b86A807A64eB94757Db6849fb4bDbAA0;
    bytes32 public constant MARKET_USDC = 0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d;
    bytes32 public constant MARKET_EURC = 0x6ea1ea96a1cc671615f3a3bdf51481c5b79e362a8b634396e680d1070137daf4;
    uint256 public constant MAX_PAGE = 100;

    uint256 private constant WAD = 1e18;
    uint256 private constant ORACLE_PRICE_SCALE = 1e36;
    uint256 private constant VIRTUAL_SHARES = 1e6;
    uint256 private constant VIRTUAL_ASSETS = 1;

    IMorphoMinimal private constant _MORPHO = IMorphoMinimal(MORPHO);

    mapping(address borrower => mapping(bytes32 marketId => Rule)) private _rules;
    EnumerableSet.AddressSet private _holders;

    event RuleSet(address indexed borrower, bytes32 indexed marketId, uint64 triggerWad, uint64 targetWad, uint64 expiry);
    event RuleCleared(address indexed borrower, bytes32 indexed marketId);
    event Protected(
        address indexed borrower, bytes32 indexed marketId, uint256 repaid, uint256 ltvBeforeWad, uint256 ltvAfterWad
    );

    error BadMarket(bytes32 marketId);
    error ZeroTarget();
    error TargetNotBelowTrigger(uint64 targetWad, uint64 triggerWad);
    error TriggerNotBelowLiquidation(uint64 triggerWad, uint256 lltv);
    error ExpiryInPast(uint64 expiry);
    error NoRule(address borrower, bytes32 marketId);
    error PageTooLarge(uint256 limit);
    error RepaidNotPulled(uint256 repaid, uint256 pulled);
    error GuardBalanceChanged(uint256 before, uint256 afterCall);
    error MorphoAllowanceLeft(uint256 before, uint256 afterCall);

    function setRule(bytes32 marketId, uint64 triggerWad, uint64 targetWad, uint64 expiry) external {
        uint256 lltv = _params(marketId).lltv;
        if (targetWad == 0) revert ZeroTarget();
        if (targetWad >= triggerWad) revert TargetNotBelowTrigger(targetWad, triggerWad);
        if (triggerWad >= lltv) revert TriggerNotBelowLiquidation(triggerWad, lltv);
        if (expiry != 0 && expiry <= block.timestamp) revert ExpiryInPast(expiry);

        _rules[msg.sender][marketId] = Rule(triggerWad, targetWad, expiry);
        _holders.add(msg.sender);
        emit RuleSet(msg.sender, marketId, triggerWad, targetWad, expiry);
    }

    // Clearing never reads Morpho, so a borrower can always switch the guard off.
    function clearRule(bytes32 marketId) external {
        if (_rules[msg.sender][marketId].triggerWad == 0) revert NoRule(msg.sender, marketId);
        delete _rules[msg.sender][marketId];
        // setRule only accepts these two ids, so no other rule can exist.
        if (_rules[msg.sender][MARKET_USDC].triggerWad == 0 && _rules[msg.sender][MARKET_EURC].triggerWad == 0) {
            _holders.remove(msg.sender);
        }
        emit RuleCleared(msg.sender, marketId);
    }

    function protect(address borrower, bytes32 marketId) external nonReentrant returns (uint256 repaid) {
        MarketParams memory params = _params(marketId);
        (,,,, uint128 lastUpdate,) = _MORPHO.market(marketId);
        if (lastUpdate != block.timestamp) _MORPHO.accrueInterest(params);

        uint256 ltvBefore;
        (ltvBefore, repaid) = _plan(borrower, marketId, params);
        if (repaid == 0) return 0;

        IERC20 token = IERC20(params.loanToken);
        uint256 balanceBefore = token.balanceOf(address(this));
        uint256 allowanceBefore = token.allowance(address(this), MORPHO);

        token.safeTransferFrom(borrower, address(this), repaid);
        token.forceApprove(MORPHO, repaid);
        (uint256 assetsRepaid,) = IMorphoRepay(MORPHO).repay(params, repaid, 0, borrower, "");

        if (assetsRepaid != repaid) revert RepaidNotPulled(assetsRepaid, repaid);
        uint256 balanceAfter = token.balanceOf(address(this));
        if (balanceAfter != balanceBefore) revert GuardBalanceChanged(balanceBefore, balanceAfter);
        uint256 allowanceAfter = token.allowance(address(this), MORPHO);
        if (allowanceAfter != allowanceBefore) revert MorphoAllowanceLeft(allowanceBefore, allowanceAfter);

        Loan memory loan = _loan(borrower, marketId, params);
        emit Protected(borrower, marketId, repaid, ltvBefore, _ltv(loan.debt, loan.value));
    }

    function ruleOf(address borrower, bytes32 marketId) external view returns (Rule memory) {
        return _rules[borrower][marketId];
    }

    // Same computation protect runs. Between accruals it adds the interest Morpho would accrue at this block,
    // so in the same block the answer equals what protect repays.
    function quote(address borrower, bytes32 marketId)
        external
        view
        returns (bool wouldAct, uint256 amount, uint256 ltvWad)
    {
        (ltvWad, amount) = _plan(borrower, marketId, _params(marketId));
        wouldAct = amount != 0;
    }

    function holderCount() external view returns (uint256) {
        return _holders.length();
    }

    function holders(uint256 offset, uint256 limit) external view returns (address[] memory) {
        if (limit > MAX_PAGE) revert PageTooLarge(limit);
        uint256 total = _holders.length();
        if (offset >= total) return new address[](0);
        return _holders.values(offset, Math.min(offset + limit, total));
    }

    function _plan(address borrower, bytes32 marketId, MarketParams memory params)
        private
        view
        returns (uint256 ltvWad, uint256 amount)
    {
        Loan memory loan = _loan(borrower, marketId, params);
        ltvWad = _ltv(loan.debt, loan.value);
        Rule memory rule = _rules[borrower][marketId];
        if (rule.triggerWad == 0 || ltvWad < rule.triggerWad) return (ltvWad, 0);
        if (rule.expiry != 0 && block.timestamp >= rule.expiry) return (ltvWad, 0);

        amount = Math.min(_toTarget(loan, Math.mulDiv(loan.value, rule.targetWad, WAD)), _repayCap(loan));
        IERC20 token = IERC20(params.loanToken);
        amount = Math.min(amount, token.allowance(borrower, address(this)));
        amount = Math.min(amount, token.balanceOf(borrower));
    }

    // Morpho turns a repayment into shares rounding down and reverts if that exceeds the borrower's shares, so
    // the debt rounded down is the most that can go in. Virtual only so a test can show what breaks without it.
    function _repayCap(Loan memory loan) internal pure virtual returns (uint256) {
        return Math.mulDiv(loan.shares, loan.totalAssets + VIRTUAL_ASSETS, loan.totalShares + VIRTUAL_SHARES);
    }

    // The smallest repayment after which the debt, as Morpho will round it, is at most maxDebt. Paying
    // debt - maxDebt ignores the shares Morpho rounds away, which can leave the new debt one unit high; one unit
    // less can never be enough. One unit more always lands while a share is worth under one unit of the token.
    function _toTarget(Loan memory loan, uint256 maxDebt) private pure returns (uint256) {
        uint256 guess = loan.debt - maxDebt;
        return _debtAfter(loan, guess) <= maxDebt ? guess : guess + 1;
    }

    // Morpho's repay by assets, restated: shares burned rounded down, totals cut, debt re-read rounded up.
    function _debtAfter(Loan memory loan, uint256 assets) private pure returns (uint256) {
        uint256 burned = Math.mulDiv(assets, loan.totalShares + VIRTUAL_SHARES, loan.totalAssets + VIRTUAL_ASSETS);
        if (burned >= loan.shares) return 0;
        uint256 assetsLeft = loan.totalAssets > assets ? loan.totalAssets - assets : 0;
        return Math.mulDiv(
            loan.shares - burned,
            assetsLeft + VIRTUAL_ASSETS,
            loan.totalShares - burned + VIRTUAL_SHARES,
            Math.Rounding.Ceil
        );
    }

    function _loan(address borrower, bytes32 marketId, MarketParams memory params)
        private
        view
        returns (Loan memory loan)
    {
        (, uint128 shares, uint128 collateral) = _MORPHO.position(marketId, borrower);
        if (shares == 0) return loan;
        loan.shares = shares;
        (loan.totalAssets, loan.totalShares) = _borrowTotals(marketId, params);
        loan.debt = Math.mulDiv(
            shares, loan.totalAssets + VIRTUAL_ASSETS, loan.totalShares + VIRTUAL_SHARES, Math.Rounding.Ceil
        );
        // No freshness gate: this is the price Morpho liquidates on, so it is the one worth reacting to.
        loan.value = Math.mulDiv(collateral, IOracleMinimal(params.oracle).price(), ORACLE_PRICE_SCALE);
    }

    // Borrow totals with the interest Morpho would add at this block, using its own formula. Once protect has
    // accrued, no time has passed and the stored totals come back unchanged.
    function _borrowTotals(bytes32 marketId, MarketParams memory params)
        private
        view
        returns (uint256 totalAssets, uint256 totalShares)
    {
        (
            uint128 supplyAssets,
            uint128 supplyShares,
            uint128 borrowAssets,
            uint128 borrowShares,
            uint128 lastUpdate,
            uint128 fee
        ) = _MORPHO.market(marketId);
        totalAssets = borrowAssets;
        totalShares = borrowShares;
        uint256 elapsed = block.timestamp - lastUpdate;
        if (elapsed == 0 || borrowAssets == 0 || params.irm == address(0)) return (totalAssets, totalShares);

        uint256 rate = IIrmMinimal(params.irm).borrowRateView(
            params, Market(supplyAssets, supplyShares, borrowAssets, borrowShares, lastUpdate, fee)
        );
        uint256 first = rate * elapsed;
        uint256 second = Math.mulDiv(first, first, 2 * WAD);
        uint256 third = Math.mulDiv(second, first, 3 * WAD);
        totalAssets += Math.mulDiv(totalAssets, first + second + third, WAD);
    }

    function _ltv(uint256 debt, uint256 value) private pure returns (uint256) {
        if (debt == 0) return 0;
        if (value == 0) return type(uint256).max;
        return Math.mulDiv(debt, WAD, value, Math.Rounding.Ceil);
    }

    function _params(bytes32 marketId) private view returns (MarketParams memory p) {
        address expectedLoan;
        if (marketId == MARKET_USDC) expectedLoan = USDC;
        else if (marketId == MARKET_EURC) expectedLoan = EURC;
        else revert BadMarket(marketId);

        (p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv) = _MORPHO.idToMarketParams(marketId);
        if (
            p.loanToken != expectedLoan || p.collateralToken != CIRBTC || p.oracle == address(0) || p.lltv == 0
                || p.lltv >= WAD
        ) revert BadMarket(marketId);
    }
}
