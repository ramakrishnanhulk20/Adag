// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IMorphoMinimal, MarketParams} from "./interfaces/IMorphoMinimal.sol";
import {IOracleMinimal} from "./interfaces/IOracleMinimal.sol";
import {IChainlinkFeed} from "./interfaces/IChainlinkFeed.sol";

// Bills you pay once, in cash or with a loan against your cirBTC, kept at or under 40%.
contract AdagBills is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Paid,
        Void
    }

    struct Bill {
        address payee;
        Status status;
        uint64 due;
        address currency;
        uint64 createdAt;
        uint256 amount;
        address payer;
        uint64 paidAt;
        bytes ref;
    }

    struct Seen {
        uint128 shares;
        uint128 collateral;
    }

    struct PositionChange {
        bool changed;
        bool mustCheck;
        uint256 shares;
        uint256 collateral;
    }

    struct FeedRead {
        address feed;
        uint256 updatedAt;
        bool fresh;
    }

    address public constant MORPHO = 0x34CD04070dD72b14E241112F6d83812Df5Af7fCD;
    address public constant USDC = 0x3600000000000000000000000000000000000000;
    address public constant EURC = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;
    address public constant CIRBTC = 0x171A4217b86A807A64eB94757Db6849fb4bDbAA0;
    bytes32 public constant MARKET_USDC = 0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d;
    bytes32 public constant MARKET_EURC = 0x6ea1ea96a1cc671615f3a3bdf51481c5b79e362a8b634396e680d1070137daf4;

    uint256 public constant MAX_LTV_WAD = 0.4e18;
    uint256 public constant BTC_USD_MAX_AGE = 26 hours;
    // The EUR/USD feed pauses over weekends, so it gets a longer window.
    uint256 public constant EUR_USD_MAX_AGE = 96 hours;
    uint256 public constant MAX_REFERENCE_BYTES = 140;
    uint256 public constant MAX_PAGE = 100;

    uint256 private constant WAD = 1e18;
    uint256 private constant ORACLE_PRICE_SCALE = 1e36;
    // Same rounding as Morpho, so our 40% line agrees with its own health check.
    uint256 private constant VIRTUAL_SHARES = 1e6;
    uint256 private constant VIRTUAL_ASSETS = 1;

    IMorphoMinimal private constant _MORPHO = IMorphoMinimal(MORPHO);

    uint256 private _billCount;
    mapping(uint256 id => Bill) private _bills;
    mapping(address payee => uint256[] ids) private _payeeBills;
    mapping(address payer => uint256[] ids) private _payerPayments;
    mapping(address payer => mapping(bytes32 marketId => Seen)) private _seen;
    mapping(address payer => uint64 blockNumber) private _enrolledAt;

    event BillCreated(
        uint256 indexed id, address indexed payee, address indexed currency, uint256 amount, uint64 due, bytes ref
    );
    event BillVoided(uint256 indexed id, address indexed payee);
    event BillPaid(
        uint256 indexed id,
        address indexed payer,
        address indexed payee,
        address currency,
        uint256 amount,
        bool loanChecked
    );
    event DebtRecorded(
        address indexed payer, bytes32 indexed marketId, uint256 borrowShares, uint256 collateral, bool checked
    );
    event Enrolled(
        address indexed payer, uint256 usdcShares, uint256 usdcCollateral, uint256 eurcShares, uint256 eurcCollateral
    );

    error ZeroAmount();
    error ReferenceTooLong(uint256 length);
    error UnsupportedCurrency(address currency);
    error UnknownBill(uint256 id);
    error BillNotOpen(uint256 id, Status status);
    error NotPayee(address caller);
    error SelfPayment();
    error PayeeNotCredited(uint256 rise, uint256 amount);
    error BadMarket(bytes32 marketId);
    error BadFeed(address oracle);
    error StalePrice(address feed, uint256 updatedAt);
    error ZeroPrice();
    error LtvAboveLimit(bytes32 marketId, uint256 borrowed, uint256 maxBorrow);
    error PageTooLarge(uint256 limit);
    error EnrolledThisBlock();

    function createBill(address currency, uint256 amount, uint64 due, bytes calldata ref)
        external
        returns (uint256 id)
    {
        if (amount == 0) revert ZeroAmount();
        if (ref.length > MAX_REFERENCE_BYTES) revert ReferenceTooLong(ref.length);
        bytes32 marketId;
        if (currency == USDC) marketId = MARKET_USDC;
        else if (currency == EURC) marketId = MARKET_EURC;
        else revert UnsupportedCurrency(currency);
        _params(marketId);

        id = ++_billCount;
        Bill storage b = _bills[id];
        b.payee = msg.sender;
        b.status = Status.Open;
        b.due = due;
        b.currency = currency;
        b.createdAt = uint64(block.timestamp);
        b.amount = amount;
        b.ref = ref;
        _payeeBills[msg.sender].push(id);

        emit BillCreated(id, msg.sender, currency, amount, due, ref);
    }

    function voidBill(uint256 id) external {
        Bill storage b = _bills[id];
        Status status = b.status;
        if (status == Status.None) revert UnknownBill(id);
        if (status != Status.Open) revert BillNotOpen(id, status);
        if (msg.sender != b.payee) revert NotPayee(msg.sender);

        b.status = Status.Void;
        emit BillVoided(id, msg.sender);
    }

    function pay(uint256 id) external nonReentrant {
        Bill storage b = _bills[id];
        Status status = b.status;
        if (status == Status.None) revert UnknownBill(id);
        if (status != Status.Open) revert BillNotOpen(id, status);
        address payee = b.payee;
        if (msg.sender == payee) revert SelfPayment();
        // Otherwise one batch could borrow, enrol the new debt and pay with it unchecked.
        if (_enrolledAt[msg.sender] == block.number) revert EnrolledThisBlock();

        b.status = Status.Paid;
        b.payer = msg.sender;
        b.paidAt = uint64(block.timestamp);
        _payerPayments[msg.sender].push(id);

        // Record both markets before any external call. A loan in either one can pay this bill.
        PositionChange memory usdcPos = _recordPosition(MARKET_USDC, msg.sender);
        PositionChange memory eurcPos = _recordPosition(MARKET_EURC, msg.sender);

        IERC20 token = IERC20(b.currency);
        uint256 amount = b.amount;
        uint256 balanceBefore = token.balanceOf(payee);
        token.safeTransferFrom(msg.sender, payee, amount);
        uint256 balanceAfter = token.balanceOf(payee);
        uint256 rise = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
        if (rise < amount) revert PayeeNotCredited(rise, amount);

        if (usdcPos.mustCheck) _checkLoan(MARKET_USDC, msg.sender);
        if (eurcPos.mustCheck) _checkLoan(MARKET_EURC, msg.sender);

        if (usdcPos.changed) {
            emit DebtRecorded(msg.sender, MARKET_USDC, usdcPos.shares, usdcPos.collateral, usdcPos.mustCheck);
        }
        if (eurcPos.changed) {
            emit DebtRecorded(msg.sender, MARKET_EURC, eurcPos.shares, eurcPos.collateral, eurcPos.mustCheck);
        }
        emit BillPaid(id, msg.sender, payee, address(token), amount, usdcPos.mustCheck || eurcPos.mustCheck);
    }

    // Accepts the caller's existing loans as they stand, with no 40% check, so later payments only check new debt.
    function enrol() external nonReentrant {
        (, uint128 usdcShares, uint128 usdcCollateral) = _MORPHO.position(MARKET_USDC, msg.sender);
        (, uint128 eurcShares, uint128 eurcCollateral) = _MORPHO.position(MARKET_EURC, msg.sender);
        _seen[msg.sender][MARKET_USDC] = Seen(usdcShares, usdcCollateral);
        _seen[msg.sender][MARKET_EURC] = Seen(eurcShares, eurcCollateral);
        _enrolledAt[msg.sender] = uint64(block.number);
        emit Enrolled(msg.sender, usdcShares, usdcCollateral, eurcShares, eurcCollateral);
    }

    function bill(uint256 id) external view returns (Bill memory) {
        return _bills[id];
    }

    function billCount() external view returns (uint256) {
        return _billCount;
    }

    function billsOfPayee(address payee, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total)
    {
        return _page(_payeeBills[payee], offset, limit);
    }

    function paymentsOfPayer(address payer, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total)
    {
        return _page(_payerPayments[payer], offset, limit);
    }

    function seenPosition(address payer, bytes32 marketId) external view returns (uint256 shares, uint256 collateral) {
        Seen memory seen = _seen[payer][marketId];
        return (seen.shares, seen.collateral);
    }

    function enrolledAt(address payer) external view returns (uint64 blockNumber) {
        return _enrolledAt[payer];
    }

    function loanToValue(address user, bytes32 marketId) external view returns (uint256 ltvWad) {
        MarketParams memory params = _params(marketId);
        (uint256 borrowed, uint256 collateral) = _debt(marketId, user);
        if (borrowed == 0) return 0;
        uint256 value = Math.mulDiv(collateral, IOracleMinimal(params.oracle).price(), ORACLE_PRICE_SCALE);
        if (value == 0) return type(uint256).max;
        return Math.mulDiv(borrowed, WAD, value, Math.Rounding.Ceil);
    }

    function collateralNeeded(address user, bytes32 marketId, uint256 extraBorrow)
        external
        view
        returns (uint256 extraCollateral)
    {
        MarketParams memory params = _params(marketId);
        (uint256 borrowed, uint256 collateral) = _debt(marketId, user);
        uint256 target = borrowed + extraBorrow;
        if (target == 0) return 0;
        uint256 price = IOracleMinimal(params.oracle).price();
        if (price == 0) revert ZeroPrice();
        // Round up at both steps so the suggestion always clears the check.
        uint256 minValue = Math.mulDiv(target, WAD, MAX_LTV_WAD, Math.Rounding.Ceil);
        uint256 required = Math.mulDiv(minValue, ORACLE_PRICE_SCALE, price, Math.Rounding.Ceil);
        return required > collateral ? required - collateral : 0;
    }

    function priceStatus(bytes32 marketId)
        external
        view
        returns (bool fresh, uint256 btcUsdUpdatedAt, uint256 eurUsdUpdatedAt)
    {
        MarketParams memory params = _params(marketId);
        (FeedRead memory btcUsd, FeedRead memory eurUsd) = _feeds(marketId, params.oracle);
        return (btcUsd.fresh && eurUsd.fresh, btcUsd.updatedAt, eurUsd.updatedAt);
    }

    // Check only when the payer made the loan riskier: more debt, or less collateral.
    function _recordPosition(bytes32 marketId, address payer) private returns (PositionChange memory change) {
        (, uint128 shares, uint128 collateral) = _MORPHO.position(marketId, payer);
        Seen memory seen = _seen[payer][marketId];
        if (shares == seen.shares && collateral == seen.collateral) return change;
        _seen[payer][marketId] = Seen(shares, collateral);
        change.changed = true;
        change.mustCheck = shares != 0 && (shares > seen.shares || collateral < seen.collateral);
        change.shares = shares;
        change.collateral = collateral;
    }

    function _checkLoan(bytes32 marketId, address payer) private {
        MarketParams memory params = _params(marketId);
        (,,,, uint128 lastUpdate,) = _MORPHO.market(marketId);
        if (lastUpdate != block.timestamp) _MORPHO.accrueInterest(params);

        (FeedRead memory btcUsd, FeedRead memory eurUsd) = _feeds(marketId, params.oracle);
        if (!btcUsd.fresh) revert StalePrice(btcUsd.feed, btcUsd.updatedAt);
        if (!eurUsd.fresh) revert StalePrice(eurUsd.feed, eurUsd.updatedAt);

        uint256 price = IOracleMinimal(params.oracle).price();
        if (price == 0) revert ZeroPrice();

        (uint256 borrowed, uint256 collateral) = _debt(marketId, payer);
        uint256 maxBorrow = _maxBorrow(collateral, price);
        if (borrowed > maxBorrow) revert LtvAboveLimit(marketId, borrowed, maxBorrow);
    }

    function _feeds(bytes32 marketId, address oracle)
        private
        view
        returns (FeedRead memory btcUsd, FeedRead memory eurUsd)
    {
        btcUsd = _readFeed(oracle, IOracleMinimal(oracle).BASE_FEED_1(), BTC_USD_MAX_AGE);
        if (marketId == MARKET_EURC) {
            eurUsd = _readFeed(oracle, IOracleMinimal(oracle).QUOTE_FEED_1(), EUR_USD_MAX_AGE);
        } else {
            // The USDC market has no EUR/USD feed.
            eurUsd.fresh = true;
        }
    }

    function _readFeed(address oracle, address feed, uint256 maxAge) private view returns (FeedRead memory read) {
        if (feed == address(0)) revert BadFeed(oracle);
        (, int256 answer,, uint256 updatedAt,) = IChainlinkFeed(feed).latestRoundData();
        read.feed = feed;
        read.updatedAt = updatedAt;
        read.fresh = answer > 0 && updatedAt <= block.timestamp && block.timestamp - updatedAt <= maxAge;
    }

    function _debt(bytes32 marketId, address user) private view returns (uint256 borrowed, uint256 collateral) {
        (, uint128 borrowShares, uint128 pledged) = _MORPHO.position(marketId, user);
        collateral = pledged;
        if (borrowShares == 0) return (0, collateral);
        (,, uint128 totalBorrowAssets, uint128 totalBorrowShares,,) = _MORPHO.market(marketId);
        borrowed = Math.mulDiv(
            borrowShares,
            uint256(totalBorrowAssets) + VIRTUAL_ASSETS,
            uint256(totalBorrowShares) + VIRTUAL_SHARES,
            Math.Rounding.Ceil
        );
    }

    function _maxBorrow(uint256 collateral, uint256 price) private pure returns (uint256) {
        return Math.mulDiv(Math.mulDiv(collateral, price, ORACLE_PRICE_SCALE), MAX_LTV_WAD, WAD);
    }

    function _params(bytes32 marketId) private view returns (MarketParams memory p) {
        address expectedLoan;
        if (marketId == MARKET_USDC) expectedLoan = USDC;
        else if (marketId == MARKET_EURC) expectedLoan = EURC;
        else revert BadMarket(marketId);

        (p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv) = _MORPHO.idToMarketParams(marketId);
        if (
            p.loanToken != expectedLoan || p.collateralToken != CIRBTC || p.oracle == address(0)
                || p.lltv <= MAX_LTV_WAD
        ) revert BadMarket(marketId);
    }

    function _page(uint256[] storage list, uint256 offset, uint256 limit)
        private
        view
        returns (uint256[] memory ids, uint256 total)
    {
        if (limit > MAX_PAGE) revert PageTooLarge(limit);
        total = list.length;
        if (offset >= total) return (new uint256[](0), total);
        uint256 end = Math.min(offset + limit, total);
        ids = new uint256[](end - offset);
        for (uint256 i; i < ids.length; ++i) {
            ids[i] = list[offset + i];
        }
    }
}
