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
export const headerState = { account: null, writeClient: null };
export const readClient = createClient({ chain: testnetBradbury });

export function short(addr){
  if(!addr) return '';
  return addr.slice(0,6) + '…' + addr.slice(-4);
}

export function toast(msg, kind='ok'){
  const stack = document.getElementById('toasts');
  if(!stack) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(()=>{ el.style.transition='opacity .4s var(--ease)'; el.style.opacity='0'; setTimeout(()=>el.remove(), 420); }, 4200);
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

export function getActiveDealsForAccount(){
  if(!headerState.account) return [];
  return getHistory().filter(h =>
    h.parties &&
    (h.parties.payer?.toLowerCase() === headerState.account || h.parties.payee?.toLowerCase() === headerState.account) &&
    !['Released', 'Resolved', 'Cancelled'].includes(h.status)
  );
}

/* ---------------------------------------------------------------------
   Wallet connection
--------------------------------------------------------------------- */
function notifyWalletChanged(){
  window.dispatchEvent(new CustomEvent('header:wallet-changed'));
}

export async function connectWallet(){
  if(!window.ethereum){
    toast('No wallet found. Install MetaMask or a compatible browser wallet.', 'err');
    return;
  }
  try{
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const address = accounts[0];
    headerState.writeClient = createClient({ chain: testnetBradbury, account: address, provider: window.ethereum });
    await headerState.writeClient.connect('testnetBradbury');
    headerState.account = address.toLowerCase();
    renderWalletButton();
    notifyWalletChanged();
    toast('Wallet connected');
  }catch(err){
    console.error(err);
    toast(err?.shortMessage || err?.message || 'Could not connect wallet', 'err');
  }
}

if(window.ethereum){
  window.ethereum.on?.('accountsChanged', async (accs)=>{
    if(accs[0]){
      headerState.account = accs[0].toLowerCase();
      headerState.writeClient = createClient({ chain: testnetBradbury, account: accs[0], provider: window.ethereum });
      renderWalletButton();
      notifyWalletChanged();
      return;
    }
    // Empty accounts list can be a real disconnect, or just noise from
    // another wallet extension fighting over window.ethereum — confirm
    // directly rather than trusting the event alone before dropping state.
    try{
      const confirmed = await window.ethereum.request({ method: 'eth_accounts' });
      if(!confirmed[0]){
        headerState.account = null; headerState.writeClient = null;
        renderWalletButton(); notifyWalletChanged();
      }
    }catch(e){ /* provider mid-conflict — leave existing state as-is */ }
  });
}

async function switchAccount(){
  closeWalletMenu();
  if(!window.ethereum) return;
  try{
    // Forces the wallet to show its account picker again, even though
    // permission was already granted — there's no standard "switch"
    // call, this is the accepted workaround.
    await window.ethereum.request({
      method: 'wallet_requestPermissions',
      params: [{ eth_accounts: {} }],
    });
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const address = accounts[0];
    headerState.writeClient = createClient({ chain: testnetBradbury, account: address, provider: window.ethereum });
    headerState.account = address.toLowerCase();
    renderWalletButton();
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
  renderWalletButton();
  notifyWalletChanged();
  toast('Disconnected from this page. The wallet extension may still list it as connected — remove access there if you want it fully revoked.');
}

function closeWalletMenu(){
  document.getElementById('walletMenu')?.classList.remove('open');
}

function renderWalletButton(){
  const walletBtn = document.getElementById('walletBtn');
  if(!walletBtn) return;
  walletBtn.innerHTML = headerState.account
    ? `<span class="dot"></span>${short(headerState.account)}`
    : 'Connect wallet';
  walletBtn.className = 'wallet-btn' + (headerState.account ? ' connected' : '');
}

function renderHistoryPanel(){
  const panel = document.getElementById('historyPanel');
  if(!panel) return;
  const items = getHistory();
  panel.innerHTML = items.length === 0
    ? `<div class="history-empty">No deals on this browser yet.</div>`
    : items.map(h => `
        <a class="history-item" href="index.html?deal=${escapeAttr(h.address)}">
          <span class="history-terms">${escapeHtml((h.terms || '(no terms)')).slice(0, 54)}</span>
          <span class="history-meta">${escapeHtml(h.status || '')} · ${short(h.address)}</span>
        </a>`).join('');
}

/* ---------------------------------------------------------------------
   DOM wiring — runs on every page that includes this file
--------------------------------------------------------------------- */
document.getElementById('walletBtn')?.addEventListener('click', ()=>{
  if(headerState.account){
    document.getElementById('walletMenu')?.classList.toggle('open');
  } else {
    connectWallet();
  }
});
document.getElementById('switchAcctBtn')?.addEventListener('click', switchAccount);
document.getElementById('disconnectBtn')?.addEventListener('click', disconnectWallet);
document.getElementById('historyBtn')?.addEventListener('click', ()=>{
  const panel = document.getElementById('historyPanel');
  if(!panel) return;
  const opening = !panel.classList.contains('open');
  closeWalletMenu();
  panel.classList.toggle('open', opening);
  if(opening) renderHistoryPanel();
});
document.addEventListener('click', (e)=>{
  const area = document.querySelector('.wallet-area');
  if(area && !area.contains(e.target)) closeWalletMenu();
  const histArea = document.querySelector('.history-area');
  if(histArea && !histArea.contains(e.target)) document.getElementById('historyPanel')?.classList.remove('open');
});

/* ---------------------------------------------------------------------
   Boot — silently restore an already-authorized connection, same on
   every page, before app.js (if present) does its own boot work.
--------------------------------------------------------------------- */
(async function bootHeader(){
  if(window.ethereum){
    try{
      const accounts = await window.ethereum.request({ method: 'eth_accounts' });
      if(accounts[0]){
        headerState.account = accounts[0].toLowerCase();
        headerState.writeClient = createClient({ chain: testnetBradbury, account: accounts[0], provider: window.ethereum });
      }
    }catch(e){ /* no injected provider yet, or a mid-conflict moment — proceed as disconnected */ }
  }
  renderWalletButton();
  notifyWalletChanged();
})();
