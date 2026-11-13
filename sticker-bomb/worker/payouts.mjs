const addressPattern = /^0x[0-9a-f]{40}$/i;
const payoutAbi = [
  'function payment() view returns (address)',
  'function placed(bytes32,uint16) view returns (bool)',
  'function campaigns(bytes32) view returns (address company,address printer,uint128 unitPrice,uint16 quantity,uint16 completed)',
  'function settle(bytes32,uint16,address,bytes32)',
  'event Placed(bytes32 indexed id,uint16 indexed index,address indexed worker,bytes32 proof,uint256 payout)'
];
const payoutStatus = row => row ? {
  stop:row.stop,status:row.paid_at ? 'paid' : 'pending',tx:row.tx,recipient:row.recipient,amount:row.amount_units == null ? null : String(row.amount_units)
} : {status:'unavailable'};

async function payoutConfig(env) {
  const {SEPOLIA_RPC_URL:rpc,SEPOLIA_ESCROW_ADDRESS:escrow,SEPOLIA_USDT_ADDRESS:token,
    SEPOLIA_SIGNER_KEY:key,SEPOLIA_ESCROW_START_BLOCK:start} = env;
  if (!rpc?.startsWith('https://') || !addressPattern.test(escrow) || !addressPattern.test(token)
      || !/^\d+$/.test(start ?? '')) return null;
  const provider = new chain.JsonRpcProvider(rpc);
  if ((await provider.getNetwork()).chainId !== 11155111n) return null;
  const signer = /^0x[0-9a-f]{64}$/i.test(key) ? new chain.Wallet(key,provider) : null;
  const contract = new chain.Contract(escrow,payoutAbi,signer ?? provider);
  if ((await contract.payment()).toLowerCase() !== token.toLowerCase()) return null;
  const erc20 = new chain.Contract(token,['function decimals() view returns (uint8)'],provider);
  if (await erc20.decimals() !== 6n) return null;
  return {provider,signer,contract,escrow:escrow.toLowerCase(),token:token.toLowerCase(),start:Number(start)};
}

async function settlePayout(query, env, proof, submit) {
  if (!proof?.wallet || !addressPattern.test(proof.wallet)) return payoutStatus(null);
  let row = await query('SELECT * FROM placement_payouts WHERE campaign=? AND stop=?',proof.campaign,proof.stop).first();
  if (row?.paid_at) return payoutStatus(row);
  try {
    const config = await payoutConfig(env);
    if (!config) return payoutStatus(row);
    const {provider,signer,contract,escrow,token,start} = config;
    const id = chain.id('Sticker Bomb campaign:' + proof.campaign);
    if (!row) {
      const campaign = await contract.campaigns(id);
      if (!addressPattern.test(campaign.company) || /^0x0{40}$/i.test(campaign.company) ||
          campaign.quantity <= proof.stop || campaign.unitPrice === 0n) return payoutStatus(null);
      await query(`INSERT INTO placement_payouts (campaign,stop,recipient,proof,escrow,token,amount_units) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT DO NOTHING`,proof.campaign,proof.stop,proof.wallet.toLowerCase(),'0x'+proof.hash,escrow,token,String(campaign.unitPrice/2n)).run();
      row = await query('SELECT * FROM placement_payouts WHERE campaign=? AND stop=?',proof.campaign,proof.stop).first();
    }
    if (row.escrow !== escrow || row.token !== token) return payoutStatus(row);
    if (await contract.placed(id,row.stop)) {
      const logs = await contract.queryFilter(contract.filters.Placed(id,row.stop,row.recipient),start);
      const event = logs.find(item => item.args.proof === row.proof && item.args.payout > 0n);
      if (!event) return payoutStatus(row);
      const receipt = await provider.getTransactionReceipt(event.transactionHash);
      if (receipt?.status === 1) {
        const transfer = new chain.Contract(token,['event Transfer(address indexed from,address indexed to,uint256 value)'],provider);
        const delivered = receipt.logs.some(log => {
          if (log.address.toLowerCase() !== token) return false;
          try {
            const args = transfer.interface.parseLog(log)?.args;
            return args?.from.toLowerCase() === escrow && args.to.toLowerCase() === row.recipient && args.value === event.args.payout;
          } catch { return false; }
        });
        if (delivered) {
          await query('UPDATE placement_payouts SET tx=?,paid_at=?,amount_units=? WHERE campaign=? AND stop=?',
            event.transactionHash,Date.now(),String(event.args.payout),row.campaign,row.stop).run();
          return payoutStatus({...row,tx:event.transactionHash,paid_at:1,amount_units:String(event.args.payout)});
        }
      }
      return payoutStatus(row);
    }
    if (!submit || !signer || (await contract.campaigns(id)).company.toLowerCase() !== signer.address.toLowerCase()) return payoutStatus(row);
    if (row.tx) {
      const receipt = await provider.getTransactionReceipt(row.tx);
      if (receipt?.status !== 0) return payoutStatus(row);
    }
    const now = Date.now();
    const reserved = await query(`UPDATE placement_payouts SET submitted_at=? WHERE campaign=? AND stop=?
      AND paid_at IS NULL AND (submitted_at IS NULL OR submitted_at<=?)`,now,row.campaign,row.stop,now-120000).run();
    if (reserved.meta.changes !== 1) return payoutStatus(row);
    const tx = await contract.settle(id,row.stop,row.recipient,row.proof);
    await query('UPDATE placement_payouts SET tx=? WHERE campaign=? AND stop=? AND paid_at IS NULL',
      tx.hash,row.campaign,row.stop).run();
    return payoutStatus({...row,tx:tx.hash});
  } catch {
    return payoutStatus(row);
  }
}
