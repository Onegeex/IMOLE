// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IAggregatorV3, IQieDexRouter} from "../src/interfaces/IQie.sol";

contract MockQUSDC is ERC20 {
    constructor() ERC20("QUSDC", "QUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

contract MockFeed is IAggregatorV3 {
    int256 public answer = 15_000_000; // $0.15 with 8 decimals
    uint256 public updatedAt;

    constructor() {
        updatedAt = block.timestamp;
    }

    function set(int256 a, uint256 t) external {
        answer = a;
        updatedAt = t;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// @dev Pays out QUSDC at a configurable rate (QUSDC base units per 1e18 QIE).
contract MockRouter is IQieDexRouter {
    MockQUSDC public immutable token;
    address public constant WQIE = address(0xBEEF);
    uint256 public rate = 150_000; // 0.15 QUSDC per QIE

    constructor(MockQUSDC t) {
        token = t;
    }

    function setRate(uint256 r) external {
        rate = r;
    }

    function WETH() external pure returns (address) {
        return WQIE;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata) external view returns (uint256[] memory a) {
        a = new uint256[](2);
        a[0] = amountIn;
        a[1] = (amountIn * rate) / 1e18;
    }

    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata, address to, uint256 deadline)
        external
        payable
        returns (uint256[] memory a)
    {
        require(block.timestamp <= deadline, "EXPIRED");
        uint256 out = (msg.value * rate) / 1e18;
        require(out >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        token.mint(to, out);
        a = new uint256[](2);
        a[0] = msg.value;
        a[1] = out;
    }
}
