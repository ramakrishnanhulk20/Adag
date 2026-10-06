// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Test-only stand-ins for scripts/check-fx.mjs. Nothing here is ever deployed: the script plants the compiled code at an
// address through eth_simulateV1 state overrides. Compiled with solc 0.8.30, optimizer on at 200 runs, evm prague, the
// same settings as packages/contracts. fixtures.json holds the output and the SHA-256 of this file.

interface IToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

// Pays a fixed amount of a token from its own balance. Stands in for a conversion that delivers a chosen amount.
contract SwapStandIn {
    error TransferFailed();

    function deliver(address token, address to, uint256 amount) external {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IToken.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}

// Code that runs inside the payer's batch and tries to make Multicall3From, Memo or the CallFrom precompile move the
// payer's tokens. It reports what each attempt did instead of reverting, so the script can print the exact outcome.
contract SwapAttacker {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    function viaMulticall(address multicall, address token, address to, uint256 amount, bool allowFailure)
        external
        returns (bool outerOk, bytes memory outerData)
    {
        Call3[] memory calls = new Call3[](1);
        calls[0] = Call3(token, allowFailure, abi.encodeCall(IToken.transfer, (to, amount)));
        (outerOk, outerData) = multicall.call(abi.encodeWithSignature("aggregate3((address,bool,bytes)[])", calls));
    }

    function viaMemo(address memo, address token, address to, uint256 amount)
        external
        returns (bool outerOk, bytes memory outerData)
    {
        (outerOk, outerData) = memo.call(
            abi.encodeWithSignature(
                "memo(address,bytes,bytes32,bytes)",
                token,
                abi.encodeCall(IToken.transfer, (to, amount)),
                bytes32(uint256(1)),
                bytes("")
            )
        );
    }

    function viaCallFrom(address callFrom, address sender, address token, address to, uint256 amount)
        external
        returns (bool outerOk, bytes memory outerData)
    {
        (outerOk, outerData) = callFrom.call(
            abi.encodeWithSignature(
                "callFrom(address,address,bytes)", sender, token, abi.encodeCall(IToken.transfer, (to, amount))
            )
        );
    }
}

// Same execute signature as Circle's adapter. It takes the approved tokens and gives nothing back.
contract SinkAdapter {
    struct Instruction {
        address target;
        bytes data;
        uint256 value;
        address tokenIn;
        uint256 amountToApprove;
        address tokenOut;
        uint256 minTokenOut;
    }

    struct TokenBeneficiary {
        address token;
        address beneficiary;
    }

    struct Params {
        Instruction[] instructions;
        TokenBeneficiary[] tokens;
        uint256 execId;
        uint256 deadline;
        bytes metadata;
    }

    struct TokenInput {
        uint8 permitType;
        address token;
        uint256 amount;
        bytes permitCalldata;
    }

    error PullFailed();

    function execute(Params calldata, TokenInput[] calldata inputs, bytes calldata) external payable {
        for (uint256 i = 0; i < inputs.length; ++i) {
            (bool ok,) = inputs[i].token.call(
                abi.encodeCall(IToken.transferFrom, (msg.sender, address(this), inputs[i].amount))
            );
            if (!ok) revert PullFailed();
        }
    }
}
