import { expect } from "chai";
import { BigNumber, BigNumberish } from "ethers";
import hre, { ethers } from "hardhat";
import { deployContract } from "../../tasks/utils";
import { deployCanonicalPhase, deploySidechainSystem, SidechainDeployed } from "../../scripts/deploySidechain";
import { Phase2Deployed, Phase6Deployed } from "../../scripts/deploySystem";
import { config as mainnetConfig } from "../../tasks/deploy/mainnet-config";
import { impersonate, impersonateAccount, simpleToExactAmount, ZERO_ADDRESS } from "../../test-utils";
import {
    Account,
    AuraOFT,
    AuraProxyOFT,
    L2Coordinator,
    L1Coordinator,
    Create2Factory,
    Create2Factory__factory,
    ERC20,
    ExtraRewardStashV3__factory,
    LZEndpointMock,
    LZEndpointMock__factory,
    MockCurveMinter,
    MockCurveMinter__factory,
    MockERC20__factory,
} from "../../types";
import { SidechainConfig } from "tasks/deploy/sidechain-types";

const NATIVE_FEE = simpleToExactAmount("0.2");

describe("Sidechain", () => {
    const L1_CHAIN_ID = 111;
    const L2_CHAIN_ID = 222;
    const mintrMintAmount = simpleToExactAmount(10);

    let deployer: Account;
    let dao: Account;
    let auraWhale: Account;

    // phases
    let phase2: Phase2Deployed;
    let phase6: Phase6Deployed;
    let mockMintr: MockCurveMinter;

    // LayerZero endpoints
    let l1LzEndpoint: LZEndpointMock;
    let l2LzEndpoint: LZEndpointMock;

    // Canonical chain Contracts
    let create2Factory: Create2Factory;
    let l1Coordinator: L1Coordinator;
    let auraProxyOFT: AuraProxyOFT;
    let crv: ERC20;

    // Sidechain Contracts
    let sidechain: SidechainDeployed;
    let l2Coordinator: L2Coordinator;
    let auraOFT: AuraOFT;
    let sidechainConfig: SidechainConfig;

    /* ---------------------------------------------------------------------
     * Helper Functions
     * --------------------------------------------------------------------- */

    async function getEth(recipient: string) {
        const ethWhale = await impersonate(mainnetConfig.addresses.weth);
        await ethWhale.sendTransaction({
            to: recipient,
            value: simpleToExactAmount(1),
        });
    }

    async function getBal(to: string, amount: BigNumberish) {
        await getEth(mainnetConfig.addresses.balancerVault);
        const tokenWhaleSigner = await impersonateAccount(mainnetConfig.addresses.balancerVault);
        await crv.connect(tokenWhaleSigner.signer).transfer(to, amount);
    }

    async function withMockMinter(fn: () => Promise<void>) {
        // Update the mintr slot of voter proxy to be our mock mintr
        const original = await hre.network.provider.send("eth_getStorageAt", [sidechain.voterProxy.address, "0x0"]);
        const newSlot = "0x" + mockMintr.address.slice(2).padStart(64, "0");
        await getBal(mockMintr.address, mintrMintAmount);
        expect(await crv.balanceOf(mockMintr.address)).eq(mintrMintAmount);

        await hre.network.provider.send("hardhat_setStorageAt", [sidechain.voterProxy.address, "0x0", newSlot]);
        await fn();
        await hre.network.provider.send("hardhat_setStorageAt", [sidechain.voterProxy.address, "0x0", original]);
    }

    async function toFeeAmount(n: BigNumber) {
        const lockIncentive = await sidechain.booster.lockIncentive();
        const stakerIncentive = await sidechain.booster.stakerIncentive();
        const platformFee = await sidechain.booster.platformFee();
        const feeDenom = await sidechain.booster.FEE_DENOMINATOR();

        const totalIncentive = lockIncentive.add(stakerIncentive).add(platformFee);
        return n.mul(totalIncentive).div(feeDenom);
    }

    before(async () => {
        const accounts = await ethers.getSigners();
        deployer = await impersonateAccount(await accounts[0].getAddress());
        dao = await impersonateAccount(mainnetConfig.multisigs.daoMultisig);
        auraWhale = await impersonateAccount(mainnetConfig.addresses.balancerVault, true);

        phase2 = await mainnetConfig.getPhase2(deployer.signer);
        phase6 = await mainnetConfig.getPhase6(deployer.signer);

        // Deploy mocks
        crv = MockERC20__factory.connect(mainnetConfig.addresses.token, deployer.signer);
        mockMintr = await deployContract<MockCurveMinter>(
            hre,
            new MockCurveMinter__factory(deployer.signer),
            "MockCurveMinter",
            [mainnetConfig.addresses.token, mintrMintAmount],
            {},
            false,
        );

        // deploy layerzero mocks
        l1LzEndpoint = await new LZEndpointMock__factory(deployer.signer).deploy(L1_CHAIN_ID);
        l2LzEndpoint = await new LZEndpointMock__factory(deployer.signer).deploy(L2_CHAIN_ID);

        // deploy Create2Factory
        create2Factory = await new Create2Factory__factory(deployer.signer).deploy();
        await create2Factory.updateDeployer(deployer.address, true);

        // setup sidechain config
        sidechainConfig = {
            addresses: {
                lzEndpoint: l2LzEndpoint.address,
                daoMultisig: dao.address,
                create2Factory: create2Factory.address,
                token: mainnetConfig.addresses.token,
                minter: mainnetConfig.addresses.minter,
            },
            naming: { coordinatorName: "Aura", coordinatorSymbol: "AURA", tokenFactoryNamePostfix: " Aura Deposit" },
            extConfig: { canonicalChainId: L1_CHAIN_ID },
        };

        // deploy canonicalPhase
        const canonicalPhase = await deployCanonicalPhase(
            hre,
            { ...mainnetConfig.addresses, lzEndpoint: l1LzEndpoint.address },
            phase2,
            phase6,
            deployer.signer,
        );

        l1Coordinator = canonicalPhase.l1Coordinator;
        auraProxyOFT = canonicalPhase.auraProxyOFT;

        // deploy sidechain
        sidechain = await deploySidechainSystem(
            hre,
            sidechainConfig.naming,
            sidechainConfig.addresses,
            sidechainConfig.extConfig,
            deployer.signer,
        );

        l2Coordinator = sidechain.l2Coordinator;
        auraOFT = sidechain.auraOFT;
    });

    describe("Check configs", () => {
        it("VotingProxy has correct config", async () => {
            const { addresses } = sidechainConfig;

            expect(await sidechain.voterProxy.mintr()).eq(addresses.minter);
            expect(await sidechain.voterProxy.crv()).eq(addresses.token);
            expect(await sidechain.voterProxy.rewardDeposit()).eq(ZERO_ADDRESS);
            expect(await sidechain.voterProxy.withdrawer()).eq(ZERO_ADDRESS);
            expect(await sidechain.voterProxy.owner()).eq(dao.address);
            expect(await sidechain.voterProxy.operator()).eq(sidechain.booster.address);
        });
        it("AuraOFT has correct config", async () => {
            expect(await auraOFT.name()).eq(sidechainConfig.naming.coordinatorName);
            expect(await auraOFT.symbol()).eq(sidechainConfig.naming.coordinatorSymbol);
            expect(await auraOFT.lzEndpoint()).eq(l2LzEndpoint.address);
        });
        it("L2Coordinator has correct config", async () => {
            expect(await l2Coordinator.canonicalChainId()).eq(L1_CHAIN_ID);
            expect(await l2Coordinator.booster()).eq(sidechain.booster.address);
            expect(await l2Coordinator.mintRate()).eq(0);
            expect(await l2Coordinator.lzEndpoint()).eq(l2LzEndpoint.address);
        });
        it("L1Coordinator has correct config", async () => {
            expect(await l1Coordinator.booster()).eq(phase6.booster.address);
            expect(await l1Coordinator.lzEndpoint()).eq(l1LzEndpoint.address);
        });
        it("AuraProxyOFT has correct config", async () => {
            expect(await auraProxyOFT.lzEndpoint()).eq(l1LzEndpoint.address);
            expect(await auraProxyOFT.token()).eq(phase2.cvx.address);
        });
        it("BoosterLite has correct config", async () => {
            expect(await sidechain.booster.crv()).eq(sidechainConfig.addresses.token);

            expect(await sidechain.booster.lockIncentive()).eq(550);
            expect(await sidechain.booster.stakerIncentive()).eq(1100);
            expect(await sidechain.booster.earmarkIncentive()).eq(50);
            expect(await sidechain.booster.platformFee()).eq(0);
            expect(await sidechain.booster.MaxFees()).eq(4000);
            expect(await sidechain.booster.FEE_DENOMINATOR()).eq(10000);

            expect(await sidechain.booster.owner()).eq(sidechain.boosterOwner.address);
            expect(await sidechain.booster.feeManager()).eq(dao.address);
            expect(await sidechain.booster.poolManager()).eq(sidechain.poolManager.address);
            expect(await sidechain.booster.staker()).eq(sidechain.voterProxy.address);
            expect(await sidechain.booster.minter()).eq(l2Coordinator.address);
            expect(await sidechain.booster.rewardFactory()).eq(sidechain.factories.rewardFactory.address);
            expect(await sidechain.booster.stashFactory()).eq(sidechain.factories.stashFactory.address);
            expect(await sidechain.booster.tokenFactory()).eq(sidechain.factories.tokenFactory.address);
            expect(await sidechain.booster.treasury()).eq(ZERO_ADDRESS);

            expect(await sidechain.booster.isShutdown()).eq(false);
            expect(await sidechain.booster.poolLength()).eq(0);
        });
        it("Booster Owner has correct config", async () => {
            expect(await sidechain.boosterOwner.poolManager()).eq(sidechain.poolManager.address);
            expect(await sidechain.boosterOwner.booster()).eq(sidechain.booster.address);
            expect(await sidechain.boosterOwner.stashFactory()).eq(sidechain.factories.stashFactory.address);
            expect(await sidechain.boosterOwner.rescueStash()).eq(ZERO_ADDRESS);
            expect(await sidechain.boosterOwner.owner()).eq(dao.address);
            expect(await sidechain.boosterOwner.pendingowner()).eq(ZERO_ADDRESS);
            expect(await sidechain.boosterOwner.isSealed()).eq(true);
            expect(await sidechain.boosterOwner.isForceTimerStarted()).eq(false);
            expect(await sidechain.boosterOwner.forceTimestamp()).eq(0);
        });
        it("factories have correct config", async () => {
            const {
                booster,
                factories: { rewardFactory, stashFactory, tokenFactory, proxyFactory },
            } = sidechain;

            const { addresses } = sidechainConfig;

            expect(await rewardFactory.operator()).eq(booster.address);
            expect(await rewardFactory.crv()).eq(addresses.token);

            expect(await stashFactory.operator()).eq(booster.address);
            expect(await stashFactory.rewardFactory()).eq(rewardFactory.address);
            expect(await stashFactory.proxyFactory()).eq(proxyFactory.address);
            expect(await stashFactory.v1Implementation()).eq(ZERO_ADDRESS);
            expect(await stashFactory.v2Implementation()).eq(ZERO_ADDRESS);

            const rewardsStashV3 = ExtraRewardStashV3__factory.connect(
                await stashFactory.v3Implementation(),
                deployer.signer,
            );
            expect(await rewardsStashV3.crv()).eq(addresses.token);

            expect(await tokenFactory.operator()).eq(booster.address);
            expect(await tokenFactory.namePostfix()).eq(sidechainConfig.naming.tokenFactoryNamePostfix);
            expect(await tokenFactory.symbolPrefix()).eq("aura");
        });
        it("poolManager has correct config", async () => {
            const { booster, poolManager } = sidechain;
            expect(await poolManager.booster()).eq(booster.address);
            expect(await poolManager.operator()).eq(dao.address);
            expect(await poolManager.protectAddPool()).eq(true);
        });
    });

    describe("Setup: Protocol DAO transactions", () => {
        it("set auraOFT as booster bridge delegate", async () => {
            expect(await phase6.booster.bridgeDelegate()).not.eq(l1Coordinator.address);
            await phase6.booster.connect(dao.signer).setBridgeDelegate(l1Coordinator.address);
            expect(await phase6.booster.bridgeDelegate()).eq(l1Coordinator.address);
        });
        it("add trusted remotes to layerzero endpoints", async () => {
            // L1 Stuff
            await l1Coordinator.setTrustedRemote(
                L2_CHAIN_ID,
                hre.ethers.utils.solidityPack(["address", "address"], [l2Coordinator.address, l1Coordinator.address]),
            );
            await auraProxyOFT.setTrustedRemote(
                L2_CHAIN_ID,
                hre.ethers.utils.solidityPack(["address", "address"], [auraOFT.address, auraProxyOFT.address]),
            );

            await l1LzEndpoint.setDestLzEndpoint(l2Coordinator.address, l2LzEndpoint.address);
            await l1LzEndpoint.setDestLzEndpoint(auraOFT.address, l2LzEndpoint.address);

            // L2 Stuff
            await l2Coordinator.setTrustedRemote(
                L1_CHAIN_ID,
                hre.ethers.utils.solidityPack(["address", "address"], [l1Coordinator.address, l2Coordinator.address]),
            );
            await auraOFT.setTrustedRemote(
                L1_CHAIN_ID,
                hre.ethers.utils.solidityPack(["address", "address"], [auraProxyOFT.address, auraOFT.address]),
            );

            await l2LzEndpoint.setDestLzEndpoint(l1Coordinator.address, l1LzEndpoint.address);
            await l2LzEndpoint.setDestLzEndpoint(auraProxyOFT.address, l1LzEndpoint.address);
        });
        it("add pools to the booster", async () => {
            // As this test suite is running the bridge from L1 -> L1 forked on
            // mainnet. We can just add the first 10 active existing Aura pools
            let i = 0;
            while ((await sidechain.booster.poolLength()).lt(10)) {
                const poolInfo = await phase6.booster.poolInfo(i);
                if (!poolInfo.shutdown) {
                    await sidechain.poolManager.connect(dao.signer)["addPool(address)"](poolInfo.gauge);
                }
                i++;
            }
            expect(await sidechain.booster.poolLength()).eq(10);
        });
        it("fund the L1Coordinator with a BAL float", async () => {
            const floatAmount = simpleToExactAmount(10_000);
            await getBal(l1Coordinator.address, floatAmount);
        });
        it("Set l2Coordinator on l1Coordinator", async () => {
            expect(await l1Coordinator.l2Coordinators(L2_CHAIN_ID)).not.to.eq(l2Coordinator.address);
            await l1Coordinator.setL2Coordinator(L2_CHAIN_ID, l2Coordinator.address);
            expect(await l1Coordinator.l2Coordinators(L2_CHAIN_ID)).to.eq(l2Coordinator.address);
        });
    });

    describe("Bridge AURA normally", () => {
        const bridgeAmount = simpleToExactAmount(101);
        it("bridge AURA from L1 -> L2", async () => {
            const balBefore = await phase2.cvx.balanceOf(auraWhale.address);
            const l2BalBefore = await auraOFT.balanceOf(deployer.address);
            expect(balBefore).gt(bridgeAmount);

            await phase2.cvx.connect(auraWhale.signer).approve(auraProxyOFT.address, bridgeAmount);
            expect(await phase2.cvx.allowance(auraWhale.address, auraProxyOFT.address)).gte(bridgeAmount);

            await auraProxyOFT
                .connect(auraWhale.signer)
                .sendFrom(
                    auraWhale.address,
                    L2_CHAIN_ID,
                    deployer.address,
                    bridgeAmount,
                    ZERO_ADDRESS,
                    ZERO_ADDRESS,
                    [],
                    {
                        value: NATIVE_FEE,
                    },
                );

            const balAfter = await phase2.cvx.balanceOf(auraWhale.address);
            const l2BalAfter = await auraOFT.balanceOf(deployer.address);
            expect(balBefore.sub(balAfter)).eq(bridgeAmount);
            expect(l2BalAfter.sub(l2BalBefore)).eq(bridgeAmount);
        });
        it("bridge AURA from L2 -> L1", async () => {
            const balBefore = await auraOFT.balanceOf(deployer.address);
            const l2BalBefore = await phase2.cvx.balanceOf(auraWhale.address);
            expect(balBefore).gte(bridgeAmount);

            await auraOFT.sendFrom(
                deployer.address,
                L1_CHAIN_ID,
                auraWhale.address,
                bridgeAmount,
                ZERO_ADDRESS,
                ZERO_ADDRESS,
                [],
                {
                    value: NATIVE_FEE,
                },
            );

            const balAfter = await auraOFT.balanceOf(deployer.address);
            const l2BalAfter = await phase2.cvx.balanceOf(auraWhale.address);
            expect(balBefore.sub(balAfter)).eq(bridgeAmount);
            expect(l2BalAfter.sub(l2BalBefore)).eq(bridgeAmount);
        });
    });

    describe("Lock AURA", () => {
        const lockAmount = simpleToExactAmount(10);
        before(async () => {
            // Transfer some AURA to L2
            await phase2.cvx.connect(auraWhale.signer).approve(auraProxyOFT.address, lockAmount);
            await auraProxyOFT
                .connect(auraWhale.signer)
                .sendFrom(
                    auraWhale.address,
                    L2_CHAIN_ID,
                    deployer.address,
                    lockAmount,
                    ZERO_ADDRESS,
                    ZERO_ADDRESS,
                    [],
                    {
                        value: NATIVE_FEE,
                    },
                );
        });
        it("lock AURA from L2 -> L1", async () => {
            const balancesBefore = await phase2.cvxLocker.balances(deployer.address);
            await auraOFT.lock(lockAmount, { value: NATIVE_FEE });
            const balancesAfter = await phase2.cvxLocker.balances(deployer.address);
            expect(balancesAfter.locked.sub(balancesBefore.locked)).eq(lockAmount);
        });
    });

    describe('Earmark rewards on L2 "mints" (transfers) AURA', () => {
        it("earmark rewards sends fees to coordinator", async () => {
            const coordinatorBalBefore = await crv.balanceOf(l2Coordinator.address);
            const feeDebtBefore = await l1Coordinator.feeDebt(L2_CHAIN_ID);
            await withMockMinter(async () => {
                await sidechain.booster.earmarkRewards(0, {
                    value: NATIVE_FEE,
                });
            });
            const coordinatorBalAfter = await crv.balanceOf(l2Coordinator.address);
            const feeDebtAfter = await l1Coordinator.feeDebt(L2_CHAIN_ID);
            const amountOfFees = await toFeeAmount(mintrMintAmount);

            expect(coordinatorBalAfter.sub(coordinatorBalBefore)).eq(amountOfFees);
            expect(feeDebtAfter.sub(feeDebtBefore)).eq(amountOfFees);

            const coordinatorAuraBalBefore = await auraOFT.balanceOf(l2Coordinator.address);
            expect(await l2Coordinator.mintRate()).eq(0);
            await l1Coordinator.distributeAura(L2_CHAIN_ID, { value: NATIVE_FEE.mul(2) });
            const coordinatorAuraBalAfter = await auraOFT.balanceOf(l2Coordinator.address);
            expect(await l2Coordinator.mintRate()).not.eq(0);
            expect(coordinatorAuraBalAfter).gt(coordinatorAuraBalBefore);
        });
    });

    describe("Settle fee debt from L2 -> L1", () => {
        let bridgeDelegate: Account;
        before(async () => {
            const accounts = await ethers.getSigners();
            bridgeDelegate = await impersonateAccount(await accounts[3].getAddress());
            await getBal(bridgeDelegate.address, simpleToExactAmount(10_000));
        });
        it("set bridge delegate for L2", async () => {
            expect(await l1Coordinator.bridgeDelegates(L2_CHAIN_ID)).eq(ZERO_ADDRESS);
            await l1Coordinator.setBridgeDelegate(L2_CHAIN_ID, bridgeDelegate.address);
            expect(await l1Coordinator.bridgeDelegates(L2_CHAIN_ID)).eq(bridgeDelegate.address);
        });
        it("settle fees updated feeDebt on L1", async () => {
            const debt = await l1Coordinator.feeDebt(L2_CHAIN_ID);
            expect(debt).gt(0);

            await crv.connect(bridgeDelegate.signer).approve(l1Coordinator.address, debt);
            await l1Coordinator.connect(bridgeDelegate.signer).settleFeeDebt(L2_CHAIN_ID, debt);

            const newDebt = await l1Coordinator.feeDebt(L2_CHAIN_ID);
            expect(newDebt).eq(0);
        });
    });
});
