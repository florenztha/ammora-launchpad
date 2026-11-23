import { giwaSepoliaAutoRouteDeployment, giwaSepoliaAtomicLaunchDeployment, ammoraLaunchFactoryV4Abi, AmmoraV4LaunchCurveClient } from '@ammora-protocol/sdk';
import { createPublicClient, http, defineChain, parseEther, formatUnits } from 'viem';
const chain = defineChain({ id: 91342, name: 'GIWA Sepolia', nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18}, rpcUrls:{default:{http:['https://sepolia-rpc.giwa.io']}} });
const client = createPublicClient({ chain, transport: http('https://sepolia-rpc.giwa.io',{timeout:60000,retryCount:3}) });
const factory = giwaSepoliaAutoRouteDeployment.contracts.launch.factory;
const ev = ammoraLaunchFactoryV4Abi.find(x=>x.type==='event'&&x.name==='LaunchCreated');
const logs = await client.getLogs({ address: factory, event: ev, fromBlock: 42020112n, toBlock: 42030111n });
console.log('launches:', logs.length);
const core = { launchFactory: giwaSepoliaAtomicLaunchDeployment.contracts.launchFactory, feePolicy: giwaSepoliaAtomicLaunchDeployment.contracts.feePolicy };
for (const l of logs) {
  const c = new AmmoraV4LaunchCurveClient(client, l.args.curve, core);
  try {
    const s = await c.getState();
    let q = 'n/a';
    try { const quote = await c.quoteExactInput(parseEther('0.01'), false); q = JSON.stringify(quote, (k,v)=>typeof v==='bigint'?v.toString():v); } catch(e){ q = 'ERR ' + (e.shortMessage||e.message).slice(0,90); }
    console.log(l.args.curve, 'token', l.args.token, 'status', s.status, 'quoteReserve', formatUnits(s.quoteReserve,18), 'quote:', q.slice(0,220));
  } catch(e){ console.log(l.args.curve, 'state ERR', (e.shortMessage||e.message).slice(0,90)); }
}
