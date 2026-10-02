import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const root=new URL('../',import.meta.url);
const internal=/record layer|read from|read again|retry read|reads that answered|no source has answered|live record/i;
test('shared UI copy never prompts manual reads or explains the record layer',async()=>{
 for(const name of await readdir(root)){
  if(!name.endsWith('.html'))continue;
  const dom=new JSDOM(await readFile(new URL(name,root),'utf8'));
  for(const node of dom.window.document.querySelectorAll('script,style'))node.remove();
  assert.doesNotMatch(dom.window.document.body.textContent,internal,name);dom.window.close();
 }
 async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
  const path=new URL(entry.name+(entry.isDirectory()?'/':''),dir);
  if(entry.isDirectory()){await walk(path);continue;}
  if(!/\.m?js$/.test(entry.name))continue;
  const code=(await readFile(path,'utf8')).replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
  const match=code.match(internal);assert.equal(match?.[0],undefined,`${path.pathname}: ${match?.[0]}`);
 }}
 await walk(new URL('js/',root));
});
