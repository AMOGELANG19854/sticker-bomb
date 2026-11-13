async function image(file, maxSize) {
  if (!file?.size) return null;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width,bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0,0,canvas.width,canvas.height);
  context.drawImage(bitmap,0,0,canvas.width,canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg',.78);
}
function stickerQR(url) {
  const qr = qrcode(0,'M');
  qr.addData(url,'Byte');
  qr.make();
  return qr;
}
// Halftone QR Codes (Chu et al.): retain the module center while
// representing the artwork in the surrounding pixels.
function paintHalftone(qr, pixels, size) {
  const moduleSize = 12;
  const count = qr.getModuleCount();
  const side = (count+8)*moduleSize;
  const output = new Uint8ClampedArray(side*side*4).fill(255);
  const thresholds = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
  for (let y=0; y<count*moduleSize; y++) {
    for (let x=0; x<count*moduleSize; x++) {
      const row = Math.floor(y/moduleSize);
      const col = Math.floor(x/moduleSize);
      const mx = x%moduleSize;
      const my = y%moduleSize;
      const dark = qr.isDark(row,col);
      const finder = (row<9 && (col<9 || col>=count-8)) || (row>=count-8 && col<9);
      const fixed = finder || row===6 || col===6 || (mx>=2 && mx<10 && my>=2 && my<10);
      const source = 4*(Math.floor(y*size/(count*moduleSize))*size+Math.floor(x*size/(count*moduleSize)));
      const luminance = 0.2126*pixels[source]+0.7152*pixels[source+1]+0.0722*pixels[source+2];
      const ink = luminance < (thresholds[(y%4)*4+x%4]+0.5)*16;
      const shade = fixed ? (dark ? 0 : 255) : (dark ? (ink ? 0 : 72) : (ink ? 184 : 255));
      const target = 4*((y+48)*side+x+48);
      output[target] = output[target+1] = output[target+2] = shade;
    }
  }
  return {output,side};
}
async function artworkPixels(source) {
  if (!source) return null;
  const photo = new Image();
  photo.src = source;
  await photo.decode();
  const canvas = document.createElement('canvas');
  const size = canvas.width = canvas.height = 480;
  const context = canvas.getContext('2d');
  const scale = Math.min(size/photo.width,size/photo.height);
  const width = photo.width*scale, height = photo.height*scale;
  context.fillStyle = '#fff';
  context.fillRect(0,0,size,size);
  context.drawImage(photo,(size-width)/2,(size-height)/2,width,height);
  return {pixels:context.getImageData(0,0,size,size).data,size};
}
function qrImage(qr, artwork) {
  if (!artwork) return qr.createDataURL(6);
  const {output,side} = paintHalftone(qr,artwork.pixels,artwork.size);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = side;
  canvas.getContext('2d').putImageData(new ImageData(output,side,side),0,0);
  return canvas.toDataURL('image/png');
}
function scanLink(job,index) {
  return new URL('/s/' + job.id + '/' + (index+1),location.origin).href;
}
async function download(job) {
  const artwork = job.artwork ?? (job.has_artwork ? (await api('artwork/' + job.id)).artwork : null);
  const pixels = await artworkPixels(artwork);
  const doc = new jspdf.jsPDF();
  for (let index = 0; index < job.quantity; index++) {
    const qr = stickerQR(scanLink(job,index));
    if (index && index % 8 === 0) doc.addPage();
    const slot = index % 8;
    const x = 10 + (slot % 2) * 97;
    const y = 10 + Math.floor(slot / 2) * 69;
    doc.setDrawColor(150);
    doc.rect(x,y,93,64);
    doc.setFontSize(12);
    doc.text(doc.splitTextToSize(job.caption || job.name,83).slice(0,2),x+5,y+8);
    if (pixels) doc.addImage(qrImage(qr,pixels),'PNG',x+5,y+16,40,40);
    else {
      const count = qr.getModuleCount();
      const module = 35 / (count + 8);
      doc.setFillColor(0);
      for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
          if (qr.isDark(row,col)) doc.rect(x+5+(col+4)*module,y+17+(row+4)*module,module,module,'F');
        }
      }
    }
    doc.setFontSize(8);
    doc.text(doc.splitTextToSize(job.footer || ('QR sticker  |  '+(index+1)+'/'+job.quantity),83)[0],x+5,y+59);
  }
  doc.save((job.name.toLowerCase().replace(/[^a-z0-9]+/g,'-') || 'stickers') + '.pdf');
}

const byId = id => document.getElementById(id);
const status = message => { byId('status').textContent = message; };
const form = byId('campaign');
let draftId = storageGet('sb-draft-id') || crypto.randomUUID();
storageSave('sb-draft-id',draftId);
let claimJob;
let selectedJobId;
let signupStep = 1;
let backup;
let payoutAddress;
let upgradingWallet = false;
let pendingPhoto;
function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSave(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key,value);
    return true;
  } catch { return false; }
}
let point;
let campaigns = [];
let worker = {profile:null,jobs:[]};
let loaded = false;
let activeView = 'company';
let workKey = '';

function el(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function action(label, run, primary = false) {
  const node = el('button',label,primary ? 'primary' : 'outline');
  node.type = 'button';
  node.addEventListener('click',() => perform(node,run));
  return node;
}
async function perform(node, run) {
  if (node.disabled) return;
  node.disabled = true;
  status('');
  try { await run(); }
  catch (error) { status(error.message); }
  finally { node.disabled = false; }
}
async function api(path, body) {
  const response = await fetch('/api/' + path, body === undefined ? undefined : {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
}
function validatePickupPin(input) {
  if (/^[0-9]{6}$/.test(input.value)) return;
  input.focus();
  throw Error('Pickup PIN must be exactly 6 digits, such as 019997.');
}

let testPoint;
async function draft() {
  if (!form.elements.name.reportValidity() || !form.elements.url.reportValidity()) return;
  const {name,url,caption,pin,footer,area} = Object.fromEntries(new FormData(form));
  if (!name.trim()) throw Error('Enter a campaign name.');
  const destination = new URL(url);
  if (!['http:','https:'].includes(destination.protocol) || destination.href.length > 500) {
    throw Error('Enter an HTTP or HTTPS destination up to 500 characters.');
  }
  if (area === 'local-test' && !testPoint) throw Error('Set the test pin using your current location.');
  return {id:draftId,name:name.trim(),url:destination.href,caption:caption.trim(),footer:footer.trim(),area,pin,artwork:await image(form.elements.artwork.files[0],480),quantity:area === 'local-test' ? 1 : route.length,testPoint};
}
function directions(stop) {
  const link = el('a','Walking directions','direction');
  link.href = 'https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=' + encodeURIComponent(stop.lat + ',' + stop.lng);
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}
async function showSticker(job) {
  const artwork = job.has_artwork ? (await api('artwork/' + job.id)).artwork : null;
  const pixels = await artworkPixels(artwork);
  const dialog = byId('sticker-screen');
  const selector = byId('sticker-number');
  selector.replaceChildren(...campaignRoute(job).map((stop,index) => new Option('Sticker ' + (index+1) + ' · ' + stop.name,index)));
  function render() {
    const index = Number(selector.value);
    const qr = el('img','');
    qr.src = qrImage(stickerQR(scanLink(job,index)),pixels);
    qr.alt = 'Tracking QR for sticker ' + (index+1);
    byId('sticker-art').replaceChildren(el('strong',job.caption || job.name),qr,
      el('small',job.footer || 'QR sticker  |  ' + (index+1) + '/' + campaignRoute(job).length));
  }
  selector.onchange = render;
  render();
  dialog.showModal();
}
function renderCampaigns() {
  const root = byId('campaigns');
  root.replaceChildren();
  if (!loaded) { root.append(el('p','Loading campaigns…')); return; }
  if (!campaigns.length) root.append(el('p','No campaigns published yet.'));
  for (const job of campaigns) {
    const card = el('article','','card');
    card.append(el('h3',job.name),
      el('p',`${areaLabel(job)} · ${job.next_stop}/${campaignRoute(job).length} placements · ${job.status}`),
      action('Download printable PDF',() => download({...job,quantity:campaignRoute(job).length})),
      action('Show sticker artwork',() => showSticker(job)));
    if (job.wallet_owned) card.append(action('Owner analytics',() => showAnalytics(job.id)));
    else if (storageGet('sb-campaign-' + job.id)) {
      card.append(action('Link owner wallet',async () => {
        const signed = await signCampaign(job.id,'link owner');
        await api('link-owner',{id:job.id,key:storageGet('sb-campaign-' + job.id),...signed});
        await refresh();
        status('Owner wallet linked. Open Owner analytics to view scans.');
      }));
    }
    root.append(card);
  }
}
function renderPreview() {
  const {name,url,caption,footer} = Object.fromEntries(new FormData(form));
  const preview = byId('preview');
  preview.replaceChildren(el('strong',caption.trim() || name.trim() || 'Your sticker'));
  const file = form.elements.artwork.files[0];
  byId('remove-artwork').hidden = !file;
  try {
    const destination = new URL(url);
    if (!['http:','https:'].includes(destination.protocol) || destination.href.length > 500) throw Error();
    const qr = el('img','');
    const code = stickerQR(scanLink({id:draftId},0));
    qr.src = qrImage(code,null);
    if (file) image(file,480).then(artworkPixels).then(pixels => {
      if (qr.isConnected && form.elements.artwork.files[0] === file) qr.src = qrImage(code,pixels);
    }).catch(() => {
      if (qr.isConnected) status('Choose a readable sticker photo or remove it to continue.');
    });
    qr.alt = 'Sticker 1 tracking QR code';
    preview.append(qr);
    if (footer.trim()) preview.append(el('span',footer.trim()));
    preview.append(el('span',destination.href,'muted'));
  } catch {
    preview.append(el('p',url ? 'Enter a valid HTTP or HTTPS destination to preview the QR code.' : 'Add a destination to see your QR code.'));
  }
}
async function signCampaign(id,purpose) {
  const wallet = window.ethereum;
  if (!wallet?.request) throw Error('Open Sticker Bomb in an Ethereum wallet browser to sign.');
  const [address] = await wallet.request({method:'eth_requestAccounts'});
  if (!address) throw Error('Connect the campaign owner wallet.');
  const {nonce,message} = await api('challenge',{id,purpose});
  const bytes = Array.from(new TextEncoder().encode(message),byte => byte.toString(16).padStart(2,'0'));
  const signature = await wallet.request({method:'personal_sign',params:['0x' + bytes.join(''),address]});
  return {nonce,signature};
}
let analyticsMap;
async function withPayoutWallet(config,run) {
  const {BrowserProvider,Contract,id} = await import('/vendor/ethers.js');
  await ethereum.request({method:'wallet_switchEthereumChain',params:[{chainId:'0xaa36a7'}]});
  const provider = new BrowserProvider(ethereum);
  if ((await provider.getNetwork()).chainId !== 11155111n) throw Error('Select Sepolia.');
  const signer = await provider.getSigner();
  const token = new Contract(config.token,[
    'function claimed(address) view returns(bool)','function claim()',
    'function allowance(address,address) view returns(uint256)','function approve(address,uint256)'
  ],signer);
  const escrow = new Contract(config.escrow,[
    'function payment() view returns(address)',
    'function campaigns(bytes32) view returns(address company,address printer,uint128 unitPrice,uint16 quantity,uint16 completed)',
    'function fund(bytes32,uint8,uint16,address)','function settle(bytes32,uint16,address,bytes32)',
    'function placed(bytes32,uint16) view returns(bool)'
  ],signer);
  if ((await escrow.payment()).toLowerCase() !== config.token.toLowerCase()) throw Error('Escrow token does not match.');
  async function confirm(transaction) {
    const tx = await transaction;
    status('Submitted on Sepolia: ' + tx.hash);
    if ((await tx.wait())?.status !== 1) throw Error('Sepolia transaction failed.');
    return tx.hash;
  }
  await run({signer,token,escrow,confirm,id});
}
async function demoPayout(step) {
  const config = await api('payout-demo');
  await withPayoutWallet(config,async ({signer,token,escrow,confirm,id}) => {
    const key = id('Sticker Bomb standalone payout demo v1:' + signer.address.toLowerCase());
    const hash = id('Sticker Bomb simulated sample placement v1:' + key);
    if (step === 'claim') {
      if (!await token.claimed(signer.address)) await confirm(token.claim());
      status('Mock USDT ready.');
      return;
    }
    const funded = await escrow.campaigns(key);
    if (step === 'fund') {
      if (!funded.quantity) {
        if (await token.allowance(signer.address,config.escrow) !== 1000000n) {
          await confirm(token.approve(config.escrow,1000000n));
        }
        await confirm(escrow.fund(key,0,1,signer.address));
      }
      status('Demo escrow funded. Select Pay demo placement.');
      return;
    }
    if (funded.company.toLowerCase() !== signer.address.toLowerCase()) throw Error('Fund the demo first.');
    if (await escrow.placed(key,0)) throw Error('This wallet’s demo placement has already been paid.');
    const tx = await confirm(escrow.settle(key,0,signer.address,hash));
    const link = el('a','View Sepolia settlement receipt','direction');
    link.href = 'https://sepolia.etherscan.io/tx/' + tx;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    byId('demo-controls').append(link);
    status('Demo settlement confirmed.');
  });
}
byId('demo-controls').append(
  action('Claim mock USDT',() => demoPayout('claim')),
  action('Fund demo',() => demoPayout('fund')),
  action('Pay demo placement',() => demoPayout('pay'),true)
);
function ownerPayouts(root,campaignId,data) {
  if (!data.payout) return;
  const quantity = campaignRoute(data).length;
  const panel = el('section','','card');
  panel.append(el('h3','Sepolia test payouts'),
    el('p','Funding costs ' + quantity + ' mock USDT. This wallet receives the printer share and can approve worker payments.'),
    action('Claim mock USDT',() => withPayoutWallet(data.payout,async ({signer,token,confirm}) => {
      if (!await token.claimed(signer.address)) await confirm(token.claim());
      status('Mock USDT claimed for ' + signer.address);
    })),
    action('Approve and fund campaign',() => withPayoutWallet(data.payout,async ({signer,token,escrow,confirm,id}) => {
      const key = id('Sticker Bomb campaign:' + campaignId);
      const funding = await escrow.campaigns(key);
      if (funding.quantity) {
        if (funding.company.toLowerCase() !== signer.address.toLowerCase()) throw Error('Switch to the campaign funding wallet.');
        status('Campaign already funded.');
        return;
      }
      const total = BigInt(quantity)*1000000n;
      if (await token.allowance(signer.address,data.payout.escrow) !== total) await confirm(token.approve(data.payout.escrow,total));
      await confirm(escrow.fund(key,0,quantity,signer.address));
      status('Campaign funded on Sepolia.');
    })));
  for (const proof of data.placements) {
    panel.append(action('Pay sticker ' + (proof.stop+1),() => withPayoutWallet(data.payout,async ({signer,escrow,confirm,id}) => {
      const key = id('Sticker Bomb campaign:' + campaignId);
      const funded = await escrow.campaigns(key);
      if (funded.company.toLowerCase() !== signer.address.toLowerCase()) throw Error('Use the wallet that funded this campaign.');
      if (await escrow.placed(key,proof.stop)) { status('Already settled. The worker can check the payout receipt.'); return; }
      const tx = await confirm(escrow.settle(key,proof.stop,proof.wallet,'0x'+proof.hash));
      status('Settlement confirmed. Worker can check payout. Transaction: ' + tx);
    })));
  }
  root.append(panel);
}
function ownerHandoff(root,id,reply) {
  const panel = el('form','','card');
  const note = el('textarea','');
  note.maxLength = 500;
  const instructions = el('label','Pickup instructions');
  instructions.append(note);
  const pinLabel = el('label','Release pickup PIN (optional, 6 digits)');
  const pin = el('input','');
  pin.inputMode = 'numeric';
  pin.maxLength = 6;
  pin.autocomplete = 'off';
  pinLabel.append(pin);
  const send = el('button','Send to claimed worker','primary');
  panel.append(el('h3','Pickup handoff'),el('p','Send instructions once the job is claimed. Include the original PIN once the worker has the stickers.'),instructions,pinLabel,send);
  panel.onsubmit = event => {
    event.preventDefault();
    perform(send,async () => {
      if (pin.value) validatePickupPin(pin);
      if (!pin.value && !note.value.trim()) throw Error('Enter pickup instructions or a PIN.');
      const signed = await signCampaign(id,'pickup handoff');
      await api('handoff',{id,note:note.value,pin:pin.value,...signed});
      panel.reset();
      status('Pickup handoff sent to the claimed worker.');
    });
  };
  if (reply) panel.prepend(el('p','Worker requested a different time: ' + reply));
  root.append(panel);
}
async function showAnalytics(id) {
  const signed = await signCampaign(id,'analytics');
  const data = await api('analytics',{id,...signed});
  const root = byId('progress');
  analyticsMap?.remove();
  const heading = el('h2',data.name + ' analytics');
  heading.tabIndex = -1;
  const stops = campaignRoute(data);
  const counts = new Map(data.scans.map(item => [item.stop,item.total]));
  const map = el('div','','scan-map');
  map.setAttribute('aria-label','Map of all sticker stops');
  root.replaceChildren(heading,
    el('p',`${[...counts.values()].reduce((sum,value) => sum + value,0)} total scans · ${data.next_stop}/${stops.length} activated`),
    action('Refresh scans',() => showAnalytics(id)),
    action('Close analytics',() => {
      root.hidden = true;
      byId('published-heading').focus();
    }),
    map,el('p','Gray · 0 scans   /   Blue · 1–9   /   Lime · 10+','notice'));
  const list = el('ol','','progress-list');
  root.hidden = false;
  analyticsMap = L.map(map).fitBounds(stops.map(stop => [stop.lat,stop.lng]),{padding:[24,24],maxZoom:17});
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(analyticsMap);
  stops.forEach((stop,index) => {
    const total = counts.get(index) ?? 0;
    const label = `${stop.name} · ${total} ${total === 1 ? 'scan' : 'scans'}`;
    list.append(el('li',label + (index < data.next_stop ? ' · Active' : ' · Awaiting activation')));
    const marker = L.divIcon({
      className:'scan-pin ' + (total >= 10 ? 'high' : total ? 'some' : 'zero'),
      html:String(index+1),iconSize:[27,27],iconAnchor:[13,13]
    });
    L.marker([stop.lat,stop.lng],{icon:marker,title:label}).bindPopup(el('span',label)).addTo(analyticsMap);
  });
  root.append(list);
  ownerHandoff(root,id,data.pickup_reply);
  ownerPayouts(root,id,data);
  heading.focus();
}
function readLocation() {
  if (!navigator.geolocation) throw Error('Location is unavailable in this browser.');
  return new Promise((resolve,reject) => navigator.geolocation.getCurrentPosition(({coords}) => {
    resolve({lat:coords.latitude,lng:coords.longitude,accuracy:coords.accuracy});
  }, error => reject(Error(error.code === 1
    ? 'Allow location in your browser settings, then try again.'
    : 'Could not get your location. Move somewhere with a clear signal and try again.')), {timeout:15000,maximumAge:0,enableHighAccuracy:true}));
}
function readPreciseLocation(report) {
  const geo = navigator.geolocation;
  if (!geo) throw Error('Location is unavailable in this browser.');
  report('Looking for a precise GPS reading…');
  return new Promise((resolve,reject) => {
    let best = Infinity;
    let watch;
    const finish = (error,fix) => {
      clearTimeout(timer);
      if (watch !== undefined) geo.clearWatch(watch);
      if (error) reject(Error(error));
      else resolve(fix);
    };
    const timer = setTimeout(() => finish(Number.isFinite(best)
      ? 'Best GPS accuracy was about ' + Math.ceil(best) + ' m. Move into the open and retry.'
      : 'Could not get your location. Move into the open and retry.'),30000);
    try {
      watch = geo.watchPosition(({coords}) => {
        best = Math.min(best,coords.accuracy);
        if (coords.accuracy <= 50) {
          finish(null,{lat:coords.latitude,lng:coords.longitude,accuracy:coords.accuracy});
        } else {
          report('Best GPS accuracy so far: about ' + Math.ceil(best) + ' m. Waiting for 50 m or better…');
        }
      },error => {
        if (error.code === 1) finish('Allow location in your browser settings, then try again.');
      },{maximumAge:0,enableHighAccuracy:true});
    } catch (error) {
      finish(error.message);
    }
  });
}
async function shareLocation() { point = await readLocation(); }
function renderArea() {
  const local = form.elements.area.value === 'local-test';
  byId('local-pin').hidden = !local;
  byId('sea-point-stops').hidden = local;
}
form.elements.area.addEventListener('change',renderArea);
byId('use-location').onclick = event => perform(event.currentTarget,async () => {
  testPoint = null;
  byId('pin-status').textContent = '';
  const fix = await readPreciseLocation(message => { byId('pin-status').textContent = message; })
    .catch(error => { byId('pin-status').textContent = ''; throw error; });
  testPoint = fix;
  byId('pin-status').textContent = 'Test pin saved. One sticker.';
});
renderArea();
async function claimSelected() {
  const job = claimJob;
  await shareLocation();
  if (claimJob !== job) return;
  if (!withinJobRadius(point,job)) {
    renderWorker();
    return;
  }
  try {
    if (!worker.profile) worker.profile = await api('profile',{name:byId('profile').elements.name.value.trim(),wallet:payoutAddress});
    await api('claim',{id:job.id,point});
    selectedJobId = job.id;
    claimJob = null;
  } finally {
    await refresh();
  }
}
function renderPlacement(root,current) {
  const stops = campaignRoute(current);
  const stop = stops[current.next_stop];
  const photoKey = 'sb-placement-' + current.id + '-' + current.next_stop;
  const wallKey = photoKey + '-wall';
  root.append(el('p',current.name + ' · Sticker ' + (current.next_stop+1) + ' of ' + stops.length,'kicker'));
  if (current.pickup_required && !current.picked_up) {
    root.append(el('h3','Confirm sticker pickup'),
      el('p','Get the pickup PIN from the campaign owner when you collect the stickers.'));
    if (current.pickup_note) root.append(el('p',current.pickup_note,'card'));
    if (current.released_pin) root.append(el('p','PIN from campaign owner: ' + current.released_pin,'card'));
    else root.append(el('p','Any instructions or PIN shared in Sticker Bomb will appear here.'));
    if (current.pickup_note) {
      const request = el('details','');
      const form = el('form','');
      const label = el('label','Proposed pickup time');
      const input = el('textarea','');
      input.required = true;
      input.maxLength = 300;
      input.value = current.pickup_reply ?? '';
      const send = el('button','Send request','primary');
      label.append(input);
      form.append(label,send);
      form.onsubmit = event => {
        event.preventDefault();
        perform(send,async () => {
          await api('pickup-reply',{id:current.id,reply:input.value});
          status('Pickup time request sent.');
          await refresh();
        });
      };
      request.append(el('summary','Request a different time'),form);
      root.append(request);
    }
    const pickup = el('form','');
    const label = el('label','Pickup PIN (6 digits)');
    const pin = el('input','');
    pin.inputMode = 'numeric';
    pin.maxLength = 6;
    pin.autocomplete = 'off';
    const help = el('small','Enter exactly 6 digits, such as 019997.');
    help.id = 'worker-pin-help';
    pin.setAttribute('aria-describedby',help.id);
    label.append(help,pin);
    const confirm = el('button','Confirm pickup','primary');
    pickup.append(label,confirm);
    pickup.onsubmit = event => {
      event.preventDefault();
      perform(confirm,async () => {
        validatePickupPin(pin);
        await api('pickup',{id:current.id,pin:pin.value});
        const latest = worker.jobs.find(job => job.id === current.id);
        if (latest) latest.picked_up = 1;
        renderWorker();
        await refresh();
      });
    };
    root.append(pickup,action('Download stickers',() => download({...current,quantity:stops.length})));
    return;
  }
  if (pendingPhoto?.key !== photoKey) {
    const photo = storageGet(photoKey);
    pendingPhoto = photo ? {key:photoKey,photo} : null;
  }
  root.append(el('h3','Go to ' + stop.name),directions(stop));
  if (!storageGet(wallKey) && !pendingPhoto && confirmedWall !== wallKey) {
    root.append(el('p','Get permission for the surface and place the matching numbered sticker.'),
      action('Sticker is on the wall',() => {
        confirmedWall = wallKey;
        storageSave(wallKey,'yes');
        workKey = '';
        renderWorker();
      },true));
    return;
  }
  const wall = el('figure','','wall-preview');
  const artwork = el('div','','wall-sticker');
  const code = el('img','');
  code.src = stickerQR(scanLink(current,current.next_stop)).createDataURL(4);
  code.alt = '';
  artwork.append(el('strong',current.caption || current.name),code,
    el('small',current.footer || 'QR sticker  |  ' + (current.next_stop+1) + '/' + stops.length));
  if (current.has_artwork) api('artwork/' + current.id).then(({artwork:source}) => {
    return artworkPixels(source).then(pixels => { code.src = qrImage(stickerQR(scanLink(current,current.next_stop)),pixels); });
  }).catch(() => {});
  wall.append(artwork,el('figcaption','Placement preview'));
  root.append(wall);
  const camera = el('input','');
  camera.type = 'file';
  camera.accept = 'image/*';
  camera.setAttribute('capture','environment');
  camera.hidden = true;
  const actions = el('div','','actions');
  const capture = action(pendingPhoto ? 'Retake photo' : 'Take proof photo',() => camera.click(),!pendingPhoto);
  camera.onchange = () => {
    const file = camera.files[0];
    camera.value = '';
    if (!file) return;
    perform(capture,async () => {
      const photo = await image(file,640);
      storageSave(photoKey,photo);
      pendingPhoto = {key:photoKey,photo};
      workKey = '';
      renderWorker();
    });
  };
  if (pendingPhoto) {
    const photo = pendingPhoto.photo;
    const preview = el('img','','proof');
    preview.src = photo;
    preview.alt = 'Your placement photo';
    const activate = action('Share GPS and activate',async () => {
      capture.disabled = true;
      try {
        const placementPoint = await readPreciseLocation(status);
        const result = await api('photo',{id:current.id,stop:current.next_stop,photo,point:placementPoint,placed:true});
        storageSave(photoKey,null);
        storageSave(wallKey,null);
        pendingPhoto = null;
        const latest = worker.jobs.find(job => job.id === current.id);
        if (latest) latest.next_stop = Math.max(latest.next_stop,current.next_stop+1);
        renderWorker();
        status('Sticker activated. ' + (result.payment === 'paid' ? 'Sepolia USDT paid.' : result.payment === 'pending' ? 'Payout pending confirmation.' : 'Sepolia payout unavailable.'));
        try { await refresh(); } catch {}
      } finally { capture.disabled = false; }
    },true);
    root.append(preview);
    actions.append(activate);
  }
  actions.append(capture,camera);
  root.append(actions);
}
let confirmedWall;
function walletSignup(root) {
  if (!backup) {
    root.append(el('h3','Create your payout wallet'),
      el('p','Find a private place. You’ll write down 24 recovery words to access your wallet later.'),
      action('Create wallet',async () => {
        const {HDNodeWallet,Mnemonic} = await import('/vendor/ethers.js');
        const wallet = HDNodeWallet.fromMnemonic(Mnemonic.fromEntropy(crypto.getRandomValues(new Uint8Array(32))));
        const words = wallet.mnemonic.phrase.split(' ');
        if (words.length !== 24) throw Error('Wallet backup could not be created.');
        const random = crypto.getRandomValues(new Uint8Array(1))[0];
        backup = {words,address:wallet.address,word:random % words.length,verify:false};
        workKey = '';
        renderWorker();
      },true));
    return;
  }
  if (!backup.verify) {
    const list = el('ol','','recovery-words');
    for (const word of backup.words) list.append(el('li',word));
    root.append(el('h3','Write down your recovery words'),
      el('p','Keep them in order on paper in a safe place. Anyone with these words can control the wallet. Avoid screenshots, cloud notes, and sharing.'),
      list,action('I’ve written them down',() => {
        backup.verify = true;
        workKey = '';
        renderWorker();
      },true));
    return;
  }
  const form = el('form','');
  form.autocomplete = 'off';
  const label = el('label','Recovery word ' + (backup.word+1));
  const input = el('input','');
  input.type = 'password';
  input.required = true;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.autocapitalize = 'none';
  label.append(input);
  const submit = el('button','Verify backup','primary');
  form.append(label,submit);
  form.onsubmit = event => {
    event.preventDefault();
    perform(submit,async () => {
      const entered = input.value.trim().toLowerCase();
      input.value = '';
      if (entered !== backup.words[backup.word]) throw Error('That word does not match. Check your paper backup.');
      payoutAddress = backup.address;
      if (upgradingWallet) {
        const {wallet} = await api('wallet',{wallet:payoutAddress});
        worker.profile.wallet = wallet;
        upgradingWallet = false;
        payoutAddress = null;
        workKey = '';
      }
      backup = null;
      signupStep = 3;
      renderWorker();
    });
  };
  root.append(el('h3','Verify your backup'),form,action('Review words',() => {
    backup.verify = false;
    workKey = '';
    renderWorker();
  }));
}
function renderPayout(root, job) {
  if (!job.next_stop) return;
  const panel = el('section','','card');
  panel.append(el('h4','Placement payouts'));
  for (let stop = job.next_stop-1; stop>=0; stop--) {
    const info = worker.payouts?.find(item => item.campaign === job.id && item.stop === stop);
    const row = el('div','','payout-record');
    const label = el('p','');
    const recipient = el('p','','muted');
    const amount = el('p','');
    const receipt = el('a','View Sepolia receipt','direction');
    receipt.target = '_blank';
    receipt.rel = 'noopener noreferrer';
    function update(result) {
      const state = result?.status === 'paid' ? 'Paid'
        : result?.status === 'pending' ? (result.tx ? 'Pending confirmation' : 'Funded · awaiting settlement')
        : 'Payout unavailable';
      label.textContent = 'Sticker ' + (stop+1) + ' · ' + state;
      const wallet = result?.recipient ?? worker.profile?.wallet;
      recipient.textContent = wallet ? 'Destination wallet: ' + wallet : 'No payout wallet linked.';
      amount.textContent = result?.amount == null ? 'Sepolia USDT amount unavailable'
        : (Number(result.amount)/1e6).toLocaleString(undefined,{maximumFractionDigits:6}) + ' Sepolia USDT';
      receipt.hidden = result?.status !== 'paid' || !result.tx;
      if (result?.tx) receipt.href = 'https://sepolia.etherscan.io/tx/' + result.tx;
    }
    update(info);
    row.append(label,recipient,amount,receipt);
    if (info?.status !== 'paid' && worker.profile?.wallet) row.append(action('Check payout',async () => {
      const result = await api('payout',{id:job.id,stop,retry:true});
      update(result);
      await refresh();
    }));
    panel.append(row);
  }
  root.append(panel);
}
function renderWorker() {
  const root = byId('work');
  const profile = byId('profile');
  const current = worker.jobs.find(job => job.id === selectedJobId);
  const available = campaigns.filter(job => job.status === 'available');
  if (claimJob && !available.some(job => job.id === claimJob.id)) claimJob = null;
  const key = JSON.stringify([loaded,worker,point,claimJob,signupStep,available,upgradingWallet,selectedJobId]);
  if (key === workKey) return;
  workKey = key;
  root.replaceChildren();
  profile.hidden = true;
  if (!loaded) { root.append(el('p','Loading jobs…')); return; }
  if (upgradingWallet && !worker.profile?.wallet) {
    walletSignup(root);
    root.append(action('Back',() => {
      upgradingWallet = false;
      backup = null;
      payoutAddress = null;
      renderWorker();
    }));
    return;
  }
  if (worker.profile && !worker.profile.wallet) root.append(action('Set up payout wallet',() => {
    upgradingWallet = true;
    renderWorker();
  }));
  if (claimJob) {
    root.append(el('h3',claimJob.name),el('p',areaLabel(claimJob)));
    if (!worker.profile && signupStep === 1) {
      root.append(el('p','Step 1 of 3 · Worker profile','kicker'));
      profile.hidden = false;
    } else if (!worker.profile && signupStep === 2) {
      root.append(el('p','Step 2 of 3 · Wallet backup','kicker'));
      walletSignup(root);
      root.append(action('Back',() => {
        signupStep = 1;
        renderWorker();
      }));
    } else {
      if (!worker.profile) root.append(el('p','Step 3 of 3 · Location','kicker'));
      root.append(el('p','Share your location within 50 km of the placement area to claim this job.'));
      if (point && !withinJobRadius(point,claimJob)) {
        root.append(el('p','You’re more than 50 km from the placement area. Check again when you’re closer.'),directions(campaignRoute(claimJob)[0]));
      }
      const actions = el('div','','actions');
      actions.append(action('Share location and claim',claimSelected,true),
        action('Back',() => {
          if (worker.profile) return cancelClaim();
          signupStep = 1;
          point = null;
          renderWorker();
          profile.elements.name.focus();
        }));
      root.append(actions);
    }
    return;
  }
  root.append(el('h3','My Jobs'));
  if (!worker.jobs.length) root.append(el('p','No claimed jobs yet.'));
  for (const job of worker.jobs) {
    const card = el('article','','card');
    const toggle = action(job.id === selectedJobId ? 'Close job' : 'Open job',() => {
      selectedJobId = job.id === selectedJobId ? null : job.id;
      renderWorker();
    });
    toggle.setAttribute('aria-expanded',String(job.id === selectedJobId));
    card.append(el('h4',job.name),el('p',areaLabel(job) + ' · ' + job.next_stop + '/' + campaignRoute(job).length + ' activated'),toggle);
    if (job.id === current?.id) {
      if (job.next_stop < campaignRoute(job).length) renderPlacement(card,job);
      else card.append(el('p','All stickers activated.'));
      renderPayout(card,job);
    }
    root.append(card);
  }
  root.append(el('h3','Available Jobs'));
  const nearby = available.filter(job => withinJobRadius(point,job));
  if (available.length && !nearby.length) {
    root.append(el('p',point ? 'No jobs within 50 km.' : 'Share your location to find jobs within 50 km.'),
      action('Check location',async () => {
        await shareLocation();
        renderWorker();
      },true));
    return;
  }
  if (!available.length) root.append(el('p','Waiting for jobs'));
  for (const job of nearby) {
    const card = el('article','','card');
    card.append(el('h3',job.name),el('p',campaignRoute(job).length + ' · ' + areaLabel(job)),
      action('Claim job',() => {
        claimJob = job;
        signupStep = 1;
        renderWorker();
        (profile.hidden ? root.querySelector('button.primary') : profile.elements.name)?.focus();
      },true));
    root.append(card);
  }
}
function cancelClaim() {
  claimJob = null;
  signupStep = 1;
  backup = null;
  payoutAddress = null;
  point = null;
  status('');
  renderWorker();
  byId('work').querySelector('button')?.focus();
}
let requestNumber = 0;
async function refresh() {
  const number = ++requestNumber;
  const [jobs, info] = await Promise.all([api('campaigns'),api('worker')]);
  if (number !== requestNumber) return;
  const changed = !loaded || JSON.stringify(campaigns) !== JSON.stringify(jobs);
  campaigns = jobs;
  worker = info;
  loaded = true;
  if (changed) renderCampaigns();
  renderWorker();
}
byId('remove-artwork').onclick = () => {
  form.elements.artwork.value = '';
  status('');
  renderPreview();
  form.elements.artwork.focus();
};
form.addEventListener('input',renderPreview);
renderPreview();
renderCampaigns();
renderWorker();
byId('cancel-claim').onclick = cancelClaim;
byId('draft').onclick = event => perform(event.currentTarget,async () => {
  const job = await draft();
  if (job) await download(job);
});
form.onsubmit = event => {
  event.preventDefault();
  perform(event.submitter,async () => {
    const job = await draft();
    if (!job) return;
    validatePickupPin(form.elements.pin);
    const signed = await signCampaign(job.id,'publish');
    await api('campaigns',{...job,...signed});
    draftId = crypto.randomUUID();
    storageSave('sb-draft-id',draftId);
    form.reset();
    testPoint = null;
    byId('pin-status').textContent = '';
    renderArea();
    renderPreview();
    status('Campaign published. Give the pickup PIN to the worker at handoff.');
    await refresh();
  });
};
byId('profile').onsubmit = event => {
  event.preventDefault();
  perform(event.submitter,async () => {
    const profile = byId('profile');
    const name = profile.elements.name.value.trim();
    if (!name) throw Error('Enter your name to continue.');
    signupStep = payoutAddress ? 3 : 2;
    renderWorker();
    byId('work').querySelector('button')?.focus();
  });
};
for (const stop of route) {
  const item = el('li',stop.name + (stop.walk ? ` · about ${stop.walk} m from La Perla ` : ' '));
  item.append(directions(stop));
  byId('stops').append(item);
}
for (const tab of document.querySelectorAll('nav button')) tab.onclick = () => {
  activeView = tab.dataset.view;
  for (const item of document.querySelectorAll('nav button')) {
    item.setAttribute('aria-pressed',String(tab === item));
    byId(item.dataset.view).hidden = tab !== item;
  }
  if (activeView !== 'worker' && backup) {
    backup = null;
    workKey = '';
    byId('work').replaceChildren();
  } else if (activeView === 'worker') renderWorker();
  status('');
  refresh().catch(error => status(error.message));
};
renderWorker();
refresh().catch(error => status(error.message));
setInterval(() => {
  if (!document.hidden && (activeView === 'worker' || loaded)) refresh().catch(error => status(error.message));
},5000);

let installEvent;
const install = byId('install');
const installButton = byId('install-go');
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
function offerInstall() {
  install.hidden = Boolean(installed() || storageGet('sb-install-dismissed'));
}
window.addEventListener('beforeinstallprompt',event => {
  event.preventDefault();
  installEvent = event;
  offerInstall();
});
window.addEventListener('appinstalled',() => { install.hidden = true; });
byId('install-close').onclick = () => {
  storageSave('sb-install-dismissed','yes');
  install.hidden = true;
};
installButton.onclick = async () => {
  if (installEvent) {
    const prompt = installEvent;
    installEvent = null;
    await prompt.prompt();
    if ((await prompt.userChoice).outcome === 'accepted') install.hidden = true;
    return;
  }
  byId('install-note').textContent = /iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)
    ? 'In Safari, tap Share → Add to Home Screen.'
    : 'Open the browser menu and choose Install app or Add to Home screen.';
  installButton.hidden = true;
};
offerInstall();
