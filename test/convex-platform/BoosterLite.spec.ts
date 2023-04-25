import hre, { ethers } from "hardhat";
import { expect } from "chai";
import { BaseRewardPool__factory, BoosterLite, ERC20__factory } from "../../types/generated";
import { BigNumber, Signer } from "ethers";
import { ZERO, DEAD_ADDRESS, ZERO_ADDRESS } from "../../test-utils/constants";
import { impersonateAccount } from "../../test-utils/fork";
import { SidechainDeployed, CanonicalPhaseDeployed } from "../../scripts/deploySidechain";
import { Account } from "types";
import { DeployL2MocksResult } from "../../scripts/deploySidechainMocks";
import { increaseTime, increaseTimeTo, simpleToExactAmount } from "../../test-utils";
import { sidechainTestSetup } from "../../test/sidechain/sidechainTestSetup";

type Pool = {
    lptoken: string;
    token: string;
    gauge: string;
    crvRewards: string;
    stash: string;
    shutdown: boolean;
};

const NATIVE_FEE = simpleToExactAmount("0.2");

// ADD TESTS TO VERIFY WRONG STORAGE DUE TO BAD srcs
//  @method Booster.earmarkRewards: Error: VM Exception while processing transaction: reverted with reason string 'LayerZeroMock: not enough native for fees'
// @method BaseRewardPool.processIdleRewards():
// Error: VM Exception while processing transaction: reverted with reason string 'LayerZeroMock: not enough native for fees'
// @method BaseRewardPool.stake:
// Error: VM Exception while processing transaction: reverted with reason string 'RewardPool : Cannot stake 0'
describe("BoosterLite", () => {
    let accounts: Signer[];
    let booster: BoosterLite;
    // let mocks: DeployMocksResult;
    let pool: Pool;

    let alice: Signer;
    let aliceAddress: string;

    let l2mocks: DeployL2MocksResult;
    let deployer: Account;
    let dao: Account;

    // Sidechain Contracts
    let sidechain: SidechainDeployed;
    let canonical: CanonicalPhaseDeployed;
    const mintrMintAmount = simpleToExactAmount(1); // Rate of the MockCurveMinter.
    const setup = async () => {
        accounts = await ethers.getSigners();
        const testSetup = await sidechainTestSetup(hre, accounts);
        deployer = testSetup.deployer;
        dao = await impersonateAccount(testSetup.l2.multisigs.daoMultisig);
        l2mocks = testSetup.l2.mocks;
        canonical = testSetup.l1.canonical;
        sidechain = testSetup.l2.sidechain;

        ({ booster } = sidechain);
        pool = await booster.poolInfo(0);
        // transfer LP tokens to accounts
        const balance = await l2mocks.lptoken.balanceOf(deployer.address);
        for (const account of accounts) {
            const accountAddress = await account.getAddress();
            const share = balance.div(accounts.length);
            const tx = await l2mocks.lptoken.transfer(accountAddress, share);
            await tx.wait();
        }

        alice = accounts[5];
        aliceAddress = await alice.getAddress();
    };
    async function toFeeAmount(n: BigNumber) {
        const lockIncentive = await sidechain.booster.lockIncentive();
        const stakerIncentive = await sidechain.booster.stakerIncentive();
        const platformFee = await sidechain.booster.platformFee();
        const feeDenom = await sidechain.booster.FEE_DENOMINATOR();

        const totalIncentive = lockIncentive.add(stakerIncentive).add(platformFee);
        return n.mul(totalIncentive).div(feeDenom);
    }
    describe("managing system revenue fees", async () => {
        before(async () => {
            await setup();
        });
        it("has the correct initial config", async () => {
            const lockFee = await booster.lockIncentive();
            expect(lockFee).eq(550);
            const stakerFee = await booster.stakerIncentive();
            expect(stakerFee).eq(1100);
            const callerFee = await booster.earmarkIncentive();
            expect(callerFee).eq(50);
            const platformFee = await booster.platformFee();
            expect(platformFee).eq(0);

            const feeManager = await booster.feeManager();
            expect(feeManager).eq(await dao.signer.getAddress());
        });
        it("doesn't allow just anyone to change fees", async () => {
            await expect(booster.connect(accounts[5]).setFees(1, 2, 3, 4)).to.be.revertedWith("!auth");
        });
        it("allows feeManager to set the fees", async () => {
            const tx = await booster.connect(dao.signer).setFees(500, 300, 25, 0);
            await expect(tx).to.emit(booster, "FeesUpdated").withArgs(500, 300, 25, 0);
        });
        it("enforces 40% upper bound", async () => {
            await expect(booster.connect(dao.signer).setFees(2500, 1500, 50, 0)).to.be.revertedWith(">MaxFees");

            const tx = await booster.connect(dao.signer).setFees(1500, 900, 50, 0);
            await expect(tx).to.emit(booster, "FeesUpdated").withArgs(1500, 900, 50, 0);
        });
        it("enforces bounds on each fee type", async () => {
            // lockFees 300-1500
            await expect(booster.connect(dao.signer).setFees(200, 500, 50, 0)).to.be.revertedWith("!lockFees");
            // stakerFees 300-1500
            await expect(booster.connect(dao.signer).setFees(500, 200, 50, 0)).to.be.revertedWith("!stakerFees");
            // callerFees 10-100
            await expect(booster.connect(dao.signer).setFees(500, 500, 2, 0)).to.be.revertedWith("!callerFees");
            await expect(booster.connect(dao.signer).setFees(500, 500, 110, 0)).to.be.revertedWith("!callerFees");
            // platform 0-200
            await expect(booster.connect(dao.signer).setFees(500, 500, 50, 250)).to.be.revertedWith("!platform");
        });
        it("earmark rewards sends fees to l2Coordinator's bridgeDelegate", async () => {
            await booster.connect(dao.signer).setFees(1500, 900, 50, 50);
            const bridgeDelegate = await sidechain.l2Coordinator.bridgeDelegate();
            expect(bridgeDelegate, "bridge delegate").to.not.be.eq(ZERO_ADDRESS);

            const amountOfFees = await toFeeAmount(mintrMintAmount);
            // bals before
            const balsBefore = await Promise.all([
                await l2mocks.crv.balanceOf((await booster.poolInfo(0)).crvRewards), // [0] reward pool
                await l2mocks.crv.balanceOf(aliceAddress), // [1] _callIncentive
                await l2mocks.crv.balanceOf(await booster.treasury()), // [2] platform
                await l2mocks.crv.balanceOf(bridgeDelegate), // [3] _totalIncentive
                await l2mocks.crv.balanceOf(await booster.rewards()), // [4] rewards == l2Coordinator
            ]);

            // collect the rewards
            await booster.connect(dao.signer).setTreasury(DEAD_ADDRESS);

            const feeDebtBefore = await canonical.l1Coordinator.feeDebt(l2mocks.addresses.remoteLzChainId);
            await booster.connect(alice).earmarkRewards(0, { value: NATIVE_FEE });
            const feeDebtAfter = await canonical.l1Coordinator.feeDebt(l2mocks.addresses.remoteLzChainId);

            // bals after
            const balsAfter = await Promise.all([
                await l2mocks.crv.balanceOf((await booster.poolInfo(0)).crvRewards), // reward pool
                await l2mocks.crv.balanceOf(aliceAddress), // _callIncentive
                await l2mocks.crv.balanceOf(await booster.treasury()), // platform
                await l2mocks.crv.balanceOf(bridgeDelegate), // rewards == l2Coordinator
                await l2mocks.crv.balanceOf(await booster.rewards()), // rewards == l2Coordinator
            ]);

            expect(balsAfter[0], "reward pool no changes").eq(
                balsBefore[0].add(simpleToExactAmount(1).div(10000).mul(7500)),
            );
            expect(balsAfter[1], "_callIncentive").eq(balsBefore[1].add(simpleToExactAmount(1).div(10000).mul(50)));
            expect(balsAfter[2], "platform no changes").eq(balsBefore[2]);
            expect(balsAfter[3], "_totalIncentive").eq(balsBefore[3].add(amountOfFees));
            expect(balsAfter[4], "l2Coordinator == rewards").eq(ZERO);
            expect(feeDebtAfter.sub(feeDebtBefore)).eq(amountOfFees);
        });
    });
    describe("performing core functions", async () => {
        before(async () => {
            await setup();
        });

        it("@method Booster.deposit", async () => {
            const stake = false;
            const pid = 0;
            const amount = ethers.utils.parseEther("10");
            let tx = await l2mocks.lptoken.connect(alice).approve(booster.address, amount);

            tx = await booster.connect(alice).deposit(pid, amount, stake);
            expect(tx).to.emit(booster, "Deposited").withArgs(aliceAddress, pid, amount);

            const depositToken = ERC20__factory.connect(pool.token, deployer.signer);
            const balance = await depositToken.balanceOf(aliceAddress);

            expect(balance).to.equal(amount);
        });

        it("@method BaseRewardPool.stake", async () => {
            const depositToken = ERC20__factory.connect(pool.token, alice);
            const balance = await depositToken.balanceOf(aliceAddress);
            const crvRewards = BaseRewardPool__factory.connect(pool.crvRewards, alice);

            let tx = await depositToken.approve(crvRewards.address, balance);
            await tx.wait();

            tx = await crvRewards.stake(balance);
            expect(tx).to.emit(crvRewards, "Staked").withArgs(aliceAddress, balance);

            const stakedBalance = await crvRewards.balanceOf(aliceAddress);

            expect(stakedBalance).to.equal(balance);
        });

        it("Booster.earmarkRewards sends fees to coordinator", async () => {
            await increaseTime(60 * 60 * 24);
            const deployerBalanceBefore = await l2mocks.crv.balanceOf(deployer.address);
            const rewardPoolBalanceBefore = await l2mocks.crv.balanceOf(pool.crvRewards);
            const feeDebtBefore = await canonical.l1Coordinator.feeDebt(l2mocks.addresses.remoteLzChainId);
            const bridgeDelegate = await sidechain.l2Coordinator.bridgeDelegate();
            const bridgeDelegateBalanceBefore = await l2mocks.crv.balanceOf(bridgeDelegate);

            // When earmarkRewards
            const tx = await booster.earmarkRewards(0, { value: NATIVE_FEE });
            await tx.wait();

            // Then sends
            const feeDebtAfter = await canonical.l1Coordinator.feeDebt(l2mocks.addresses.remoteLzChainId);
            const rate = await l2mocks.crvMinter.rate();
            const callIncentive = rate
                .mul(await sidechain.booster.earmarkIncentive())
                .div(await booster.FEE_DENOMINATOR());

            const totalIncentive = await toFeeAmount(rate);
            const rewards = await booster.rewards();
            const deployerBalanceAfter = await l2mocks.crv.balanceOf(deployer.address);
            const deployerBalanceDelta = deployerBalanceAfter.sub(deployerBalanceBefore);

            const rewardPoolBalanceAfter = await l2mocks.crv.balanceOf(pool.crvRewards);
            const bridgeDelegateBalanceAfter = await l2mocks.crv.balanceOf(bridgeDelegate);
            const bridgeDelegateBalanceDelta = bridgeDelegateBalanceAfter.sub(bridgeDelegateBalanceBefore);

            const rewardsBalance = await l2mocks.crv.balanceOf(rewards);
            const totalCrvBalance = rewardPoolBalanceAfter
                .sub(rewardPoolBalanceBefore)
                .add(deployerBalanceDelta)
                .add(rewardsBalance)
                .add(bridgeDelegateBalanceDelta);

            expect(feeDebtAfter.sub(feeDebtBefore), "fees sent to coordinator").eq(totalIncentive);
            expect(totalCrvBalance, "total crv balance").to.equal(rate);
            expect(deployerBalanceDelta, "call incentive").to.equal(callIncentive);
            expect(rewardPoolBalanceAfter, "crv to reward contract").to.equal(
                rate.sub(totalIncentive).sub(callIncentive),
            );
        });
        it("Get reward from BaseRewardPool", async () => {
            const claimExtras = false;

            await increaseTime(60 * 60 * 24);

            const crvRewards = BaseRewardPool__factory.connect(pool.crvRewards, alice);
            const tx = await crvRewards["getReward(address,bool)"](aliceAddress, claimExtras);
            await tx.wait();

            const crvBalance = await l2mocks.crv.balanceOf(aliceAddress);

            const balance = await crvRewards.balanceOf(aliceAddress);
            const rewardPerToken = await crvRewards.rewardPerToken();
            const expectedRewards = rewardPerToken.mul(balance).div(simpleToExactAmount(1));

            expect(expectedRewards).to.equal(crvBalance);
        });

        it("@method BaseRewardPool.processIdleRewards()", async () => {
            await l2mocks.crvMinter.setRate(1000);

            await booster.earmarkRewards(0, { value: NATIVE_FEE });
            const crvRewards = BaseRewardPool__factory.connect(pool.crvRewards, alice);

            const queuedRewards = await crvRewards.queuedRewards();
            const historicalRewards = await crvRewards.historicalRewards();
            expect(queuedRewards, "must have some queue rewards").gt(0);
            // Given that the period finish has passed
            const periodFinish = await crvRewards.periodFinish();
            await increaseTimeTo(periodFinish);
            // When processing idle rewards
            const tx = await crvRewards.processIdleRewards();
            // Then notify rewards
            await expect(tx).to.emit(crvRewards, "RewardAdded").withArgs(queuedRewards);
            // and update state
            expect(await crvRewards.historicalRewards(), "historic rewards").to.be.eq(
                historicalRewards.add(queuedRewards),
            );
            expect(await crvRewards.queuedRewards(), "queued rewards").to.be.eq(ZERO);
            expect(await crvRewards.currentRewards(), "current rewards").to.be.eq(queuedRewards);
        });
    });

    describe("edge cases", async () => {
        before(async () => {
            await setup();
        });
    });
});
