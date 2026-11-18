// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ImoleKYC
/// @notice Records that a customer's identity was verified before they are given
///         a solar kit on credit. No personal data goes on-chain: only the source
///         of the check and a hash reference to it.
/// @dev QIE Pass verification is an off-chain partner API (HMAC-signed). The Imole
///      backend acts as an attester: when QIE Pass reports a user as verified, it
///      calls `attest` with Source.QiePass and a hash of the verification id.
///      Field agents can also attest after an in-person ID check (Source.InPerson),
///      which is common for rural solar customers who do not use a crypto wallet yet.
contract ImoleKYC is Ownable {
    enum Source {
        None,
        QiePass,
        InPerson
    }

    struct Attestation {
        Source source;
        uint64 at;
        address attester;
        bytes32 ref;
    }

    mapping(address => bool) public isAttester;
    mapping(address => Attestation) public attestationOf;

    event AttesterSet(address indexed attester, bool allowed);
    event Attested(address indexed subject, Source source, address indexed attester, bytes32 ref);
    event Revoked(address indexed subject, address indexed attester);

    error NotAttester();
    error BadSource();

    constructor(address initialOwner) Ownable(initialOwner) {}

    modifier onlyAttester() {
        if (!isAttester[msg.sender]) revert NotAttester();
        _;
    }

    function setAttester(address attester, bool allowed) external onlyOwner {
        isAttester[attester] = allowed;
        emit AttesterSet(attester, allowed);
    }

    function attest(address subject, Source source, bytes32 ref) external onlyAttester {
        if (source == Source.None) revert BadSource();
        attestationOf[subject] = Attestation(source, uint64(block.timestamp), msg.sender, ref);
        emit Attested(subject, source, msg.sender, ref);
    }

    function revoke(address subject) external onlyAttester {
        delete attestationOf[subject];
        emit Revoked(subject, msg.sender);
    }

    function isVerified(address subject) external view returns (bool) {
        return attestationOf[subject].source != Source.None;
    }
}
