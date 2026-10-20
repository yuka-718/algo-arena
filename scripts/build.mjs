import { build } from 'esbuild';
import { readFile, mkdir, cp, rm } from 'node:fs/promises';

const files = [['/','index.html','text/html; charset=utf-8'],['/index.html','index.html','text/html; charset=utf-8'],['/app.js','app.js','text/javascript; charset=utf-8'],['/styles.css','styles.css','text/css; charset=utf-8']];
const assets = Object.fromEntries(await Promise.all(files.map(async ([url,file,type])=>[url,{body:await readFile(file,'utf8'),type}])));
await rm('dist',{recursive:true,force:true});
await mkdir('dist/server',{recursive:true});
await mkdir('dist/.openai',{recursive:true});
await build({
  entryPoints:['worker/index.js'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',
  plugins:[{name:'arena-assets',setup(build){
    build.onResolve({filter:/^arena:assets$/},()=>({path:'assets',namespace:'arena'}));
    build.onLoad({filter:/.*/,namespace:'arena'},()=>({contents:`export const assets = ${JSON.stringify(assets)};`,loader:'js'}));
  }}],
});
await cp('.openai/hosting.json','dist/.openai/hosting.json');
await cp('drizzle','dist/.openai/drizzle',{recursive:true});
const worker = await import(new URL('../dist/server/index.js',import.meta.url));
if(typeof worker.default?.fetch !== 'function') throw new Error('Worker fetch export missing');
const response=await worker.default.fetch(new Request('https://arena.test/'),{});
if(!response.ok || !(await response.text()).includes('ALGO')) throw new Error('Built homepage invalid');
console.log('Built and validated dist/server/index.js with bundled frontend and D1 migrations.');
