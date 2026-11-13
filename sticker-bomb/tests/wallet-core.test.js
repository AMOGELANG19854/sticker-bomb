import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {WalletSession, walletError, networkLabel, SEPOLIA, MAINNET, readWithTimeout} from '../src/wallet-core.js';
const address = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const hash = `0x${'a'.repeat(64)}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const provider = new EventEmitter();
  const calls = [];
  let accounts = [address], chain = '0xaa36a7';
  provider.request = async args => {
    calls.push(args);
    if (args.method === 'eth_accounts') return accounts;
    if (args.method === 'eth_chainId') return chain;
    if (args.method === 'eth_sendTransaction') return hash;
    throw Error('Unexpected method');
  };
  const appkit = {
    subscribeProviders: fn => { appkit.providers = fn; return () => {}; },
    subscribeAccount: fn => { appkit.account = fn; return () => {}; },
    getWalletProvider: () => provider,
    open: async opts => { appkit.opened = opts; },
    disconnect: async () => { appkit.providers({}); },
    switchNetwork: async network => { chain = `0x${network.id.toString(16)}`; provider.emit('chainChanged', chain); }
  };
  const errors = [];
  const session = new WalletSession({appkit, networks: [{id: SEPOLIA}, {id: MAINNET}], onError: e => errors.push(e)});
  session.start();
  return {session, appkit, provider, calls, errors, accounts: value => { accounts = value; }, chain: value => { chain = value; }};
}
test('restores selected provider using read-only requests; never signs on load', async () => {
  const x = setup(); await tick();
  assert.equal(x.session.state.address, address);
  assert.equal(x.session.state.chainId, SEPOLIA);
  assert.deepEqual(x.calls.map(c => c.method), ['eth_accounts', 'eth_chainId']);
  x.session.destroy();
});
test('account change invalidates old address immediately and selects new account', async () => {
  const x = setup(); await tick(); x.accounts([other]); x.provider.emit('accountsChanged', [other]);
  assert.equal(x.session.state.address, undefined); await tick();
  assert.equal(x.session.state.address, other); x.session.destroy();
});
test('empty account list disconnects', async () => {
  const x = setup(); await tick(); x.accounts([]); x.provider.emit('accountsChanged', []); await tick();
  assert.equal(x.session.state.status, 'disconnected'); x.session.destroy();
});
test('external unsupported network is identified and cannot send test transaction', async () => {
  const x = setup(); await tick(); x.chain('0x89'); x.provider.emit('chainChanged', '0x89'); await tick();
  assert.match(networkLabel(x.session.state.chainId), /Unsupported/);
  await assert.rejects(x.session.sendSepoliaTestTransaction(), /Switch to Sepolia/);
  assert.ok(!x.calls.some(c => c.method === 'eth_sendTransaction')); x.session.destroy();
});
test('switch is explicit and verifies actual network', async () => {
  const x = setup(); await tick(); await x.session.switchNetwork(MAINNET);
  assert.equal(x.session.state.chainId, MAINNET);
  await assert.rejects(x.session.sendSepoliaTestTransaction(), /Switch to Sepolia/);
  await assert.rejects(x.session.switchNetwork(137), /supports/); x.session.destroy();
});
test('declined switch leaves state accurate and retry enabled', async () => {
  const x = setup(); await tick(); x.appkit.switchNetwork = async () => { throw {code: 4001}; };
  await assert.rejects(x.session.switchNetwork(MAINNET));
  assert.equal(x.session.state.chainId, SEPOLIA); assert.equal(x.session.state.busy, false);
  assert.match(walletError({code: 4001}), /declined/); x.session.destroy();
});
test('disconnect prevents stale provider refresh from reconnecting', async () => {
  const x = setup(); await tick(); await x.session.disconnect();
  x.appkit.providers({eip155: x.provider}); await x.session.refresh();
  assert.equal(x.session.state.address, undefined);
  await x.session.open(); await x.session.refresh();
  assert.equal(x.session.state.address, address); x.session.destroy();
});
test('stale asynchronous reads cannot overwrite account change', async () => {
  const x = setup(); await tick(); let resolveAccounts;
  const request = x.provider.request;
  x.provider.request = args => args.method === 'eth_accounts' ? new Promise(resolve => { resolveAccounts = resolve; }) : request(args);
  const pending = x.session.refresh();
  x.provider.request = request; x.accounts([other]); x.provider.emit('accountsChanged', [other]); await tick();
  resolveAccounts([address]); await pending;
  assert.equal(x.session.state.address, other); x.session.destroy();
});
test('Sepolia self-transfer is zero value, chain bound, and returns a hash', async () => {
  const x = setup(); await tick(); assert.equal(await x.session.sendSepoliaTestTransaction(), hash);
  assert.deepEqual(x.calls.find(c => c.method === 'eth_sendTransaction').params, [{from: address, to: address, value: '0x0', chainId: '0xaa36a7'}]);
  assert.equal(x.session.state.busy, false); x.session.destroy();
});
test('account changed without an event is caught before write', async () => {
  const x = setup(); await tick(); x.accounts([other]);
  await assert.rejects(x.session.sendSepoliaTestTransaction(), /account changed/);
  assert.ok(!x.calls.some(c => c.method === 'eth_sendTransaction')); x.session.destroy();
});
test('duplicate write blocked and rejection releases busy state', async () => {
  const x = setup(); await tick(); const request = x.provider.request; let rejectWrite;
  x.provider.request = args => args.method === 'eth_sendTransaction' ? new Promise((_, reject) => { rejectWrite = reject; }) : request(args);
  const pending = x.session.sendSepoliaTestTransaction(); await tick();
  await assert.rejects(x.session.sendSepoliaTestTransaction(), /pending/);
  rejectWrite({code: 4001}); await assert.rejects(pending);
  assert.equal(x.session.state.busy, false); x.session.destroy();
});
test('disconnect event clears state and cleanup removes provider listeners', async () => {
  const x = setup(); await tick(); x.provider.emit('disconnect');
  assert.equal(x.session.state.address, undefined); x.session.destroy();
  assert.equal(x.provider.listenerCount('accountsChanged'), 0);
});
test('read timeout fails without leaving pending timers', async () => {
  await assert.rejects(readWithTimeout(new Promise(() => {}), 5), /not responding/);
});
test('errors are sanitized instead of echoing arbitrary wallet payloads', () => {
  assert.ok(!walletError({message: 'sensitive raw payload'}).includes('sensitive'));
  assert.match(walletError({code: -32002}), /already pending/);
  assert.match(walletError({cause: {code: 4001}}), /declined/);
});
