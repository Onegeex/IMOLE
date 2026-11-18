// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title KitArt
/// @notice Fully on-chain metadata for an Imole kit. The image changes with the kit's
///         state: a lit sun while powered, a grey sun when locked, a gold ring once owned.
library KitArt {
    using Strings for uint256;

    struct Input {
        uint256 kitId;
        uint32 panelWatts;
        uint32 batteryWh;
        uint32 inverterVA;
        string location;
        string installerName;
        uint256 percentPaid;
        bool active;
        bool owned;
    }

    function tokenURI(Input memory i) internal pure returns (string memory) {
        string memory state = i.owned ? "Owned" : (i.active ? "Powered" : "Locked");
        string memory head = string.concat(
            '{"name":"Imole Kit #',
            i.kitId.toString(),
            '","description":"A pay-as-you-go solar kit financed on QIE. Power stays on while payments are up to date; the kit belongs to the customer once fully paid.","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(_svg(i, state))),
            '","attributes":['
        );
        string memory json = string.concat(head, _attrs(i, state), "]}");
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function _attrs(Input memory i, string memory state) private pure returns (string memory) {
        string memory a = string.concat(
            _attr("State", state, true),
            _num("Paid %", i.percentPaid),
            _num("Panel W", i.panelWatts),
            _num("Battery Wh", i.batteryWh)
        );
        return string.concat(
            a,
            _num("Inverter VA", i.inverterVA),
            _attr("Location", _clean(i.location), true),
            _attr("Installer", _clean(i.installerName), false)
        );
    }

    function _svg(Input memory i, string memory state) private pure returns (string memory) {
        string memory sun = i.owned ? "#F5B301" : (i.active ? "#FFC83D" : "#8A8F98");
        string memory bg = i.active || i.owned ? "#0E2A47" : "#1C1F24";
        uint256 bar = (i.percentPaid > 100 ? 100 : i.percentPaid) * 2;
        string memory top = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="',
            bg,
            '"/><circle cx="150" cy="115" r="52" fill="',
            sun,
            '"/>',
            i.owned ? '<circle cx="150" cy="115" r="66" fill="none" stroke="#F5B301" stroke-width="4"/>' : ""
        );
        string memory mid = string.concat(
            '<rect x="50" y="205" width="200" height="12" rx="6" fill="#2E3440"/><rect x="50" y="205" width="',
            bar.toString(),
            '" height="12" rx="6" fill="',
            sun,
            '"/>'
        );
        return string.concat(
            top,
            mid,
            '<text x="150" y="250" font-family="sans-serif" font-size="18" fill="#fff" text-anchor="middle">Kit #',
            i.kitId.toString(),
            " - ",
            state,
            '</text><text x="150" y="275" font-family="sans-serif" font-size="13" fill="#B8C0CC" text-anchor="middle">',
            i.percentPaid.toString(),
            "% paid</text></svg>"
        );
    }

    function _attr(string memory k, string memory v, bool comma) private pure returns (string memory) {
        return string.concat('{"trait_type":"', k, '","value":"', v, comma ? '"},' : '"}');
    }

    function _num(string memory k, uint256 v) private pure returns (string memory) {
        return string.concat('{"trait_type":"', k, '","value":', v.toString(), "},");
    }

    /// @dev Strip characters that would break the JSON or SVG.
    function _clean(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        for (uint256 j = 0; j < b.length; j++) {
            bytes1 c = b[j];
            if (c == '"' || c == "\\" || c == "<" || c == ">" || c == "&" || uint8(c) < 0x20) b[j] = "_";
        }
        return string(b);
    }
}
