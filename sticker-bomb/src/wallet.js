import {createAppKit} from '@reown/appkit';
import {EthersAdapter} from '@reown/appkit-adapter-ethers';
import {mainnet, sepolia} from '@reown/appkit/networks';
import {JsonRpcProvider} from 'ethers';
import {WalletSession, SEPOLIA, MAINNET, networkLabel, shortAddress, walletError, supported} from './wallet-core.js';

const $ = id => document.getElementById(id);
const message = text => { $('wallet-message').textContent = text; };
const networks = [sepolia, mainnet];
const projectId = import.meta.env.VITE_REOWN_PROJECT_ID?.trim();
const defaultChainId = Number(import.meta.env.VITE_DEFAULT_CHAIN_ID || SEPOLIA);
const publicRPCs = {
  [SEPOLIA]: import.meta.env.VITE_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
  [MAINNET]: import.meta.env.VITE_MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com'
};
// Read-only RPC never asks a wallet for an account or signature.
const readers = new Map();
export function readOnlyProvider(chainId) {
  if (!supported(chainId)) throw new Error('Unsupported read network');
  if (!readers.has(chainId)) readers.set(chainId, new JsonRpcProvider(publicRPCs[chainId], chainId));
  return readers.get(chainId);
}
const run = action => Promise.resolve().then(action).catch(error => message(walletError(error)));
let session;
let confirmAction;
function confirm(title, text, action) {
  confirmAction = action;
  $('wallet-confirm-title').textContent = title;
  $('wallet-confirm-text').textContent = text;
  $('wallet-confirm').showModal();
  $('wallet-confirm-cancel').focus();
}
$('wallet-confirm-cancel').onclick = () => $('wallet-confirm').close();
$('wallet-confirm').addEventListener('close', () => { confirmAction = undefined; });
$('wallet-confirm-go').onclick = () => {
  const action = confirmAction;
  $('wallet-confirm').close();
  if (action) run(action);
};
function render(state) {
  const connected = !!state.address;
  $('wallet').textContent = connected ? shortAddress(state.address) : 'Connect Wallet';
  $('wallet').title = state.address || 'Choose an Ethereum-compatible wallet';
  $('wallet').setAttribute('aria-label', connected ? `Wallet ${state.address}. Manage connection` : 'Connect Wallet');
  $('wallet-state').textContent = state.busy ? 'Check your wallet…' : state.status === 'reconnecting' ? 'Restoring connection…' : state.status === 'connecting' ? 'Connecting…' : connected ? 'Connected' : 'Not connected';
  $('wallet-network').hidden = !connected;
  $('wallet-network').textContent = networkLabel(state.chainId);
  $('wallet-network').dataset.mainnet = String(state.chainId === MAINNET);
  $('wallet-network').setAttribute('aria-label', `${networkLabel(state.chainId)}. Switch network`);
  $('wallet-disconnect').hidden = !connected;
  for (const id of ['wallet', 'wallet-network', 'wallet-disconnect']) $(id).disabled = state.busy;
  $('wallet-test').disabled = !connected || state.chainId !== SEPOLIA || state.busy;
  if (connected && !supported(state.chainId)) message('Unsupported network. Select Sepolia or Ethereum using the network button.');
}

if (!/^[a-f0-9]{32}$/i.test(projectId || '') || !supported(defaultChainId)) {
  // Preview stays usable with missing config. Release check fails before publishing.
  $('wallet').onclick = () => message('Wallet connections are not configured yet. Campaign tools remain available.');
} else {
  try {
    const appkit = createAppKit({
      adapters: [new EthersAdapter()],
      projectId,
      networks,
      defaultNetwork: networks.find(network => network.id === defaultChainId),
      metadata: {name: 'StickerBomb', description: 'Sticker campaigns and placement tracking', url: window.location.origin, icons: [new URL('/wallet-icon.svg', window.location.origin).href]},
      enableEIP6963: true,
      enableInjected: true,
      enableCoinbase: true,
      enableWalletConnect: true,
      enableReconnect: true,
      // Switching goes through the labelled header control and mainnet notice below.
      enableNetworkSwitch: false,
      allWallets: 'SHOW',
      allowUnsupportedChain: true,
      themeMode: 'light',
      themeVariables: {'--w3m-accent': '#596700', '--w3m-font-family': 'Instrument Sans, Arial, sans-serif', '--w3m-border-radius-master': '2px', '--w3m-z-index': 2000},
      features: {analytics: false, email: false, socials: false, swaps: false, onramp: false, send: false, receive: false, history: false}
    });
    session = new WalletSession({appkit, networks, onChange: render, onError: message});
    session.start();
    $('wallet').onclick = () => {
      message('');
      // No asynchronous import before opening: retain the originating user gesture.
      try { Promise.resolve(session.open()).catch(error => message(walletError(error))); }
      catch (error) { message(walletError(error)); }
    };
    $('wallet-disconnect').onclick = () => run(async () => { await session.disconnect(); message('Wallet disconnected. Campaigns remain on this device.'); });
    $('wallet-network').onclick = () => {
      const next = session.state.chainId === SEPOLIA ? MAINNET : SEPOLIA;
      confirm(`Switch to ${next === MAINNET ? 'Ethereum mainnet' : 'Sepolia'}?`, next === MAINNET ? 'Ethereum mainnet uses real ETH. Campaigns and rewards in this build remain demos. The test transaction is disabled on mainnet.' : 'Sepolia uses test ETH with no monetary value.', async () => {
        await session.switchNetwork(next);
        message(`Selected ${networkLabel(next)}.`);
      });
    };
    $('wallet-test').onclick = () => {
      // Capture account at review time; don't silently send after switching accounts.
      const reviewedAddress = session.state.address;
      confirm('Test a Sepolia transaction?', `Send 0 test ETH to ${reviewedAddress}. You pay only Sepolia gas. Review and approve in your wallet.`, async () => {
        if (reviewedAddress !== session.state.address) { message('Account changed. Review the transaction again.'); return; }
        message('Review the Sepolia transaction in your wallet. Return here after approving or declining.');
        const hash = await session.sendSepoliaTestTransaction();
        // A public transaction hash is safe to retain. Never persist a pending signature request.
        try { sessionStorage.setItem('stickerbomb-last-sepolia-tx', hash); } catch { /* Storage may be unavailable. */ }
        showTransaction(hash);
        message('Transaction submitted on Sepolia. Confirmation is not yet verified.');
        checkReceipt(hash);
      });
    };
    const resume = () => {
      if (document.visibilityState === 'hidden') return;
      // Read-only refresh after app switching or bfcache restore. Never replay writes.
      session.refresh();
      restoreTransaction();
    };
    window.addEventListener('pageshow', resume);
    document.addEventListener('visibilitychange', resume);
    appkit.subscribeEvents(event => {
      if (event.data?.event === 'USER_REJECTED') message('Connection declined. You can continue without a wallet.');
      if (event.data?.event === 'CONNECT_ERROR') message('Connection failed. Retry or choose another wallet.');
      if (event.data?.event === 'DISCONNECT_ERROR') message('Disconnect failed. Check the connection in your wallet.');
    });
    appkit.subscribeState(state => { if (!state.open) session.refresh(); });
    if (import.meta.hot) import.meta.hot.dispose(() => {
      session.destroy();
      window.removeEventListener('pageshow', resume);
      document.removeEventListener('visibilitychange', resume);
    });
  } catch {
    message('Wallet setup could not load. Reload to retry. Campaign tools remain available.');
    $('wallet').onclick = () => window.location.reload();
  }
}
function showTransaction(hash, result = 'Submitted') {
  const link = document.createElement('a');
  link.href = `https://sepolia.etherscan.io/tx/${hash}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = `${result} on Sepolia: ${hash.slice(0, 10)}…${hash.slice(-8)}`;
  $('wallet-transaction').replaceChildren(link);
}
let receiptPending = false;
async function checkReceipt(hash) {
  if (receiptPending) return;
  receiptPending = true;
  try {
    const receipt = await readOnlyProvider(SEPOLIA).getTransactionReceipt(hash);
    if (receipt) showTransaction(hash, receipt.status === 1 ? 'Confirmed' : 'Reverted');
  } catch { /* Explorer remains available when public RPC is unavailable. */ }
  finally { receiptPending = false; }
}
function restoreTransaction() {
  let hash;
  try { hash = sessionStorage.getItem('stickerbomb-last-sepolia-tx'); } catch { return; }
  if (/^0x[0-9a-f]{64}$/i.test(hash || '')) { showTransaction(hash); checkReceipt(hash); }
}
restoreTransaction();
