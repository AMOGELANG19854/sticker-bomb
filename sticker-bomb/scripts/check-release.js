import {loadEnv} from 'vite';
const env = {...loadEnv('production', process.cwd(), 'VITE_'), ...process.env};
if (!/^[a-f0-9]{32}$/i.test(env.VITE_REOWN_PROJECT_ID || '')) {
  throw new Error('Release blocked: configure VITE_REOWN_PROJECT_ID with your Reown project ID, then build again.');
}
if (!['1', '11155111'].includes(env.VITE_DEFAULT_CHAIN_ID || '11155111')) {
  throw new Error('VITE_DEFAULT_CHAIN_ID must be 1 or 11155111.');
}
console.log('Wallet release configuration is present. Verify the origin allowlist in Reown Dashboard.');
