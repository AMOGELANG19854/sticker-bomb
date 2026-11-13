const stops = globalThis.route;
const campaignId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pinDigest = (id, pin) => hash(encode(id + ':' + pin));
const locationTolerance = 50;
const signatureLifetime = 5 * 60 * 1000;

async function consumeSignature(query, data, id, purpose) {
  if (typeof data.nonce !== 'string' || !campaignId.test(data.nonce) ||
      typeof data.signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(data.signature)) return null;
  const challenge = await query('SELECT message FROM wallet_challenges WHERE nonce=? AND expires>?',data.nonce,Date.now()).first();
  if (!challenge?.message.includes('\nAction: ' + purpose + '\nCampaign: ' + id + '\n')) return null;
  let address;
  try { address = chain.verifyMessage(challenge.message,data.signature).toLowerCase(); }
  catch { return null; }
  const consumed = await query('DELETE FROM wallet_challenges WHERE nonce=? AND expires>?',data.nonce,Date.now()).run();
  return consumed.meta.changes === 1 ? address : null;
}
const json = (data, status = 200, headers = {}) => Response.json(data, {
  status, headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}
});
const fail = (message, status) => json({error:message}, status);
const hash = async data => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)), n => n.toString(16).padStart(2,'0')).join('');
const encode = text => new TextEncoder().encode(text);

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && Object.hasOwn(assets,path)) {
      const [type, body] = assets[path];
      return new Response(type.startsWith('image/') ? Uint8Array.from(atob(body),char => char.charCodeAt(0)) : body,{headers:{
        'Content-Type':type, 'X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://tile.openstreetmap.org; frame-ancestors 'self'"
      }});
    }
    const scan = path.match(/^\/s\/([0-9a-f-]{36})\/(\d{1,2})$/);
    if (!scan && !path.startsWith('/api/')) return fail('Page not found.',404);
    if (!env.DB) return fail('Campaign storage is unavailable.',503);
    const query = (sql,...args) => env.DB.prepare(sql).bind(...args);
    try {
      if (scan) {
        const [,id,number] = scan;
        const stop = Number(number) - 1;
        if (request.method !== 'GET' || !campaignId.test(id) || stop < 0 || stop >= stops.length) {
          return fail('Sticker link unavailable.',404);
        }
        const campaign = await query('SELECT url,next_stop FROM campaigns WHERE id=?',id).first();
        if (!campaign || campaign.next_stop <= stop) {
          return new Response('This sticker is awaiting activation.',{status:404,headers:{
            'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'
          }});
        }
        const prefetch = /prefetch|prerender/i.test((request.headers.get('Sec-Purpose') ?? '') + (request.headers.get('Purpose') ?? ''));
        if (!prefetch) await query(`INSERT INTO scan_totals (campaign,stop) VALUES (?,?)
          ON CONFLICT(campaign,stop) DO UPDATE SET total=total+1`,id,stop).run();
        return new Response(null,{status:302,headers:{Location:campaign.url,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
      }
      const token = request.headers.get('Cookie')?.match(/(?:^|; )sb_worker=([a-f0-9]{64})(?:;|$)/)?.[1];
      const worker = token && await query('SELECT * FROM workers WHERE id = ?',await hash(encode(token))).first();
      const artworkId = path.slice('/api/artwork/'.length);
      if (request.method === 'GET' && path.startsWith('/api/artwork/') && campaignId.test(artworkId)) {
        const row = await query('SELECT artwork FROM campaigns WHERE id=?',artworkId).first();
        return row ? json(row) : fail('Campaign not found.',404);
      }
      if (request.method === 'GET' && path === '/api/payout-demo') {
        const {SEPOLIA_ESCROW_ADDRESS:escrow,SEPOLIA_USDT_ADDRESS:token} = env;
        if (!addressPattern.test(escrow) || !addressPattern.test(token)) return fail('Sepolia payout demo is unavailable.',503);
        return json({escrow,token});
      }
      if (request.method === 'GET' && path === '/api/campaigns') {
        const {results} = await query(`SELECT id,name,url,caption,footer,area,test_lat,test_lng,artwork IS NOT NULL AS has_artwork,next_stop,owner_wallet IS NOT NULL AS wallet_owned,
          CASE WHEN worker IS NULL THEN 'available' WHEN next_stop >= CASE WHEN area='local-test' THEN 1 ELSE ? END THEN 'complete'
          ELSE 'claimed' END AS status FROM campaigns ORDER BY created DESC LIMIT 100`,stops.length).all();
        return json(results);
      }
      if (request.method === 'GET' && path === '/api/worker') {
        if (!worker) return json({profile:null, jobs:[]});
        const {results} = await query('SELECT id,name,url,caption,footer,area,test_lat,test_lng,artwork IS NOT NULL AS has_artwork,next_stop,picked_up,pickup_note,pickup_reply,released_pin,pickup_hash IS NOT NULL AS pickup_required FROM campaigns WHERE worker = ? ORDER BY created DESC',worker.id).all();
        const {results:payouts} = await query(`SELECT pp.campaign,pp.stop,pp.tx,pp.paid_at,pp.recipient,pp.amount_units FROM placement_payouts pp
          JOIN campaigns c ON c.id=pp.campaign WHERE c.worker=? ORDER BY pp.campaign,pp.stop`,worker.id).all();
        return json({profile:{name:worker.name,wallet:worker.wallet},jobs:results,
          payouts:payouts.map(row => ({campaign:row.campaign,...payoutStatus(row)}))});
      }
      if (request.method !== 'POST') return fail('Page not found.',404);
      if (request.headers.get('Origin') !== new URL(request.url).origin ||
          !request.headers.get('Content-Type')?.startsWith('application/json')) {
        return fail('Invalid request origin or content type.',403);
      }
      const limit = 380000;
      const reader = request.body?.getReader();
      if (!reader) return fail('Missing request body.',400);
      const decoder = new TextDecoder();
      let size = 0;
      let body = '';
      for (;;) {
        const {value,done} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          return fail('Photo is too large.',413);
        }
        body += decoder.decode(value,{stream:true});
      }
      let data;
      try { data = JSON.parse(body + decoder.decode()); }
      catch { return fail('Invalid JSON.',400); }
      if (!data || typeof data !== 'object') return fail('Invalid form.',400);
      if (path === '/api/challenge') {
        if (typeof data.id !== 'string' || !campaignId.test(data.id) || !['publish','analytics','link owner','pickup handoff'].includes(data.purpose)) {
          return fail('Invalid wallet request.',400);
        }
        const nonce = crypto.randomUUID();
        const expires = Date.now() + signatureLifetime;
        const message = `Sticker Bomb wallet verification\nOrigin: ${new URL(request.url).origin}\nAction: ${data.purpose}\nCampaign: ${data.id}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}\nThis signature does not authorize a transaction.`;
        await query('DELETE FROM wallet_challenges WHERE expires<=?',Date.now()).run();
        await query('INSERT INTO wallet_challenges (nonce,message,expires) VALUES (?,?,?)',nonce,message,expires).run();
        return json({nonce,message});
      }
      if (path === '/api/link-owner') {
        const address = await consumeSignature(query,data,data.id,'link owner');
        if (!address || typeof data.key !== 'string' || !/^[a-f0-9]{64}$/.test(data.key)) return fail('Owner verification failed.',403);
        const result = await query('UPDATE campaigns SET owner_wallet=? WHERE id=? AND publisher=? AND owner_wallet IS NULL',
          address,data.id,await hash(encode(data.key))).run();
        if (result.meta.changes !== 1) return fail('Owner verification failed.',403);
        return json({linked:true});
      }
      if (path === '/api/handoff') {
        const address = await consumeSignature(query,data,data.id,'pickup handoff');
        if (!address) return fail('Verify the campaign owner wallet.',403);
        const note = typeof data.note === 'string' ? data.note.trim() : '';
        const pin = data.pin ?? '';
        if (note.length > 500 || (pin !== '' && (typeof pin !== 'string' || !/^\d{6}$/.test(pin)))) {
          return fail('Use up to 500 characters and a six-digit PIN if releasing it.',400);
        }
        if (!note && !pin) return fail('Enter pickup instructions or a PIN.',400);
        const campaign = await query('SELECT worker,pickup_hash,picked_up FROM campaigns WHERE id=? AND owner_wallet=?',data.id,address).first();
        if (!campaign?.worker || campaign.picked_up || !campaign.pickup_hash) return fail('This campaign has no pending worker pickup.',409);
        if (pin && await pinDigest(data.id,pin) !== campaign.pickup_hash) return fail('Enter the PIN you set when publishing.',400);
        const result = await query(`UPDATE campaigns SET pickup_note=COALESCE(?,pickup_note),released_pin=COALESCE(?,released_pin)
          WHERE id=? AND owner_wallet=? AND worker=? AND picked_up=0`,note || null,pin || null,data.id,address,campaign.worker).run();
        return result.meta.changes === 1 ? json({saved:true}) : fail('Pickup is no longer pending.',409);
      }
      if (path === '/api/analytics') {
        const address = await consumeSignature(query,data,data.id,'analytics');
        if (!address) return fail('Verify the campaign owner wallet.',403);
        const campaign = await query('SELECT name,area,test_lat,test_lng,pickup_reply,next_stop,worker IS NOT NULL AS claimed FROM campaigns WHERE id=? AND owner_wallet=?',
          data.id,address).first();
        if (!campaign) return fail('Verify the campaign owner wallet.',403);
        const {results:scans} = await query('SELECT stop,total FROM scan_totals WHERE campaign=?',data.id).all();
        const {results:placements} = await query(`SELECT p.stop,p.hash,w.wallet FROM proofs p
          JOIN campaigns c ON c.id=p.campaign JOIN workers w ON w.id=c.worker
          WHERE p.campaign=? AND w.wallet IS NOT NULL ORDER BY p.stop`,data.id).all();
        const payout = env.SEPOLIA_ESCROW_ADDRESS && env.SEPOLIA_USDT_ADDRESS
          ? {escrow:env.SEPOLIA_ESCROW_ADDRESS,token:env.SEPOLIA_USDT_ADDRESS} : null;
        return json({...campaign,scans,placements,payout});
      }
      if (path === '/api/campaigns') {
        const name = typeof data.name === 'string' && data.name.trim();
        const caption = typeof data.caption === 'string' && data.caption.trim();
        let url;
        try { url = new URL(data.url); } catch {}
        if (!name || name.length > 70 || caption === false || caption.length > 90 ||
            !url || !['https:','http:'].includes(url.protocol) || url.href.length > 500) {
          return fail('Enter a campaign name and valid QR destination.',400);
        }
        if (typeof data.id !== 'string' || !campaignId.test(data.id) ||
            typeof data.pin !== 'string' || !/^\d{6}$/.test(data.pin)) return fail('Enter a six-digit pickup PIN.',400);
        const area = data.area ?? 'sea-point';
        if (area !== 'local-test' && !Object.hasOwn(campaignAreas,area)) return fail('Choose a supported placement area.',400);
        const pinPoint = area === 'local-test' ? data.testPoint : null;
        if (area === 'local-test' && (!pinPoint || !Number.isFinite(placementDistance(pinPoint,pinPoint)) ||
          !Number.isFinite(pinPoint.accuracy) || pinPoint.accuracy < 0 || pinPoint.accuracy > locationTolerance)) {
          return fail('Set a current location accurate to within 50 metres.',400);
        }
        const lat = pinPoint?.lat ?? null;
        const lng = pinPoint?.lng ?? null;
        const footer = typeof data.footer === 'string' ? data.footer.trim() : '';
        if (footer.length > 90) return fail('Use up to 90 characters below the QR.',400);
        const artwork = data.artwork ?? null;
        if (artwork !== null && (typeof artwork !== 'string' || artwork.length > 300000 ||
            !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+={0,2}$/.test(artwork))) return fail('Choose a readable sticker photo.',400);
        const address = await consumeSignature(query,data,data.id,'publish');
        if (!address) return fail('Sign with the campaign owner wallet to publish.',403);
        const pickup = await pinDigest(data.id,data.pin);
        const result = await query(`INSERT INTO campaigns (id,name,url,caption,created,owner_wallet,pickup_hash,artwork,footer,area,test_lat,test_lng)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,data.id,name,url.href,caption,Date.now(),address,pickup,artwork,footer,area,lat,lng).run();
        const prior = result.meta.changes === 0 && await query('SELECT name,url,caption,owner_wallet,pickup_hash,artwork,footer,area,test_lat,test_lng FROM campaigns WHERE id=?',data.id).first();
        if (prior && (prior.name !== name || prior.url !== url.href || prior.caption !== caption ||
            prior.owner_wallet !== address || prior.pickup_hash !== pickup || prior.artwork !== artwork || prior.footer !== footer || prior.area !== area || prior.test_lat !== lat || prior.test_lng !== lng)) {
          return fail('This campaign has already been published.',409);
        }
        return json({id:data.id},201);
      }
      if (path === '/api/profile') {
        const name = typeof data.name === 'string' && data.name.trim();
        const wallet = typeof data.wallet === 'string' ? data.wallet.trim() || null : null;
        if (!name || name.length > 50 || (wallet && !/^0x[0-9a-f]{40}$/i.test(wallet))) {
          return fail('Enter your name and a valid Sepolia wallet address if available.',400);
        }
        if (worker) return fail('This browser already has a profile.',409);
        const secret = crypto.randomUUID().replaceAll('-','') + crypto.randomUUID().replaceAll('-','');
        await query('INSERT INTO workers (id,name,wallet) VALUES (?,?,?)',await hash(encode(secret)),name,wallet).run();
        return json({name,wallet},201,{'Set-Cookie':`sb_worker=${secret}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Strict`});
      }
      if (!worker) return fail('Create a worker profile first.',401);
      if (path === '/api/wallet') {
        if (typeof data.wallet !== 'string' || !addressPattern.test(data.wallet)) return fail('Invalid public wallet address.',400);
        await query('UPDATE workers SET wallet=? WHERE id=? AND wallet IS NULL',data.wallet.toLowerCase(),worker.id).run();
        const current = await query('SELECT wallet FROM workers WHERE id=?',worker.id).first();
        if (current.wallet.toLowerCase() !== data.wallet.toLowerCase()) return fail('A different wallet is already linked.',409);
        return json({wallet:current.wallet});
      }
      if (path === '/api/payout') {
        if (typeof data.id !== 'string' || !Number.isInteger(data.stop)) return fail('Invalid placement.',400);
        const proof = await query(`SELECT p.campaign,p.stop,p.hash,? AS wallet FROM proofs p
          JOIN campaigns c ON c.id=p.campaign WHERE p.campaign=? AND p.stop=? AND c.worker=?`,
          worker.wallet,data.id,data.stop,worker.id).first();
        if (!proof) return fail('Placement not found.',404);
        return json(await settlePayout(query,env,proof,data.retry === true));
      }
      if (path === '/api/pickup-reply') {
        const reply = typeof data.reply === 'string' ? data.reply.trim() : '';
        if (!reply || reply.length > 300) return fail('Enter a proposed time in up to 300 characters.',400);
        const result = await query(`UPDATE campaigns SET pickup_reply=?
          WHERE id=? AND worker=? AND picked_up=0 AND pickup_hash IS NOT NULL AND pickup_note IS NOT NULL`,
          reply,data.id,worker.id).run();
        return result.meta.changes === 1 ? json({saved:true}) : fail('No pending pickup instructions for this job.',409);
      }
      if (path === '/api/claim') {
        const campaign = typeof data.id === 'string' && await query('SELECT area,test_lat,test_lng FROM campaigns WHERE id=?',data.id).first();
        if (!campaign) return fail('Campaign not found.',404);
        if (!withinJobRadius(data.point,campaign)) return fail('Share a location within 50 km of the placement area.',400);
        const result = await query('UPDATE campaigns SET worker=? WHERE id=? AND worker IS NULL',worker.id,data.id).run();
        if (result.meta.changes !== 1) return fail('This job is already claimed.',409);
        return json({claimed:true});
      }
      if (path === '/api/pickup') {
        if (typeof data.pin !== 'string' || !/^\d{6}$/.test(data.pin)) return fail('Enter the six-digit pickup PIN.',400);
        const now = Date.now();
        const digest = await pinDigest(data.id,data.pin);
        const result = await query(`UPDATE campaigns SET picked_up=1,released_pin=NULL
          WHERE id=? AND worker=? AND pickup_hash=? AND pin_retry_at<=?`,data.id,worker.id,digest,now).run();
        if (result.meta.changes === 1) return json({pickedUp:true});
        const attempted = await query(`UPDATE campaigns SET
          pin_retry_at=CASE WHEN pin_attempts >= 4 THEN ? ELSE 0 END,
          pin_attempts=CASE WHEN pin_attempts >= 4 THEN 0 ELSE pin_attempts+1 END
          WHERE id=? AND worker=? AND picked_up=0 AND pin_retry_at<=?`,now+300000,data.id,worker.id,now).run();
        if (attempted.meta.changes === 0) return fail('Pickup unavailable. If you retried the PIN, wait five minutes.',429);
        return fail('Incorrect pickup PIN.',403);
      }
      if (path === '/api/photo') {
        if (typeof data.id !== 'string' || !Number.isInteger(data.stop) || data.stop < 0 || data.stop >= stops.length ||
            typeof data.photo !== 'string' || !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+={0,2}$/.test(data.photo)) {
          return fail('Capture a placement photo.',400);
        }
        if (data.placed !== true) return fail('Confirm the sticker is on the wall.',400);
        const accuracy = data.point?.accuracy;
        if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > locationTolerance) {
          return fail('Location is too imprecise. Move into the open and retry.',422);
        }
        const campaign = await query('SELECT area,test_lat,test_lng FROM campaigns WHERE id=? AND worker=?',data.id,worker.id).first();
        if (!campaign) return fail('Placement not available for this worker.',409);
        const stop = campaignRoute(campaign)[data.stop];
        if (!stop) return fail('Sticker stop not found.',400);
        if (placementDistance(data.point,stop) > locationTolerance) {
          return fail('You are outside the 50 m placement area. Move closer and retry.',422);
        }
        const digest = await hash(encode(data.photo));
        const result = await query(`INSERT INTO proofs (campaign,stop,photo,hash,created)
          SELECT id,next_stop,?,?,? FROM campaigns WHERE id=? AND worker=? AND next_stop=?
            AND (pickup_hash IS NULL OR picked_up=1)
          ON CONFLICT DO NOTHING`,data.photo,digest,Date.now(),data.id,worker.id,data.stop).run();
        if (result.meta.changes !== 1) {
          const previous = await query(`SELECT 1 FROM proofs JOIN campaigns ON campaigns.id=proofs.campaign
            WHERE campaign=? AND stop=? AND hash=? AND worker=?`,data.id,data.stop,digest,worker.id).first();
          if (!previous) return fail('Confirm pickup first, or check that this stop and photo are new.',409);
        }
        const payout = await settlePayout(query,env,{campaign:data.id,stop:data.stop,hash:digest,wallet:worker.wallet},true);
        return json({saved:true,payment:payout.status,payout});
      }
      return fail('Page not found.',404);
    } catch (error) {
      console.error(error);
      return fail('Campaign service unavailable. Try again.',503);
    }
  }
};
