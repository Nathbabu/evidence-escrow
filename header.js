import { createClient } from "https://esm.sh/genlayer-js@1.1.8";
import { testnetBradbury } from "https://esm.sh/genlayer-js@1.1.8/chains";

/* ---------------------------------------------------------------------
   Shared header: wallet connection and the "My deals" panel. Loaded by
   every page so the header looks and behaves identically everywhere,
   not just on the page that also loads app.js for the actual escrow
   logic. Deal-specific code (creating, funding, resolving) stays in
   app.js and imports what it needs from here — this file has no
   knowledge of app.js and works standalone on pages that never load it.
--------------------------------------------------------------------- */
export const headerState = { account: null, writeClient: null, balance: null, provider: null, wrongNetwork: false };
export const readClient = createClient({ chain: testnetBradbury });

// EIP-6963: each installed wallet extension announces itself with its own
// name, icon, and provider object, instead of all of them fighting over
// the single window.ethereum slot (whichever loaded last used to just
// silently win, which is exactly the "wrong wallet answers" problem this
// replaces). Wallets that don't support this yet still work via the
// window.ethereum fallback further down.
const discoveredWallets = [];
window.addEventListener('eip6963:announceProvider', (e) => {
  const info = e.detail?.info;
  if(!info || discoveredWallets.some(w => w.info.uuid === info.uuid)) return;
  discoveredWallets.push({ info, provider: e.detail.provider });
});
window.dispatchEvent(new Event('eip6963:requestProvider')); // prompts already-loaded wallets to announce, in case they loaded before this listener was attached

function activeProvider(){
  return headerState.provider || window.ethereum;
}

// The SDK's own client.connect() is documented to add/switch the network
// automatically, but that isn't holding up on mobile in practice -- it's
// surfacing as a raw RPC error instead of the expected wallet popup.
// This builds the same standard wallet_switchEthereumChain /
// wallet_addEthereumChain flow directly, using the real chain data
// already imported above rather than hardcoding a chain ID or RPC URL.
// The wallet-facing network config, confirmed directly against a working
// MetaMask setup on PC -- not derived from the SDK's own embedded chain
// data, which turned out not to match this and is what caused the wrong
// network to get added in the first place.
const BRADBURY_NETWORK = {
  chainIdHex: '0x107d', // 4221 decimal
  chainName: 'GenLayer Testnet Chain',
  nativeCurrency: { name: 'GEN', symbol: 'GEN', decimals: 18 },
  rpcUrls: ['https://zksync-os-testnet-genlayer.zksync.dev'],
  blockExplorerUrls: ['https://explorer-bradbury.genlayer.com'],
};

async function ensureCorrectNetwork(provider){
  const chainIdHex = BRADBURY_NETWORK.chainIdHex;
  const current = await provider.request({ method: 'eth_chainId' });
  if(current?.toLowerCase() === chainIdHex.toLowerCase()) return; // already on Bradbury, nothing to do

  try{
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    });
  }catch(switchErr){
    // 4902 is the standard code for "wallet doesn't recognize this chain
    // yet" -- some wallets use a slightly different code or just a
    // matching message instead, so this checks both.
    const notAdded = switchErr?.code === 4902 || /unrecognized chain|not.*added|not.*found/i.test(switchErr?.message || '');
    if(!notAdded) throw switchErr;

    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: chainIdHex,
        chainName: BRADBURY_NETWORK.chainName,
        nativeCurrency: BRADBURY_NETWORK.nativeCurrency,
        rpcUrls: BRADBURY_NETWORK.rpcUrls,
        blockExplorerUrls: BRADBURY_NETWORK.blockExplorerUrls,
      }],
    });
  }

  // Some wallets resolve the switch/add call before their own internal
  // state has actually settled -- confirmed directly rather than trusted
  // blindly, given how much trouble this exact area has caused.
  await sleep(400);
  const confirmed = await provider.request({ method: 'eth_chainId' });
  if(confirmed?.toLowerCase() !== chainIdHex.toLowerCase()){
    throw new Error(`Wallet still reports the wrong network after switching (has ${confirmed}, needs ${chainIdHex}). Try switching manually in the wallet app.`);
  }
}

function weiToGen(v){
  try{
    const big = typeof v === 'bigint' ? v : BigInt(v ?? 0);
    const whole = big / 1000000000000000000n;
    const frac = big % 1000000000000000000n;
    if(frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(18,'0').slice(0,4).replace(/0+$/,'');
    return fracStr ? `${whole}.${fracStr}` : whole.toString();
  }catch(e){ return String(v); }
}

export async function refreshBalance(){
  if(!headerState.account) { headerState.balance = null; return; }
  try{
    const wei = await readClient.getBalance({ address: headerState.account });
    headerState.balance = wei;
  }catch(e){
    // A missed balance read isn't worth bothering anyone about -- the
    // address itself still shows, this just quietly tries again on the
    // next poll instead of surfacing yet another toast.
    console.error('balance refresh failed:', e);
  }
  renderWalletButton();
}

export function short(addr){
  if(!addr) return '';
  return addr.slice(0,6) + '…' + addr.slice(-4);
}

export function toast(msg, kind='ok'){
  const stack = document.getElementById('toasts');
  if(!stack) return;
  const el = document.createElement('div');
  el.className = 'px-4 py-3 rounded-lg border font-body-sm text-body-sm shadow-lg transition-opacity duration-300 ' +
    (kind === 'err' ? 'bg-error-container/90 border-error/30 text-on-error-container' : 'bg-surface-container border-white/10 text-on-surface');
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; setTimeout(()=>el.remove(), 420); }, 4200);
}

export function escapeHtml(s){ const d=document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
export function escapeAttr(s){ return escapeHtml(s).replace(/"/g,'&quot;'); }
export function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

/* ---------------------------------------------------------------------
   Local deal history. See v2_registry_notes.md for why this stays
   local rather than on-chain in v1.
--------------------------------------------------------------------- */
const HISTORY_KEY = 'evidenceescrow_history_v1';

export function getHistory(){
  try{ return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch(e){ return []; }
}

export function rememberDeal(address, terms, status, parties){
  try{
    const history = getHistory().filter(h => h.address.toLowerCase() !== address.toLowerCase());
    history.unshift({ address, terms: terms || '', status: status || '', parties: parties || null, savedAt: Date.now() });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50)));
  }catch(e){ /* private browsing or storage disabled — history just won't persist */ }
}

// Same storage as rememberDeal, different timestamp rule: a deal
// discovered passively through the on-chain registry sync keeps its
// existing savedAt if it's already known here, and only gets a fresh
// one the first time this browser ever sees it. Directly opening a
// deal (rememberDeal above) is a real interaction and should bump
// recency; a background sync finding out a deal exists is not.
export function mergeRemoteDeal(address, terms, status, parties){
  try{
    const history = getHistory();
    const existing = history.find(h => h.address.toLowerCase() === address.toLowerCase());
    const rest = history.filter(h => h.address.toLowerCase() !== address.toLowerCase());
    rest.unshift({
      address, terms: terms || '', status: status || '', parties: parties || null,
      savedAt: existing ? existing.savedAt : Date.now(),
    });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(rest.slice(0, 50)));
  }catch(e){ /* private browsing or storage disabled — history just won't persist */ }
}

export function getActiveDealsForAccount(){
  if(!headerState.account) return [];
  return getHistory().filter(h =>
    h.parties &&
    (h.parties.payer?.toLowerCase() === headerState.account || h.parties.payee?.toLowerCase() === headerState.account) &&
    !['Released', 'Resolved', 'Cancelled'].includes(h.status)
  );
}

export function timeAgo(ms){
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if(seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if(minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if(hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if(days < 30) return days === 1 ? '1 day ago' : `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

/* ---------------------------------------------------------------------
   Wallet connection
--------------------------------------------------------------------- */
function notifyWalletChanged(){
  window.dispatchEvent(new CustomEvent('header:wallet-changed'));
}

export async function connectWallet(){
  let chosenProvider = window.ethereum; // default/fallback for wallets that don't announce via EIP-6963

  if(discoveredWallets.length === 1){
    chosenProvider = discoveredWallets[0].provider;
  } else if(discoveredWallets.length > 1){
    const picked = await showWalletChooser();
    if(!picked) return; // person closed the chooser without picking
    chosenProvider = picked.provider;
    try{ localStorage.setItem('ee_chosen_wallet_rdns', picked.info.rdns); }catch(e){ /* private browsing or storage disabled -- just won't remember the choice next visit */ }
  }

  if(!chosenProvider){
    toast('No wallet found. Install MetaMask or a compatible browser wallet.', 'err');
    return;
  }
  await finishConnect(chosenProvider);
}

async function finishConnect(provider){
  let address;
  try{
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    address = accounts[0];
    if(!address){
      toast('That wallet reported no accounts -- check it\'s unlocked and try again.', 'err');
      return;
    }
  }catch(err){
    console.error(err);
    toast(err?.shortMessage || err?.message || 'Could not connect wallet', 'err');
    return;
  }

  // Account connection succeeded -- show that immediately, independent of
  // whether the network switch below also succeeds. Bundling these into
  // one all-or-nothing step was the actual bug: a rejected or failed
  // network switch made a genuinely successful account connection look
  // like it had failed entirely.
  headerState.provider = provider;
  headerState.account = address.toLowerCase();
  headerState.wrongNetwork = false;
  watchAccountsChanged(provider);
  renderWalletButton();
  notifyWalletChanged();

  try{
    await ensureCorrectNetwork(provider);
    headerState.writeClient = createClient({ chain: testnetBradbury, account: address, provider });
    refreshBalance();
    toast('Wallet connected');
  }catch(err){
    console.error(err);
    headerState.wrongNetwork = true;
    renderWalletButton();
    toast('Connected, but on the wrong network. Click your wallet button to switch to testnet Bradbury.', 'err');
    return;
  }

  // ensureCorrectNetwork() above is the real source of truth for whether
  // the wallet's on the right network -- this is a separate, best-effort
  // step afterward. Some SDK methods used later (waiting for transaction
  // receipts) turned out to depend on this having been called at some
  // point, even though calling it earlier, before the network was
  // actually confirmed correct, was what caused the "wrong network"
  // false-positive this whole thing was built to fix. Running it here,
  // now that the network is already genuinely correct, and not letting
  // its own failure block a connection that already succeeded.
  try{
    await headerState.writeClient.connect('testnetBradbury');
  }catch(connectErr){
    console.error('client.connect() failed after network was already confirmed correct -- proceeding anyway:', connectErr);
  }
}

function showWalletChooser(){
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center px-4';
    overlay.innerHTML = `
      <div class="bg-surface-container border border-white/10 rounded-xl w-full max-w-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-white/5">
          <h3 class="font-headline-md text-headline-md text-on-surface">Choose a wallet</h3>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-1">More than one wallet was found on this browser.</p>
        </div>
        <div class="max-h-80 overflow-y-auto">
          ${discoveredWallets.map((w, i) => `
            <button data-i="${i}" class="w-full flex items-center gap-3 px-5 py-4 hover:bg-white/5 transition-colors text-left border-b border-white/5 last:border-b-0">
              <img src="${w.info.icon}" alt="" class="w-7 h-7 rounded flex-none" />
              <span class="font-body-md text-body-md text-on-surface">${w.info.name}</span>
            </button>`).join('')}
        </div>
        <button id="walletChooserCancel" class="w-full text-center px-5 py-3 font-label-caps text-label-caps text-on-surface-variant hover:text-on-surface transition-colors border-t border-white/5">Cancel</button>
      </div>`;
    document.body.appendChild(overlay);

    const cleanup = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelectorAll('button[data-i]').forEach(btn => {
      btn.addEventListener('click', () => cleanup(discoveredWallets[Number(btn.dataset.i)]));
    });
    document.getElementById('walletChooserCancel').addEventListener('click', () => cleanup(null));
    overlay.addEventListener('click', (e) => { if(e.target === overlay) cleanup(null); });
  });
}

let listenedProvider = null;
function watchAccountsChanged(provider){
  if(!provider?.on || provider === listenedProvider) return; // already watching this exact provider, or it doesn't support the event at all
  listenedProvider = provider;
  provider.on('accountsChanged', async (accs)=>{
    if(accs[0]){
      headerState.account = accs[0].toLowerCase();
      headerState.writeClient = createClient({ chain: testnetBradbury, account: accs[0], provider });
      renderWalletButton();
      refreshBalance();
      notifyWalletChanged();
      return;
    }
    // Empty accounts list can be a real disconnect, or just noise from
    // another wallet extension fighting over window.ethereum — confirm
    // directly rather than trusting the event alone before dropping state.
    try{
      const confirmed = await provider.request({ method: 'eth_accounts' });
      if(!confirmed[0]){
        headerState.account = null; headerState.writeClient = null; headerState.balance = null;
        renderWalletButton(); notifyWalletChanged();
      }
    }catch(e){ /* provider mid-conflict — leave existing state as-is */ }
  });
}

async function switchAccount(){
  closeWalletMenu();
  const provider = activeProvider();
  if(!provider) return;
  try{
    // Forces the wallet to show its account picker again, even though
    // permission was already granted — there's no standard "switch"
    // call, this is the accepted workaround.
    await provider.request({
      method: 'wallet_requestPermissions',
      params: [{ eth_accounts: {} }],
    });
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    const address = accounts[0];
    headerState.writeClient = createClient({ chain: testnetBradbury, account: address, provider });
    headerState.account = address.toLowerCase();
    renderWalletButton();
    refreshBalance();
    notifyWalletChanged();
    toast('Switched account');
  }catch(err){
    console.error(err);
    toast('This wallet doesn\'t support in-page switching — change the account inside the wallet extension instead.', 'err');
  }
}

function disconnectWallet(){
  closeWalletMenu();
  headerState.account = null;
  headerState.writeClient = null;
  headerState.balance = null;
  headerState.provider = null;
  headerState.wrongNetwork = false;
  renderWalletButton();
  notifyWalletChanged();
  toast('Disconnected from this page. The wallet extension may still list it as connected — remove access there if you want it fully revoked.');
}

function closeWalletMenu(){
  document.getElementById('walletMenu')?.classList.add('hidden');
}

function renderWalletButton(){
  const walletBtn = document.getElementById('walletBtn');
  if(!walletBtn) return;
  walletBtn.className = "font-label-caps text-label-caps px-2.5 sm:px-4 py-2 rounded-full transition-all flex items-center gap-1 sm:gap-2 max-w-[45vw] sm:max-w-none " +
    (headerState.wrongNetwork
      ? "bg-error-container/30 border border-error/40 text-error"
      : headerState.account
      ? "bg-surface-container-high border border-white/10 text-on-surface"
      : "bg-primary text-on-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.4)] hover:brightness-110");
  walletBtn.innerHTML = headerState.wrongNetwork
    ? `<span class="material-symbols-outlined text-sm flex-none" aria-hidden="true">warning</span><span class="truncate">Wrong network</span>`
    : headerState.account
    ? `<span class="w-1.5 h-1.5 rounded-full bg-secondary flex-none"></span><span class="truncate">${short(headerState.account)}</span>${headerState.balance !== null ? `<span class="hidden sm:inline whitespace-nowrap">&middot; ${weiToGen(headerState.balance)} GEN</span>` : ''}`
    : `<span class="material-symbols-outlined text-sm flex-none" aria-hidden="true">account_balance_wallet</span><span class="hidden sm:inline">Connect wallet</span>`;

  const menuBalance = document.getElementById('walletMenuBalance');
  if(menuBalance){
    const hasBalance = headerState.account && headerState.balance !== null;
    menuBalance.textContent = hasBalance ? `${weiToGen(headerState.balance)} GEN` : '';
    menuBalance.classList.toggle('hidden', !hasBalance);
  }
}

function renderHistoryPanel(){
  const panel = document.getElementById('historyPanel');
  if(!panel) return;
  const items = getHistory();
  panel.innerHTML = items.length === 0
    ? `<div class="p-6 text-center font-body-sm text-body-sm text-on-surface-variant">No deals on this browser yet.</div>`
    : items.map(h => `
        <a class="block px-4 py-3 border-b border-white/5 last:border-b-0 hover:bg-white/5 transition-colors" href="index.html?deal=${escapeAttr(h.address)}">
          <span class="block font-body-sm text-body-sm text-on-surface mb-1">${escapeHtml((h.terms || '(no terms)')).slice(0, 54)}</span>
          <span class="flex items-center gap-3 font-code-md text-[11px] text-on-surface-variant">
            <span class="flex-none">${short(h.address)}</span>
            <span class="flex-none min-w-[70px]">${escapeHtml(h.status || '')}</span>
            <span>${timeAgo(h.savedAt)}</span>
          </span>
        </a>`).join('');
}

/* ---------------------------------------------------------------------
   DOM wiring — runs on every page that includes this file
--------------------------------------------------------------------- */
async function retryNetworkSwitch(){
  if(!headerState.provider || !headerState.account) return;
  try{
    await ensureCorrectNetwork(headerState.provider);
    headerState.writeClient = createClient({ chain: testnetBradbury, account: headerState.account, provider: headerState.provider });
    headerState.wrongNetwork = false;
    renderWalletButton();
    refreshBalance();
    toast('Switched to testnet Bradbury');
  }catch(err){
    console.error(err);
    toast(err?.shortMessage || err?.message || 'Still on the wrong network', 'err');
    return;
  }
  try{
    await headerState.writeClient.connect('testnetBradbury');
  }catch(connectErr){
    console.error('client.connect() failed after network was already confirmed correct -- proceeding anyway:', connectErr);
  }
}

document.getElementById('walletBtn')?.addEventListener('click', ()=>{
  if(headerState.wrongNetwork){
    retryNetworkSwitch();
  } else if(headerState.account){
    document.getElementById('walletMenu')?.classList.toggle('hidden');
  } else {
    connectWallet();
  }
});
document.getElementById('switchAcctBtn')?.addEventListener('click', switchAccount);
document.getElementById('disconnectBtn')?.addEventListener('click', disconnectWallet);
document.getElementById('historyBtn')?.addEventListener('click', ()=>{
  const panel = document.getElementById('historyPanel');
  if(!panel) return;
  const opening = panel.classList.contains('hidden');
  closeWalletMenu();
  panel.classList.toggle('hidden', !opening);
  if(opening) renderHistoryPanel();
});
document.addEventListener('click', (e)=>{
  const area = document.querySelector('.wallet-area');
  if(area && !area.contains(e.target)) closeWalletMenu();
  const histArea = document.querySelector('.history-area');
  if(histArea && !histArea.contains(e.target)) document.getElementById('historyPanel')?.classList.add('hidden');
});

/* ---------------------------------------------------------------------
   Boot — silently restore an already-authorized connection, same on
   every page, before app.js (if present) does its own boot work.
--------------------------------------------------------------------- */
(async function bootHeader(){
  await sleep(120); // gives installed wallets a brief moment to answer eip6963:requestProvider before checking what's been discovered
  let bootProvider = window.ethereum;
  try{
    const savedRdns = localStorage.getItem('ee_chosen_wallet_rdns');
    if(savedRdns){
      const match = discoveredWallets.find(w => w.info.rdns === savedRdns);
      if(match) bootProvider = match.provider;
    }
  }catch(e){ /* private browsing or storage disabled -- just falls through to window.ethereum */ }

  if(bootProvider){
    try{
      const accounts = await bootProvider.request({ method: 'eth_accounts' });
      if(accounts[0]){
        headerState.provider = bootProvider;
        headerState.account = accounts[0].toLowerCase();
        headerState.writeClient = createClient({ chain: testnetBradbury, account: accounts[0], provider: bootProvider });
        watchAccountsChanged(bootProvider);
        try{ await headerState.writeClient.connect('testnetBradbury'); }catch(e){ /* best-effort, same as the explicit connect flow -- a mismatched network here surfaces naturally on the next write attempt instead */ }
      }
    }catch(e){ /* no injected provider yet, or a mid-conflict moment — proceed as disconnected */ }
  }
  renderWalletButton();
  refreshBalance();
  notifyWalletChanged();

  // Keeps the shown balance honest even when nothing on this page
  // triggered the change itself -- funds arriving from somewhere else
  // entirely, or a deal resolving in another tab. Only bothers the
  // network when a wallet's actually connected.
  setInterval(() => { if(headerState.account) refreshBalance(); }, 20000);

  // "11 minutes ago" was frozen at whatever it said when the panel was
  // last opened, never ticking forward on its own while the page just
  // sat there. This doesn't touch the network at all, just re-renders
  // the already-open panel and tells app.js to do the same for
  // whatever time text it's showing.
  setInterval(() => {
    const panel = document.getElementById('historyPanel');
    if(panel && !panel.classList.contains('hidden')) renderHistoryPanel();
    window.dispatchEvent(new CustomEvent('header:tick'));
  }, 30000);
})();
