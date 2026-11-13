import {mkdir, readFile, writeFile} from 'node:fs/promises';
const files = {
  '/':['index.html','text/html'], '/style.css':['style.css','text/css'],
  '/app.js':['app.js','text/javascript'], '/route.js':['route.js','text/javascript'],
  '/sw.js':['sw.js','text/javascript'], '/manifest.webmanifest':['manifest.webmanifest','application/manifest+json'],
  '/wall.jpg':['wall.jpg','image/jpeg'], '/icon-192.png':['icon-192.png','image/png'], '/icon-512.png':['icon-512.png','image/png'],
  '/vendor/qr.js':['vendor/qr.js','text/javascript'], '/vendor/pdf.js':['vendor/pdf.js','text/javascript'],
  '/vendor/map.js':['vendor/map.js','text/javascript'], '/vendor/map.css':['vendor/map.css','text/css']
};
const assets = {};
for (const [path, [file,type]] of Object.entries(files)) {
  assets[path] = [type, await readFile('public/' + file,type.startsWith('image/') ? 'base64' : 'utf8')];
}
const ethers = await readFile('worker/ethers.min.js','utf8');
assets['/vendor/ethers.js'] = ['text/javascript',ethers];
const exportOffset = ethers.lastIndexOf('export{');
if (exportOffset === -1) throw Error('Missing Ethers export statement');
const verifier = 'const chain = (() => {' + ethers.slice(0,exportOffset) + '\nreturn {verifyMessage,JsonRpcProvider,Wallet,Contract,id};})();\n';
await mkdir('dist/server', {recursive:true});
await writeFile('dist/server/index.js', 'const assets = ' + JSON.stringify(assets) + ';\n' + verifier
  + await readFile('public/route.js','utf8') + '\n' + await readFile('worker/payouts.mjs','utf8') + '\n' + await readFile('worker/index.mjs','utf8'));
