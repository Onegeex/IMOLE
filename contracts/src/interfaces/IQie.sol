// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice QIE Oracle feeds expose the Chainlink AggregatorV3 read interface.
/// Official QIE/USD feed on mainnet: 0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Subset of the QIEDEX (Uniswap V2 style) router.
/// QIEDEX router on mainnet: 0x08cd2e72e156D8563B4351eb4065C262A9f553Ef
interface IQieDexRouter {
    function WETH() external view returns (address);

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);

    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        returns (uint256[] memory amounts);
}
