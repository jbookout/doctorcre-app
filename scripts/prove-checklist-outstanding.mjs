import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { prove as runProof } from './prove-activity-attribution-panel.mjs';
const unavailable = message => Object.assign(Error(message), {exitCode:78});

export async function observeNaturalChecklist(page, origin) {
  await page.goto(new URL('/deals', origin).href);
  const card = page.locator('.kanban-card .card-open:visible').first();
  try { await card.waitFor({state:'visible'}); }
  catch { throw unavailable('No signed-in natural deal available'); }
  await card.click();
  await page.locator('#detailUpdateForm').waitFor();
  const snapshot = await page.evaluate(async () => {
    const {state} = await import('/js/pipeline.js');
    const {isDealChecklistSnapshot} = await import('/js/ui-checklist.generated.js');
    if (!state.panelDeal) return null;
    let detail;
    try { detail = await state.client.getDeal(state.panelDeal); }
    catch { return null; }
    return isDealChecklistSnapshot(detail?.checklist) ? detail.checklist : null;
  });
  if (!snapshot || snapshot.schema_version !== 'deal-checklist.v1' || !['current','deal_type_unknown'].includes(snapshot.template_state) || !snapshot.phases?.some(p=>p.items?.length)) throw unavailable('No natural recorded checklist available');
  const root = page.locator('.deal-checklist');
  const summary = root.locator(':scope > summary');
  await summary.waitFor();
  if (!await root.evaluate(n=>n.open)) await summary.click();
  const filter = root.getByLabel('Requirements view', {exact:true});
  await filter.selectOption('all');
  const items = snapshot.phases.flatMap(p=>p.items);
  const rows = () => root.locator('[data-checklist-item]').evaluateAll(nodes=>nodes.map(n=>({id:n.dataset.checklistItem,status:n.dataset.state,label:n.querySelector(':scope > span').textContent})));
  const expectedRows = items.map(i=>({id:i.id,status:i.status,label:i.label}));
  assert.deepEqual(await rows(), expectedRows);
  const due = await summary.textContent();
  const next = snapshot.due_items[0];
  const caption = value => new Date(`${value}T12:00:00`).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  const labels = {complete:'Recorded complete',received:'Received',not_recorded:'Not recorded',due:'Due today',overdue:'Overdue',upcoming:'Upcoming'};
  assert.equal(due, `Deal checklist${snapshot.due_items.length ? ` · ${snapshot.due_items.length} due` : ''}${next ? `${next.label}${labels[next.status]} · ${caption(next.due_on)}` : ''}`);
  await filter.selectOption('outstanding');
  const matching = expectedRows.filter(i=>['not_recorded','due','overdue','upcoming'].includes(i.status));
  assert.deepEqual(await rows(),matching);
  assert.equal(await root.locator('[data-checklist-count]').textContent(),`${matching.length} matching of ${items.length} recorded requirements.`);
  assert.equal(await summary.textContent(),due);
  await filter.selectOption('all');
  assert.deepEqual(await rows(),expectedRows);
  assert.equal(await root.locator('[data-checklist-count]').textContent(),`${items.length} matching of ${items.length} recorded requirements.`);
  const evidence = await root.locator('[data-checklist-item] details').evaluateAll(nodes=>nodes.map(n=>Array.from(n.querySelectorAll('p'),p=>p.textContent)));
  assert.deepEqual(evidence,items.map(i=>{const {document,request,record_verb,version}=i.source;return [i.evidence_ref || 'No completion evidence recorded.',[document,request,record_verb].find(v=>typeof v==='string' && v.trim())+(version ? ` · version ${version}` : '')];}));
  await root.locator('[data-checklist-item] details > summary').first().click();
  assert.equal(await root.locator('[data-checklist-item] details').first().evaluate(n=>n.open),true);
  return {recorded:items.length,outstanding:matching.length,due:snapshot.due_items.length};
}
export function prove(options) { return runProof({...options,observe:options.observe || observeNaturalChecklist}); }
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const {values}=parseArgs({options:{origin:{type:'string'},'expected-commit':{type:'string'},'cdp-url':{type:'string'},'timeout-ms':{type:'string',default:'30000'}}});
    const timeoutMs=Number(values['timeout-ms']);
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw unavailable('Deadline must be 1 to 30000 milliseconds');
    const result=await prove({origin:values.origin,expectedCommit:values['expected-commit'],cdpUrl:values['cdp-url'],timeoutMs});
    console.log(JSON.stringify(result));process.exitCode=result.exitCode;
  } catch(error) {console.log(JSON.stringify({status:'insufficient_evidence',error:error.message}));process.exitCode=78;}
}
