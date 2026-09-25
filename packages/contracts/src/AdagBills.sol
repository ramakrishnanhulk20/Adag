// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IMorphoMinimal, MarketParams} from "./interfaces/IMorphoMinimal.sol";
import {IOracleMinimal} from "./interfaces/IOracleMinimal.sol";
import {IChainlinkFeed} from "./interfaces/IChainlinkFeed.sol";

/// @title AdagBills
/// @notice A public bill book on Arc. A supplier writes a bill in USDC or EURC; anyone else can pay it exactly
/// once, and the supplier is proven credited in the same call. When the payer's Morpho debt against cirBTC has
/// grown since Adag last looked, the payment only goes through if that debt sits at or under 40% of the
/// collateral's value.
/// @dev Immutable, no owner, no admin, no pause, no rescue. Adag never holds tokens: the only transfer it makes
/// goes straight from the payer to the payee inside `pay`.
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

    struct DebtChange {
        bool changed;
        bool grew;
        uint256 shares;
    }

    struct FeedRead {
        address feed;
        uint256 updatedAt;
        bool fresh;
    }

    /// @notice Morpho Blue on Arc, the lending contract whose positions Adag reads.
    address public constant MORPHO = 0x34CD04070dD72b14E241112F6d83812Df5Af7fCD;
    /// @notice USDC, one of the two currencies a bill can be written in.
    /// @dev The 6-decimal ERC-20 face of Arc's native USDC.
    address public constant USDC = 0x3600000000000000000000000000000000000000;
    /// @notice EURC, the other currency a bill can be written in.
    address public constant EURC = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;
    /// @notice cirBTC, the collateral both Adag markets lend against.
    address public constant CIRBTC = 0x171A4217b86A807A64eB94757Db6849fb4bDbAA0;
    /// @notice The Morpho market that lends USDC against cirBTC.
    bytes32 public constant MARKET_USDC = 0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d;
    /// @notice The Morpho market that lends EURC against cirBTC.
    bytes32 public constant MARKET_EURC = 0x6ea1ea96a1cc671615f3a3bdf51481c5b79e362a8b634396e680d1070137daf4;

    /// @notice The highest debt over collateral value a payment that adds debt may leave, WAD scaled (40%).
    uint256 public constant MAX_LTV_WAD = 0.4e18;
    /// @notice The oldest BTC/USD price, in seconds, that a payment adding debt accepts.
    /// @dev BTC/USD has a 24 hour heartbeat. Two hours of slack so one late update does not block new loans.
    uint256 public constant BTC_USD_MAX_AGE = 26 hours;
    /// @notice The oldest EUR/USD price, in seconds, that a payment adding EURC debt accepts.
    /// @dev EUR/USD follows forex hours and sits still over a weekend. 96 hours spans a weekend plus a holiday.
    uint256 public constant EUR_USD_MAX_AGE = 96 hours;
    /// @notice The longest reference a bill can carry, counted in bytes.
    uint256 public constant MAX_REFERENCE_BYTES = 140;
    /// @notice The most ids one call to billsOfPayee or paymentsOfPayer returns.
    /// @dev 100 ids is about 100 cold storage reads, roughly 220,000 gas: far under the 30M block gas limit
    /// and under the gas cap public RPCs apply to eth_call.
    uint256 public constant MAX_PAGE = 100;

    uint256 private constant WAD = 1e18;
    uint256 private constant ORACLE_PRICE_SCALE = 1e36;
    /// @dev Morpho's SharesMathLib values, so Adag's debt figure rounds exactly like Morpho's own health check.
    uint256 private constant VIRTUAL_SHARES = 1e6;
    uint256 private constant VIRTUAL_ASSETS = 1;

    IMorphoMinimal private constant _MORPHO = IMorphoMinimal(MORPHO);

    uint256 private _billCount;
    mapping(uint256 id => Bill) private _bills;
    mapping(address payee => uint256[] ids) private _payeeBills;
    mapping(address payer => uint256[] ids) private _payerPayments;
    mapping(address payer => mapping(bytes32 marketId => uint256 shares)) private _seenShares;

    /// @notice A payee wrote a bill.
    /// @param id The new bill id.
    /// @param payee The account that wrote the bill and will be paid.
    /// @param currency The token the bill is paid in, USDC or EURC.
    /// @param amount The amount due, in the token's base units.
    /// @param due Unix time the payee asks to be paid by, or 0 for none. Information only.
    /// @param ref The payee's reference bytes, at most 140. Untrusted text: show it as plain text only.
    event BillCreated(
        uint256 indexed id, address indexed payee, address indexed currency, uint256 amount, uint64 due, bytes ref
    );
    /// @notice A payee cancelled an open bill. It can never be paid.
    /// @param id The cancelled bill.
    /// @param payee The bill's payee, who cancelled it.
    event BillVoided(uint256 indexed id, address indexed payee);
    /// @notice A bill was paid in full. This event, from this contract, is the proof of payment.
    /// @param id The paid bill.
    /// @param payer The account the amount came from.
    /// @param payee The account that received it, checked by its balance in the same call.
    /// @param currency The token that moved.
    /// @param amount The exact amount that moved, in the token's base units.
    /// @param loanChecked True if the payer's debt had grown in either Adag market and passed the 40% check.
    event BillPaid(
        uint256 indexed id,
        address indexed payer,
        address indexed payee,
        address currency,
        uint256 amount,
        bool loanChecked
    );
    /// @notice Adag stored a new value for a payer's Morpho borrow shares in one of its markets.
    /// @param payer The borrower.
    /// @param marketId MARKET_USDC or MARKET_EURC.
    /// @param borrowShares The live borrow shares Adag now remembers.
    /// @param checked True if the shares had grown and the 40% check passed; false if they had fallen.
    event DebtRecorded(address indexed payer, bytes32 indexed marketId, uint256 borrowShares, bool checked);

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

    /// @notice Writes a bill payable to the caller.
    /// @dev The caller is always the payee, so nobody can write a bill in someone else's name. The currency picks
    /// its market (USDC the USDC market, EURC the EURC market), and Morpho must report that market with the
    /// currency as its loan token. Only the bill's own market is read. `due` is information only; 0 means none.
    /// Reverts ZeroAmount, ReferenceTooLong above 140 bytes, UnsupportedCurrency for any other token, BadMarket
    /// if Morpho's answer for the bill's market is not the expected one. Emits BillCreated.
    /// @param currency USDC or EURC (the 6-decimal ERC-20 addresses).
    /// @param amount Amount in the token's base units.
    /// @param due Unix time the payee asks to be paid by, or 0.
    /// @param ref Free bytes, such as an invoice number, at most 140 bytes.
    /// @return id The new bill id. Ids start at 1 and never repeat.
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

    /// @notice Cancels an open bill so it can never be paid.
    /// @dev Only the payee, only while the bill is open. Reverts UnknownBill, BillNotOpen, NotPayee.
    /// Emits BillVoided.
    /// @param id The bill to cancel.
    function voidBill(uint256 id) external {
        Bill storage b = _bills[id];
        Status status = b.status;
        if (status == Status.None) revert UnknownBill(id);
        if (status != Status.Open) revert BillNotOpen(id, status);
        if (msg.sender != b.payee) revert NotPayee(msg.sender);

        b.status = Status.Void;
        emit BillVoided(id, msg.sender);
    }

    /// @notice Pays an open bill from the caller's own balance.
    /// @dev The caller must have approved this contract for exactly the bill amount in the bill's currency.
    /// The bill is marked paid before any external call. The amount moves from the caller straight to the
    /// payee, and the payee's balance must rise by at least the amount in this same call. Then, in both Adag
    /// markets, if the caller's Morpho borrow shares are above the value Adag last accepted, the caller's debt
    /// there must be at or under 40% of the collateral value, with interest accrued and fresh prices.
    /// Reverts UnknownBill, BillNotOpen, SelfPayment, PayeeNotCredited, any token revert, BadMarket, BadFeed,
    /// StalePrice, ZeroPrice, LtvAboveLimit. Emits DebtRecorded for each market whose shares changed, then
    /// BillPaid with loanChecked true if either market ran the 40% check.
    /// @param id The bill to pay.
    function pay(uint256 id) external nonReentrant {
        Bill storage b = _bills[id];
        Status status = b.status;
        if (status == Status.None) revert UnknownBill(id);
        if (status != Status.Open) revert BillNotOpen(id, status);
        address payee = b.payee;
        if (msg.sender == payee) revert SelfPayment();

        b.status = Status.Paid;
        b.payer = msg.sender;
        b.paidAt = uint64(block.timestamp);
        _payerPayments[msg.sender].push(id);
        // Both markets, whatever the bill's currency: a loan taken in one market can fund a bill in the other.
        // Shares are recorded before any external call that can change state; a failed check reverts them.
        DebtChange memory usdcDebt = _recordShares(MARKET_USDC, msg.sender);
        DebtChange memory eurcDebt = _recordShares(MARKET_EURC, msg.sender);

        IERC20 token = IERC20(b.currency);
        uint256 amount = b.amount;
        uint256 balanceBefore = token.balanceOf(payee);
        token.safeTransferFrom(msg.sender, payee, amount);
        uint256 balanceAfter = token.balanceOf(payee);
        uint256 rise = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
        if (rise < amount) revert PayeeNotCredited(rise, amount);

        if (usdcDebt.grew) _checkLoan(MARKET_USDC, msg.sender);
        if (eurcDebt.grew) _checkLoan(MARKET_EURC, msg.sender);

        if (usdcDebt.changed) emit DebtRecorded(msg.sender, MARKET_USDC, usdcDebt.shares, usdcDebt.grew);
        if (eurcDebt.changed) emit DebtRecorded(msg.sender, MARKET_EURC, eurcDebt.shares, eurcDebt.grew);
        emit BillPaid(id, msg.sender, payee, address(token), amount, usdcDebt.grew || eurcDebt.grew);
    }

    /// @notice Returns a bill's full record.
    /// @dev An id that was never written returns an empty record with status None. Never reverts.
    /// @param id The bill id.
    function bill(uint256 id) external view returns (Bill memory) {
        return _bills[id];
    }

    /// @notice Number of bills ever written, which is also the highest id.
    function billCount() external view returns (uint256) {
        return _billCount;
    }

    /// @notice One page of the bill ids a payee has written, oldest first.
    /// @dev An offset at or past the end returns an empty page. Reverts PageTooLarge above 100.
    /// @param payee The payee address.
    /// @param offset Index of the first id to return.
    /// @param limit Most ids to return, at most 100.
    /// @return ids The page.
    /// @return total How many bills the payee has written in all.
    function billsOfPayee(address payee, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total)
    {
        return _page(_payeeBills[payee], offset, limit);
    }

    /// @notice One page of the bill ids a payer has paid, oldest first.
    /// @dev An offset at or past the end returns an empty page. Reverts PageTooLarge above 100.
    /// @param payer The payer address.
    /// @param offset Index of the first id to return.
    /// @param limit Most ids to return, at most 100.
    /// @return ids The page.
    /// @return total How many bills the payer has paid in all.
    function paymentsOfPayer(address payer, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, uint256 total)
    {
        return _page(_payerPayments[payer], offset, limit);
    }

    /// @notice The borrow shares Adag last accepted for a payer in a market.
    /// @dev Shares do not grow with interest, so a live value above this one means the payer took new debt
    /// since Adag last looked. 0 for a payer Adag has never seen.
    /// @param payer The payer address.
    /// @param marketId A Morpho market id.
    function seenShares(address payer, bytes32 marketId) external view returns (uint256) {
        return _seenShares[payer][marketId];
    }

    /// @notice A user's debt over collateral value in an Adag market, WAD scaled (0.4e18 is 40%), rounded up.
    /// @dev A preview. It uses the same maths as the check in `pay` but does not accrue interest, so it can
    /// read slightly low, and it does not check price freshness. Returns 0 with no debt, and type(uint256).max
    /// with debt but zero collateral value, including a zero price. Reverts BadMarket for any other id.
    /// @param user The borrower.
    /// @param marketId MARKET_USDC or MARKET_EURC.
    /// @return ltvWad Debt over collateral value, WAD scaled and rounded up.
    function loanToValue(address user, bytes32 marketId) external view returns (uint256 ltvWad) {
        MarketParams memory params = _params(marketId);
        (uint256 borrowed, uint256 collateral) = _debt(marketId, user);
        if (borrowed == 0) return 0;
        uint256 value = Math.mulDiv(collateral, IOracleMinimal(params.oracle).price(), ORACLE_PRICE_SCALE);
        if (value == 0) return type(uint256).max;
        return Math.mulDiv(borrowed, WAD, value, Math.Rounding.Ceil);
    }

    /// @notice Extra cirBTC (8 decimals, rounded up) a user must pledge so that their current debt plus
    /// `extraBorrow` sits at or under 40% in an Adag market.
    /// @dev A preview. It uses the same maths as the check in `pay` but does not accrue interest and does not
    /// check price freshness, so the app should add a margin. Returns 0 when current collateral already covers
    /// it. Reverts BadMarket for any other id, ZeroPrice if the oracle reads 0.
    /// @param user The borrower.
    /// @param marketId MARKET_USDC or MARKET_EURC.
    /// @param extraBorrow The new borrow in the loan token's base units.
    /// @return extraCollateral The cirBTC to add, in satoshis (8 decimals), rounded up; 0 if none is needed.
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
        // _maxBorrow floors twice; undoing each floor with a ceiling gives the smallest collateral it accepts.
        uint256 minValue = Math.mulDiv(target, WAD, MAX_LTV_WAD, Math.Rounding.Ceil);
        uint256 required = Math.mulDiv(minValue, ORACLE_PRICE_SCALE, price, Math.Rounding.Ceil);
        return required > collateral ? required - collateral : 0;
    }

    /// @notice Whether the price feeds are fresh enough for `pay` to accept new debt in a market.
    /// @dev `fresh` is exactly the freshness condition `pay` enforces: a positive answer no older than 26 hours
    /// for BTC/USD and, for MARKET_EURC only, no older than 96 hours for EUR/USD. Reverts BadMarket for any
    /// other id, BadFeed if the oracle names no feed.
    /// @param marketId MARKET_USDC or MARKET_EURC.
    /// @return fresh True if a payment that adds debt would pass the freshness check now.
    /// @return btcUsdUpdatedAt When the BTC/USD feed last updated.
    /// @return eurUsdUpdatedAt When the EUR/USD feed last updated, or 0 for MARKET_USDC.
    function priceStatus(bytes32 marketId)
        external
        view
        returns (bool fresh, uint256 btcUsdUpdatedAt, uint256 eurUsdUpdatedAt)
    {
        MarketParams memory params = _params(marketId);
        (FeedRead memory btcUsd, FeedRead memory eurUsd) = _feeds(marketId, params.oracle);
        return (btcUsd.fresh && eurUsd.fresh, btcUsd.updatedAt, eurUsd.updatedAt);
    }

    // Shares, not the loan-to-value, decide whether to check: a price drop or interest never blocks a payment
    // that adds no debt, while any new borrow since Adag last looked, made anywhere, must pass the 40% line.
    function _recordShares(bytes32 marketId, address payer) private returns (DebtChange memory change) {
        (, uint128 shares,) = _MORPHO.position(marketId, payer);
        uint256 seen = _seenShares[payer][marketId];
        if (shares == seen) return change;
        _seenShares[payer][marketId] = shares;
        change.changed = true;
        change.grew = shares > seen;
        change.shares = shares;
    }

    // Shape follows Morpho's BlueBundlesV1.requireMaxLtv, plus the freshness and zero-price checks Morpho skips.
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

    // eurUsd is reported fresh with zero fields for MARKET_USDC, whose oracle has no quote feed.
    function _feeds(bytes32 marketId, address oracle)
        private
        view
        returns (FeedRead memory btcUsd, FeedRead memory eurUsd)
    {
        btcUsd = _readFeed(oracle, IOracleMinimal(oracle).BASE_FEED_1(), BTC_USD_MAX_AGE);
        if (marketId == MARKET_EURC) {
            eurUsd = _readFeed(oracle, IOracleMinimal(oracle).QUOTE_FEED_1(), EUR_USD_MAX_AGE);
        } else {
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

    // Fails closed: anything but the two fixed ids, or a Morpho answer that is not the expected market, reverts.
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
        // offset < total and limit <= 100, so the sum cannot overflow.
        uint256 end = Math.min(offset + limit, total);
        ids = new uint256[](end - offset);
        for (uint256 i; i < ids.length; ++i) {
            ids[i] = list[offset + i];
        }
    }
}
