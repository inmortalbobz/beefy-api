import { MultiCall } from 'eth-multicall';
const { ethereumWeb3: web3 } = require('../../../utils/web3');
import getApyBreakdown from '../common/getApyBreakdown';
const BigNumber = require('bignumber.js');

const IAuraToken = require('../../../abis/ethereum/AuraToken.json');
const IAuraGauge = require('../../../abis/ethereum/AuraGauge.json');
import { multicallAddress } from '../../../utils/web3';
const { ETH_CHAIN_ID: chainId } = require('../../../constants');
import { balancerClient } from '../../../apollo/client';
const fetchPrice = require('../../../utils/fetchPrice');

const { getTradingFeeAprBalancer } = require('../../../utils/getTradingFeeApr');
import { addressBook } from '../../../../packages/address-book/address-book';
import { getEDecimals } from '../../../utils/getEDecimals';

const { getContractWithProvider } = require('../../../utils/contractHelper');
const {
  ethereum: {
    tokens: { AURA, BAL },
  },
} = addressBook;

const pools = require('../../../data/ethereum/auraBalancerLpPools.json');

const liquidityProviderFee = 0.0025;
const secondsInAYear = 31536000;

const getAuraApys = async () => {
  const pairAddresses = pools.map(pool => pool.address);
  const tradingAprs = await getTradingFeeAprBalancer(
    balancerClient,
    pairAddresses,
    liquidityProviderFee,
    chainId
  );
  // console.log(tradingAprs);

  const farmApys = await getPoolApys(pools);
  const poolsMap = pools.map(p => ({ name: p.name, address: p.address }));
  return getApyBreakdown(poolsMap, tradingAprs, farmApys, liquidityProviderFee);
};

const getPoolApys = async pools => {
  const apys = [];

  const auraData = await getAuraData();

  let promises = [];
  pools.forEach(pool => promises.push(getPoolApy(pool, auraData)));
  const values = await Promise.all(promises);
  values.forEach(item => apys.push(item));

  return apys;
};

const getPoolApy = async (pool, auraData) => {
  if (pool.status === 'eol') return new BigNumber(0);

  const [yearlyRewardsInUsd, totalStakedInUsd] = await Promise.all([
    getYearlyRewardsInUsd(auraData, pool),
    getTotalStakedInUsd(pool),
  ]);

  const rewardsApy = yearlyRewardsInUsd.dividedBy(totalStakedInUsd);
  // console.log(pool.name,rewardsApy.toNumber(),totalStakedInUsd.valueOf(),yearlyRewardsInUsd.valueOf());
  return rewardsApy;
};

const getYearlyRewardsInUsd = async (auraData, pool) => {
  const auraGauge = getContractWithProvider(IAuraGauge, pool.gauge, web3);
  const rewardRate = new BigNumber(await auraGauge.methods.rewardRate().call());
  const balPrice = await fetchPrice({ oracle: 'tokens', id: BAL.symbol });
  const yearlyRewards = rewardRate.times(secondsInAYear);
  const yearlyRewardsInUsd = yearlyRewards
    .times(balPrice)
    .dividedBy(await getEDecimals(BAL.decimals));
  let amount = yearlyRewards.times(auraData[0]).dividedBy(auraData[1]);
  // e.g. amtTillMax = 5e25 - 1e25 = 4e25

  if (amount > auraData[2]) {
    amount = auraData[2];
  }

  const auraPrice = await fetchPrice({ oracle: 'tokens', id: AURA.symbol });
  const auraYearlyRewardsInUsd = amount
    .times(auraPrice)
    .dividedBy(await getEDecimals(AURA.decimals));
  // console.log(auraYearlyRewardsInUsd.valueOf(), yearlyRewardsInUsd.valueOf());
  return yearlyRewardsInUsd.plus(auraYearlyRewardsInUsd);
};

const getTotalStakedInUsd = async pool => {
  const gauge = getContractWithProvider(IAuraGauge, pool.gauge, web3);
  const totalSupply = new BigNumber(await gauge.methods.totalSupply().call());
  const lpPrice = await fetchPrice({ oracle: 'lps', id: pool.name });
  return totalSupply.multipliedBy(lpPrice).dividedBy('1e18');
};

const getAuraData = async () => {
  const multicall = new MultiCall(web3, multicallAddress(chainId));
  const auraContract = getContractWithProvider(IAuraToken, AURA.address, web3);

  let totalSupplyCalls = [];
  let maxSupplyCalls = [];
  let reductionPerCliffCalls = [];
  let totalCliffsCalls = [];

  totalSupplyCalls.push({ totalSupply: auraContract.methods.totalSupply() });
  maxSupplyCalls.push({ maxSupply: auraContract.methods.EMISSIONS_MAX_SUPPLY() });
  reductionPerCliffCalls.push({ reductionPerCliff: auraContract.methods.reductionPerCliff() });
  totalCliffsCalls.push({ totalCliffs: auraContract.methods.totalCliffs() });

  const res = await multicall.all([
    totalSupplyCalls,
    maxSupplyCalls,
    reductionPerCliffCalls,
    totalCliffsCalls,
  ]);

  let total = new BigNumber(0);
  total = new BigNumber(res[0].map(v => v.totalSupply));
  const max = new BigNumber(res[1].map(v => v.maxSupply));
  const cliffs = new BigNumber(res[2].map(v => v.reductionPerCliff));
  const totalCliff = new BigNumber(res[3].map(v => v.totalCliffs));

  let premint = new BigNumber('5e25');
  // console.log(total.toNumber(), premint.toNumber(), max.toNumber(), cliffs.toNumber(), totalCliff.toNumber())
  // e.g. emissionsMinted = 6e25 - 5e25 - 0 = 1e25;
  const emissionsMinted = total.minus(premint);
  // e.g. reductionPerCliff = 5e25 / 500 = 1e23
  // e.g. cliff = 1e25 / 1e23 = 100
  const cliff = emissionsMinted.dividedBy(cliffs);
  // e.g. (new) reduction = (500 - 100) * 2.5 + 700 = 1700;
  const reduction = totalCliff.minus(cliff).times(5).dividedBy(2).plus(700);
  // e.g. (new) amount = 1e19 * 1700 / 500 =  34e18;
  const amtTillMax = max.minus(emissionsMinted);

  return [reduction, totalCliff, amtTillMax];
};

module.exports = getAuraApys;
