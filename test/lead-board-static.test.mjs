import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");

test("Leads shell exposes named filters, accessible dialogs and discreet freshness", async () => {
 const html=await read("leads.html");
 for(const id of ["leadSearch","ownerFilter","stageFilter","marketFilter","leadDetail","stageDialog","boardUpdated","refreshBoard","searchUpdated","territoryMap","hotLeads"]) assert.match(html,new RegExp(`id="${id}"`));
 assert.match(html,/aria-live="polite"/);assert.match(html,/aria-busy="true"/);assert.match(html,/5 hottest leads to claim/);
 assert.doesNotMatch(html,/Compact|Comfortable|claimCards|pipelineArrow|Read again|retry read/);
 assert.match(html,/js\/leads-workspace-app.js/);
});
test("Leads motion and responsive grid honor reduced motion and never require a wide canvas", async () => {
 const css=await read("css/leads.css");assert.match(css,/repeat\(6,minmax\(0,1fr\)\)/);assert.match(css,/translateY\(-2px\)/);
 assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);assert.match(css,/animation:none!important/);assert.match(css,/transition:none!important/);
 assert.match(css,/width:min\(1120px/);assert.doesNotMatch(css,/min-width:760px/);
});
test('blocking 14: only the active Leads workspace and its command interface ship',async()=>{
 const {access}=await import('node:fs/promises');const {createLeadBoardClient}=await import('../js/leads-client.js');
 await assert.rejects(access(new URL('../js/leads-app.js',import.meta.url)),{code:'ENOENT'});
 const contract=JSON.parse(await read('contracts/carr-interface.v1.json'));
 for(const verb of ['claim-card','promote-pool','decline-candidate'])assert.equal(contract.mcp_operations.includes(verb),false,verb);
 const client=createLeadBoardClient();for(const method of ['getClaimCard','promoteCandidate','declineCandidate','moveLeadStage'])assert.equal(method in client,false,method);
 for(const method of ['getLeadBoard','getWorkspace','getLeadDetail','claimLead','recordStage','linkClient'])assert.equal(typeof client[method],'function',method);
});
