export const SEPOLIA = 11155111;
export const MAINNET = 1;
export const supported = id => id === SEPOLIA || id === MAINNET;
export const shortAddress = address => address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';
export const networkLabel = id => id === SEPOLIA ? 'Sepolia · testnet' : id === MAINNET ? 'Ethereum · mainnet' : id ? `Unsupported network (${id})` : 'No network';
export function walletError(error) {
  const code = error?.code ?? error?.cause?.code ?? error?.info?.error?.code;
  if ([4001, 5000, 'ACTION_REJECTED'].includes(code)) return 'Request declined. Nothing was submitted by this request.';
  if (code === -32002) return 'A request is already pending. Open your wallet to finish or cancel it.';
  if (code === 4902) return 'This network is not available in your wallet. Add it in the wallet and try again.';
  if ([4900, 4901].includes(code)) return 'Wallet disconnected. Reconnect to continue.';
  if (code === 'INSUFFICIENT_FUNDS' || code === -32000) return 'The wallet could not submit this transaction. Check your balance and gas in the wallet.';
  if (error?.safeMessage) return error.safeMessage;
  return 'The wallet request did not complete. Check your wallet before retrying.';
}
export function safeError(message) { return Object.assign(new Error(message), {safeMessage: message}); }
export function parseChain(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
export function readWithTimeout(promise, milliseconds = 12000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(safeError('Wallet is not responding. Return to your wallet, then retry.')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

// AppKit owns session persistence and connector selection. Never persist a signer,
// provider, account permission, private key, seed phrase, or raw connection URI here.
export class WalletSession {
  constructor({appkit, networks, onChange = () => {}, onError = () => {}}) {
    this.appkit = appkit;
    this.networks = networks;
    this.onChange = onChange;
    this.onError = onError;
    this.state = {address: undefined, chainId: undefined, status: 'disconnected', busy: false};
    this.generation = 0;
    this.sequence = 0;
    this.suspended = false;
    this.provider = undefined;
    this.listeners = [];
    this.unsubscribers = [];
  }
  emit(patch) { Object.assign(this.state, patch); this.onChange({...this.state}); }
  start() {
    this.unsubscribers.push(this.appkit.subscribeProviders(providers => this.bind(providers.eip155)));
    this.unsubscribers.push(this.appkit.subscribeAccount(account => {
      if (this.suspended) return;
      if (account.status === 'connecting' || account.status === 'reconnecting') {
        this.emit({status: account.status});
      }
      if (account.isConnected) this.refresh();
      else if (account.status === 'disconnected') {
        this.generation++;
        this.emit({address: undefined, chainId: undefined, status: 'disconnected'});
      }
    }, 'eip155'));
    this.bind(this.appkit.getWalletProvider());
  }
  bind(provider) {
    if (provider === this.provider) return;
    for (const [event, listener] of this.listeners) this.provider?.removeListener?.(event, listener);
    this.listeners = [];
    this.provider = provider;
    this.generation++;
    if (!provider) {
      this.emit({address: undefined, chainId: undefined, status: 'disconnected'});
      return;
    }
    for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
      const listener = () => {
        this.generation++;
        // Invalidate the old account and chain immediately, before async RPCs.
        this.emit({address: undefined, chainId: undefined, status: event === 'disconnect' ? 'disconnected' : 'reconnecting'});
        if (event !== 'disconnect') this.refresh();
      };
      provider.on?.(event, listener);
      this.listeners.push([event, listener]);
    }
    this.refresh();
  }
  async refresh() {
    const provider = this.provider;
    if (!provider || this.suspended) return;
    const generation = this.generation;
    const sequence = ++this.sequence;
    try {
      const [accounts, chain] = await readWithTimeout(Promise.all([
        provider.request({method: 'eth_accounts'}), provider.request({method: 'eth_chainId'})
      ]));
      if (generation !== this.generation || sequence !== this.sequence || this.suspended) return;
      const address = Array.isArray(accounts) && /^0x[0-9a-f]{40}$/i.test(accounts[0]) ? accounts[0] : undefined;
      this.emit({address, chainId: parseChain(chain), status: address ? 'connected' : 'disconnected'});
    } catch (error) {
      if (generation !== this.generation || sequence !== this.sequence || this.suspended) return;
      this.emit({address: undefined, chainId: undefined, status: 'disconnected'});
      this.onError(walletError(error));
    }
  }
  open() {
    this.suspended = false;
    // Called directly from the click. AppKit handles mobile universal/deep links.
    return this.appkit.open({view: this.state.address ? 'Account' : 'Connect', namespace: 'eip155'});
  }
  async disconnect() {
    if (this.state.busy) throw safeError('Finish or cancel the pending wallet request first.');
    this.suspended = true;
    this.generation++;
    this.emit({address: undefined, chainId: undefined, status: 'disconnected', busy: true});
    try { await this.appkit.disconnect('eip155'); }
    catch (error) {
      this.suspended = false;
      await this.refresh();
      throw error;
    } finally { this.emit({busy: false}); }
  }
  async switchNetwork(chainId) {
    if (!supported(chainId)) throw safeError('StickerBomb supports Ethereum mainnet and Sepolia only.');
    if (this.state.busy) throw safeError('Finish or cancel the pending wallet request first.');
    this.emit({busy: true});
    try {
      await this.appkit.switchNetwork(this.networks.find(network => network.id === chainId), {throwOnFailure: true});
      await this.refresh();
      if (this.state.address && this.state.chainId !== chainId) throw safeError('Network switch was not confirmed. Check the selected network in your wallet.');
    } finally { this.emit({busy: false}); }
  }
  async sendSepoliaTestTransaction() {
    if (this.state.busy) throw safeError('A wallet request is already pending.');
    if (!this.state.address || this.state.status !== 'connected') throw safeError('Connect a wallet first.');
    const provider = this.provider;
    const address = this.state.address;
    const generation = this.generation;
    this.emit({busy: true});
    try {
      const [accounts, chain] = await readWithTimeout(Promise.all([
        provider.request({method: 'eth_accounts'}), provider.request({method: 'eth_chainId'})
      ]));
      if (this.suspended || generation !== this.generation || provider !== this.provider || accounts?.[0]?.toLowerCase() !== address.toLowerCase()) throw safeError('Wallet account changed. Review it and try again.');
      if (parseChain(chain) !== SEPOLIA) throw safeError('Switch to Sepolia before sending a test transaction. Mainnet transactions are disabled in this test.');
      // No automatic network switching or replay. Wallet displays fee approval.
      // Do not time out a write: it may already have been broadcast.
      const hash = await provider.request({method: 'eth_sendTransaction', params: [{from: address, to: address, value: '0x0', chainId: '0xaa36a7'}]});
      if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw safeError('The wallet returned no valid transaction hash. Check its activity before retrying.');
      return hash;
    } finally { this.emit({busy: false}); }
  }
  destroy() {
    this.generation++;
    for (const stop of this.unsubscribers) if (typeof stop === 'function') stop();
    for (const [event, listener] of this.listeners) this.provider?.removeListener?.(event, listener);
    this.listeners = [];
    this.provider = undefined;
  }
}
