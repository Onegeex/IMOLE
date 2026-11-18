// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAggregatorV3, IQieDexRouter} from "./interfaces/IQie.sol";
import {ImoleKYC} from "./ImoleKYC.sol";
import {KitArt} from "./KitArt.sol";

/// @title Imole — pay-as-you-go solar on QIE
/// @notice An installer puts a solar kit in a customer's home and lists it here as an
///         NFT with a fixed price. The customer (or anyone, e.g. a relative abroad)
///         pays it off in QUSDC, or in QIE swapped to QUSDC on QIEDEX. Every payment
///         buys days of power. The kit's controller reads `isKitActive` and cuts the
///         output when the paid-up period (plus grace) runs out. When the price is
///         fully paid, the NFT moves to the customer and the kit is unlocked forever.
/// @dev    Trust rules enforced here, not by the installer:
///         - an installer cannot switch off a paid-up customer (status is computed from payments only);
///         - an installer cannot change the price or terms after the customer accepts;
///         - an installer cannot repossess until the customer is `repossessAfter` seconds overdue;
///         - once paid off, nobody can lock the kit again.
contract ImolePAYG is ERC721, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types

    enum Status {
        None,
        Pending, // listed by installer, waiting for the customer to accept and pay the deposit
        Active, // being paid off
        PaidOff, // owned by the customer
        Repossessed, // customer defaulted, kit returned to installer
        Cancelled // installer withdrew before acceptance
    }

    struct Installer {
        bool registered;
        bool verified; // set by Imole after checking the business (CAC registration etc.)
        string name;
        uint32 plans;
        uint128 collected; // total QUSDC received
    }

    struct Kit {
        address installer;
        uint32 panelWatts;
        uint32 batteryWh;
        uint32 inverterVA;
        string location; // city / area only, never a street address
        uint256 currentPlan;
    }

    /// @notice Terms an installer offers. All money amounts are in QUSDC base units.
    struct Terms {
        uint128 price; // total price of the kit
        uint128 deposit; // paid when the customer accepts (also buys days of power)
        uint128 installment; // amount that buys one `period` of power
        uint32 period; // seconds of power bought by one installment (e.g. 7 days)
        uint32 grace; // seconds the kit stays on after the paid period runs out
        uint32 repossessAfter; // seconds overdue before the installer may repossess
        bool requireKyc; // customer must be verified in ImoleKYC
    }

    struct Plan {
        uint256 kitId;
        address installer;
        address customer;
        Terms terms;
        uint64 startedAt;
        uint64 paidUntil;
        uint128 totalPaid;
        Status status;
    }

    struct Specs {
        uint32 panelWatts;
        uint32 batteryWh;
        uint32 inverterVA;
        string location;
    }

    // ------------------------------------------------------------------ storage

    IERC20 public immutable qusdc;
    uint8 public immutable qusdcDecimals;
    IAggregatorV3 public immutable qieUsdFeed;
    IQieDexRouter public immutable router;
    ImoleKYC public immutable kyc;

    address public treasury;
    uint16 public feeBps = 100; // 1% protocol fee on every payment
    uint16 public constant MAX_FEE_BPS = 500;
    uint32 public maxOracleAge = 1 days;
    uint16 public maxSwapDeviationBps = 300; // swap must return within 3% of the oracle price

    uint256 public nextKitId = 1;
    uint256 public nextPlanId = 1;

    mapping(address => Installer) public installers;
    mapping(uint256 => Kit) public kits;
    mapping(uint256 => Plan) internal _plans;
    mapping(address => uint256[]) internal _plansOfCustomer;
    mapping(address => uint256[]) internal _plansOfInstaller;

    // traction counters, readable by anyone
    uint256 public totalVolume; // QUSDC paid through Imole
    uint256 public paymentCount;
    uint256 public uniquePayers;
    uint256 public kitsPaidOff;
    mapping(address => bool) public hasPaid;

    // ------------------------------------------------------------------ events

    event InstallerRegistered(address indexed installer, string name);
    event InstallerVerified(address indexed installer, bool verified);
    event KitListed(uint256 indexed kitId, uint256 indexed planId, address indexed installer, address customer);
    event PlanAccepted(uint256 indexed planId, address indexed customer);
    event PlanCancelled(uint256 indexed planId);
    event Payment(
        uint256 indexed planId, address indexed payer, uint256 amount, uint256 fee, uint64 paidUntil, bool viaQIE
    );
    event PaidOff(uint256 indexed planId, uint256 indexed kitId, address indexed customer);
    event Repossessed(uint256 indexed planId, uint256 indexed kitId, address indexed installer);
    event TreasurySet(address treasury);
    event FeeSet(uint16 feeBps);
    event OracleGuardSet(uint32 maxAge, uint16 maxDeviationBps);

    // ------------------------------------------------------------------ errors

    error NotInstaller();
    error AlreadyRegistered();
    error BadTerms();
    error NotYourKit();
    error KitBusy();
    error WrongStatus(Status status);
    error NotCustomer();
    error NotVerified();
    error ZeroAmount();
    error NotOverdue(uint256 overdueAt);
    error StaleOracle();
    error BadOraclePrice();
    error SwapBelowOracle(uint256 got, uint256 floor);
    error FeeTooHigh();

    // ------------------------------------------------------------------ setup

    constructor(
        address initialOwner,
        address treasury_,
        IERC20 qusdc_,
        IAggregatorV3 qieUsdFeed_,
        IQieDexRouter router_,
        ImoleKYC kyc_
    ) ERC721("Imole Solar Kit", "IMOLE") Ownable(initialOwner) {
        treasury = treasury_;
        qusdc = qusdc_;
        qusdcDecimals = IERC20Metadata(address(qusdc_)).decimals();
        qieUsdFeed = qieUsdFeed_;
        router = router_;
        kyc = kyc_;
    }

    function setTreasury(address t) external onlyOwner {
        treasury = t;
        emit TreasurySet(t);
    }

    function setFee(uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = bps;
        emit FeeSet(bps);
    }

    function setOracleGuard(uint32 maxAge, uint16 maxDeviationBps) external onlyOwner {
        maxOracleAge = maxAge;
        maxSwapDeviationBps = maxDeviationBps;
        emit OracleGuardSet(maxAge, maxDeviationBps);
    }

    function setInstallerVerified(address installer, bool verified) external onlyOwner {
        if (!installers[installer].registered) revert NotInstaller();
        installers[installer].verified = verified;
        emit InstallerVerified(installer, verified);
    }

    // ------------------------------------------------------------------ installers

    function registerInstaller(string calldata name) external {
        if (installers[msg.sender].registered) revert AlreadyRegistered();
        installers[msg.sender].registered = true;
        installers[msg.sender].name = name;
        emit InstallerRegistered(msg.sender, name);
    }

    /// @notice List a newly installed kit for a customer. Mints the kit NFT into escrow.
    function listKit(address customer, Specs calldata specs, Terms calldata terms)
        external
        returns (uint256 kitId, uint256 planId)
    {
        if (!installers[msg.sender].registered) revert NotInstaller();
        kitId = nextKitId++;
        kits[kitId] = Kit(msg.sender, specs.panelWatts, specs.batteryWh, specs.inverterVA, specs.location, 0);
        _mint(address(this), kitId);
        planId = _openPlan(kitId, customer, terms);
    }

    /// @notice Offer a kit the installer already holds (e.g. after repossession) to a new customer.
    function relistKit(uint256 kitId, address customer, Terms calldata terms) external returns (uint256 planId) {
        if (ownerOf(kitId) != msg.sender || kits[kitId].installer != msg.sender) revert NotYourKit();
        _transfer(msg.sender, address(this), kitId);
        planId = _openPlan(kitId, customer, terms);
    }

    function cancelPlan(uint256 planId) external {
        Plan storage p = _plans[planId];
        if (p.installer != msg.sender) revert NotInstaller();
        if (p.status != Status.Pending) revert WrongStatus(p.status);
        p.status = Status.Cancelled;
        _transfer(address(this), msg.sender, p.kitId);
        emit PlanCancelled(planId);
    }

    /// @notice Take the kit back after the customer has been overdue for `repossessAfter`.
    function repossess(uint256 planId) external {
        Plan storage p = _plans[planId];
        if (p.installer != msg.sender) revert NotInstaller();
        if (p.status != Status.Active) revert WrongStatus(p.status);
        uint256 overdueAt = uint256(p.paidUntil) + p.terms.repossessAfter;
        if (block.timestamp <= overdueAt) revert NotOverdue(overdueAt);
        p.status = Status.Repossessed;
        _transfer(address(this), p.installer, p.kitId);
        emit Repossessed(planId, p.kitId, p.installer);
    }

    // ------------------------------------------------------------------ customers

    /// @notice Customer accepts the installer's terms and pays the deposit in QUSDC.
    function acceptPlan(uint256 planId) external nonReentrant {
        Plan storage p = _plans[planId];
        if (p.status != Status.Pending) revert WrongStatus(p.status);
        if (msg.sender != p.customer) revert NotCustomer();
        if (p.terms.requireKyc && !kyc.isVerified(msg.sender)) revert NotVerified();
        p.status = Status.Active;
        p.startedAt = uint64(block.timestamp);
        p.paidUntil = uint64(block.timestamp);
        emit PlanAccepted(planId, msg.sender);
        if (p.terms.deposit > 0) {
            _credit(planId, p, msg.sender, p.terms.deposit, false);
        }
    }

    /// @notice Pay toward a plan in QUSDC. Anyone may pay for anyone.
    ///         Amounts above what is left on the plan are not taken.
    function pay(uint256 planId, uint256 amount) external nonReentrant {
        Plan storage p = _plans[planId];
        if (p.status != Status.Active) revert WrongStatus(p.status);
        if (amount == 0) revert ZeroAmount();
        uint256 remaining = p.terms.price - p.totalPaid;
        if (amount > remaining) amount = remaining;
        _credit(planId, p, msg.sender, amount, false);
    }

    /// @notice Pay toward a plan in native QIE. The QIE is swapped to QUSDC on QIEDEX
    ///         and the result is checked against the official QIE/USD oracle, so a bad
    ///         pool price cannot short the installer or overcharge the payer.
    function payWithQIE(uint256 planId, uint256 minQusdcOut, uint256 deadline) external payable nonReentrant {
        Plan storage p = _plans[planId];
        if (p.status != Status.Active) revert WrongStatus(p.status);
        if (msg.value == 0) revert ZeroAmount();

        uint256 floor = _oracleFloor(msg.value);
        if (minQusdcOut < floor) minQusdcOut = floor;

        address[] memory path = new address[](2);
        path[0] = router.WETH();
        path[1] = address(qusdc);
        uint256 before = qusdc.balanceOf(address(this));
        router.swapExactETHForTokens{value: msg.value}(minQusdcOut, path, address(this), deadline);
        uint256 got = qusdc.balanceOf(address(this)) - before;
        if (got < floor) revert SwapBelowOracle(got, floor);

        uint256 remaining = p.terms.price - p.totalPaid;
        uint256 used = got > remaining ? remaining : got;
        _credit(planId, p, msg.sender, used, true);
        if (got > used) qusdc.safeTransfer(msg.sender, got - used); // overpayment back to the payer
    }

    // ------------------------------------------------------------------ views for devices and apps

    /// @notice What the kit controller reads. True if the kit should supply power.
    function isKitActive(uint256 kitId) public view returns (bool) {
        Plan storage p = _plans[kits[kitId].currentPlan];
        if (p.status == Status.PaidOff) return true;
        if (p.status != Status.Active) return false;
        return block.timestamp <= uint256(p.paidUntil) + p.terms.grace;
    }

    /// @notice Compact status for the controller display: on/off, seconds of power left, percent paid.
    function kitStatus(uint256 kitId) external view returns (bool active, uint256 secondsLeft, uint256 percentPaid) {
        Plan storage p = _plans[kits[kitId].currentPlan];
        active = isKitActive(kitId);
        if (p.status == Status.PaidOff) return (true, type(uint256).max, 100);
        if (p.terms.price > 0) percentPaid = (uint256(p.totalPaid) * 100) / p.terms.price;
        uint256 end = uint256(p.paidUntil) + p.terms.grace;
        if (p.status == Status.Active && end > block.timestamp) secondsLeft = end - block.timestamp;
    }

    function getPlan(uint256 planId) external view returns (Plan memory) {
        return _plans[planId];
    }

    function plansOfCustomer(address customer) external view returns (uint256[] memory) {
        return _plansOfCustomer[customer];
    }

    function plansOfInstaller(address installer) external view returns (uint256[] memory) {
        return _plansOfInstaller[installer];
    }

    /// @notice Minimum QUSDC a QIE payment must return, from the oracle price less the allowed deviation.
    function oracleFloor(uint256 qieAmount) external view returns (uint256) {
        return _oracleFloor(qieAmount);
    }

    function tokenURI(uint256 kitId) public view override returns (string memory) {
        _requireOwned(kitId);
        Kit storage k = kits[kitId];
        Plan storage p = _plans[k.currentPlan];
        uint256 pct = p.terms.price == 0 ? 0 : (uint256(p.totalPaid) * 100) / p.terms.price;
        return KitArt.tokenURI(
            KitArt.Input({
                kitId: kitId,
                panelWatts: k.panelWatts,
                batteryWh: k.batteryWh,
                inverterVA: k.inverterVA,
                location: k.location,
                installerName: installers[k.installer].name,
                percentPaid: pct,
                active: isKitActive(kitId),
                owned: p.status == Status.PaidOff
            })
        );
    }

    // ------------------------------------------------------------------ internals

    function _openPlan(uint256 kitId, address customer, Terms calldata t) internal returns (uint256 planId) {
        if (
            customer == address(0) || customer == msg.sender || t.price == 0 || t.deposit > t.price
                || t.installment == 0 || t.installment > t.price || t.period < 60 || t.repossessAfter < t.period
        ) revert BadTerms();
        Kit storage k = kits[kitId];
        Status cur = _plans[k.currentPlan].status;
        if (cur == Status.Pending || cur == Status.Active) revert KitBusy();

        planId = nextPlanId++;
        Plan storage p = _plans[planId];
        p.kitId = kitId;
        p.installer = msg.sender;
        p.customer = customer;
        p.terms = t;
        p.status = Status.Pending;
        k.currentPlan = planId;
        installers[msg.sender].plans += 1;
        _plansOfCustomer[customer].push(planId);
        _plansOfInstaller[msg.sender].push(planId);
        emit KitListed(kitId, planId, msg.sender, customer);
    }

    /// @dev When `held` is true the QUSDC is already in this contract (QIE path);
    ///      otherwise it is pulled straight from the payer to installer and treasury.
    function _credit(uint256 planId, Plan storage p, address payer, uint256 amount, bool held) internal {
        uint256 fee = (amount * feeBps) / 10_000;
        uint256 toInstaller = amount - fee;
        if (held) {
            if (fee > 0) qusdc.safeTransfer(treasury, fee);
            qusdc.safeTransfer(p.installer, toInstaller);
        } else {
            if (fee > 0) qusdc.safeTransferFrom(payer, treasury, fee);
            qusdc.safeTransferFrom(payer, p.installer, toInstaller);
        }
        _countPayer(payer);

        p.totalPaid += uint128(amount);
        uint256 base = p.paidUntil > block.timestamp ? p.paidUntil : block.timestamp;
        uint256 bought = (amount * p.terms.period) / p.terms.installment;
        p.paidUntil = uint64(base + bought);

        installers[p.installer].collected += uint128(amount);
        totalVolume += amount;
        paymentCount += 1;
        emit Payment(planId, payer, amount, fee, p.paidUntil, held);

        if (p.totalPaid >= p.terms.price) {
            p.status = Status.PaidOff;
            kitsPaidOff += 1;
            _transfer(address(this), p.customer, p.kitId);
            emit PaidOff(planId, p.kitId, p.customer);
        }
    }

    function _countPayer(address payer) internal {
        if (!hasPaid[payer]) {
            hasPaid[payer] = true;
            uniquePayers += 1;
        }
    }

    function _oracleFloor(uint256 qieAmount) internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = qieUsdFeed.latestRoundData();
        if (answer <= 0) revert BadOraclePrice();
        if (block.timestamp > updatedAt + maxOracleAge) revert StaleOracle();
        uint8 fd = qieUsdFeed.decimals();
        // qieAmount has 18 decimals; result in QUSDC base units.
        uint256 usd = (qieAmount * uint256(answer) * (10 ** qusdcDecimals)) / (10 ** (uint256(fd) + 18));
        return (usd * (10_000 - maxSwapDeviationBps)) / 10_000;
    }
}
