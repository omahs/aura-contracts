import { ContractTransaction, ethers, Signer } from "ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import {
    BridgeDelegateReceiver,
    BridgeDelegateReceiver__factory,
    BridgeDelegateSender,
    SimpleBridgeDelegateSender,
    SimpleBridgeDelegateSender__factory,
} from "../types";
import { deployContract } from "../tasks/utils";
import { CanonicalPhaseDeployed } from "./deploySidechain";
import { ExtSystemConfig } from "./deploySystem";

interface SimplyBridgeDelegateDeployed {
    bridgeDelegateSender: BridgeDelegateSender;
    bridgeDelegateReceiver: BridgeDelegateReceiver;
}

/**
 * Deploy simple bridge delegate used for testing
 */
export async function deploySimpleBridgeDelegates(
    hre: HardhatRuntimeEnvironment,
    config: ExtSystemConfig,
    canonical: CanonicalPhaseDeployed,
    srcChainId: number,
    deployer: Signer,
    debug: boolean = false,
    waitForBlocks: number = 0,
): Promise<SimplyBridgeDelegateDeployed> {
    const bridgeDelegateSender = await deployContract<SimpleBridgeDelegateSender>(
        hre,
        new SimpleBridgeDelegateSender__factory(deployer),
        "SimpleBridgeDelegateSender",
        [config.token],
        {},
        debug,
        waitForBlocks,
    );

    const bridgeDelegateReceiver = await deployContract<BridgeDelegateReceiver>(
        hre,
        new BridgeDelegateReceiver__factory(deployer),
        "BridgeDelegateReceiver",
        [canonical.l1Coordinator.address, srcChainId],
        {},
        debug,
        waitForBlocks,
    );

    return { bridgeDelegateSender, bridgeDelegateReceiver };
}