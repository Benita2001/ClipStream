// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "../CampaignEscrow.sol";

/// @notice Test-only helper: attempts to re-enter CampaignEscrow.release() from
/// its receive() hook when it's paid out to, to prove nonReentrant actually
/// blocks the low-level native-value call path. Not deployed anywhere real.
contract ReentrantClipper {
    CampaignEscrow public immutable escrow;

    bool private armed;
    uint256 private reentryCampaignId;
    bytes32 private reentrySettlementId;

    constructor(address _escrow) {
        escrow = CampaignEscrow(_escrow);
    }

    function armReentry(uint256 campaignId, bytes32 settlementId) external {
        armed = true;
        reentryCampaignId = campaignId;
        reentrySettlementId = settlementId;
    }

    /// @dev Triggered by CampaignEscrow.release()'s low-level `call{value: amount}("")`.
    /// The reentrant attempt is wrapped in try/catch so its expected revert
    /// (nonReentrant) doesn't bubble up and fail the legitimate transfer that
    /// invoked this hook in the first place — the test checks whether the
    /// reentrant call's effects landed (it shouldn't), not whether this
    /// function itself reverts.
    receive() external payable {
        if (armed) {
            armed = false;
            try escrow.release(reentryCampaignId, address(this), 1, reentrySettlementId) {
                // If this branch is ever reached, reentrancy protection failed.
            } catch {
                // Expected: nonReentrant causes the reentrant call to revert.
            }
        }
    }
}
