import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createLiveClient } from '../js/live-client.js';
import { createFixtureClient } from '../js/fixture-client.js';
import { beginCommand, settleCommand, classifyCommandOutcome, commandMessage } from '../js/command-feedback.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/national-account-schemas.json', import.meta.url)));
const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const forms = app.slice(app.indexOf('function nationalResearchFields('), app.indexOf('function accountOwnerForm('));
const open = app.slice(app.indexOf('function openForm('), app.indexOf('function nextStepForm('));

// Validate the published schema, including extra top-level arguments rejected
// by CARR's mutation dispatcher even where inputSchema omits that constraint.
function validate(schema, value, path = 'arguments') {
  assert.equal(Array.isArray(value) ? 'array' : typeof value, schema.type, path);
  if (schema.enum) assert.ok(schema.enum.includes(value), path);
  if (schema.type === 'object') {
    assert.notEqual(value, null, path);
    for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), `${path}.${key} required`);
    if (path === 'arguments') for (const key of Object.keys(value)) assert.ok(schema.properties[key], `${key} not accepted`);
    for (const [key, child] of Object.entries(schema.properties || {})) if (Object.hasOwn(value, key)) validate(child, value[key], `${path}.${key}`);
  }
  if (schema.items) value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`));
}

function evidenceGate(evidence) {
  assert.ok(evidence?.sources.length, 'Research evidence is required for a new sub-client');
  for (const source of evidence.sources) {
    assert.equal(new URL(source.url).protocol, 'https:');
    assert.ok(Number.isFinite(Date.parse(source.observed_at)) && Date.parse(source.observed_at) <= Date.now() + 300000);
  }
  for (const field of ['name', 'company', 'phone', 'specialty', 'market']) {
    assert.ok(evidence.field_evidence[field]?.length, `evidence for ${field}`);
    assert.ok(evidence.field_evidence[field].every(index => Number.isInteger(index) && index >= 0 && index < evidence.sources.length));
  }
  assert.ok(Array.isArray(evidence.discrepancies));
}

function harness(reply = () => ({ ok: true, account_client_id: 'demo-account', deal_id: 'demo-deal' }), {online = () => true} = {}) {
  const dom = new JSDOM('<dialog id="formDialog"><form id="dialogForm"><span id="dialogContext"></span><h2 id="dialogTitle"></h2><div id="dialogBody"></div><p id="formError" hidden></p><button id="dialogSubmit"></button></form></dialog>');
  const document = dom.window.document;
  const $ = selector => document.querySelector(selector);
  const dialog = $('#formDialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  const sent = [], toasts = [];
  const state = { selfActor: 'joe', nationalCreations: {}, nationalConfirmations: {}, deals: new Map([['demo-deal', {name:'Demo deal'}]]) };
  state.client = createLiveClient({docContext:false, online, fetchImpl:async (_, init) => {
    const {name, arguments:args} = JSON.parse(init.body).params;
    sent.push({name, args});
    try {
      validate(fixture.schemas[name], args);
      if (name === 'create-national-account' || name === 'create-national-market-deal' && args.client_name !== 'Demo Existing') evidenceGate(args.research_evidence);
      const payload = await reply(name, args, sent.length);
      return {ok:true, json:async () => ({result:{content:[{type:'text',text:JSON.stringify(payload)}]}})};
    } catch (error) {
      if (error.message === 'lost reply') throw error;
      return {ok:true, json:async () => ({result:{isError:true,content:[{type:'text',text:JSON.stringify({error:'missing_required',hint:error.message})}]}})};
    }
  }});
  let keys = 0;
  const bindings = {state, document, FormData:dom.window.FormData, $, $$:selector => [...document.querySelectorAll(selector)],
    esc:value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    actorName:String, uuidv4:() => `demo-key-${++keys}`, account:() => ({account_name:'Demo Account',account_client_id:'demo-account'}),
    loadHome:async () => {}, showToast:text => toasts.push(text), setTimeout:() => {},
    confirmLocalWrite:() => ({}), renderBoardOnly:() => {}, beginCommand, settleCommand, classifyCommandOutcome, commandMessage};
  const actions = new Function(...Object.keys(bindings), `${open}\n${forms}\nreturn {addAccountForm,addMarketDealForm,marketAgentForm};`)(...Object.values(bindings));
  const fill = values => { for (const [name,value] of Object.entries(values)) {
    const field = document.querySelector(`[name="${name}"]`);
    if (field) { field.value = value; field.dispatchEvent(new dom.window.Event('change',{bubbles:true})); }
  }};
  return {actions, fill, sent, toasts, document, state, dialog,
    error:() => $('#formError').hidden ? '' : $('#formError').textContent,
    submit:() => $('#dialogForm').onsubmit({preventDefault(){},currentTarget:$('#dialogForm')})};
}

const research = {research_name:'https://example.com/demo/name',research_company:'https://example.com/demo/company',
  research_phone:'https://example.com/demo/phone',research_specialty:'https://example.com/demo/specialty',
  research_market:'https://example.com/demo/market',research_observed_at:'2026-10-22T10:00',research_discrepancies:'Phone not published'};
const accountFields = {name:'Demo New Account',owner:'joe',vertical:'Dental',...research};
const marketFields = {client_name:'Demo New',deal_name:'Demo market deal',market:'Demo City',client_mode:'new',...research};

test('new account sends source-backed evidence in the exact producer schema', async () => {
  const view = harness(); view.actions.addAccountForm(); view.fill(accountFields); await view.submit();
  assert.equal(view.error(), ''); assert.equal(view.dialog.open,false);
  assert.equal(view.sent.length,1); evidenceGate(view.sent[0].args.research_evidence);
  assert.deepEqual(view.sent[0].args.research_evidence.discrepancies,['Phone not published']);
  assert.deepEqual(view.toasts,['National account created']);
});

test('missing or invalid research stays actionable without sending or claiming success', async () => {
  for (const change of [{research_phone:''},{research_market:'http://example.com/demo'},{research_observed_at:'2999-01-01T10:00'}]) {
    const view = harness(); view.actions.addAccountForm(); view.fill({...accountFields,...change}); await view.submit();
    assert.ok(view.error()); assert.equal(view.dialog.open,true); assert.equal(view.sent.length,0); assert.deepEqual(view.toasts,[]);
  }
});

test('duplicate candidates require a deliberate separate-brand confirmation and a new key', async () => {
  const view = harness((_,args) => args.force_new ? {ok:true,account_client_id:'demo-created'}
    : {needs_confirm:true,candidates:[{id:'demo-existing',name:'Demo Existing <brand>'}],hint:'Review the existing organization.'});
  view.actions.addAccountForm(); view.fill(accountFields); await view.submit();
  assert.equal(view.dialog.open,true); assert.deepEqual(view.toasts,[]);
  assert.match(view.document.querySelector('#dialogBody').textContent,/Demo Existing <brand>/);
  await view.submit(); assert.equal(view.sent.length,1);
  view.document.querySelector('[name="confirm_separate"]').checked = true;
  await view.submit();
  assert.equal(view.sent[1].args.force_new,true);
  assert.notEqual(view.sent[1].args.idempotency_key,view.sent[0].args.idempotency_key);
  assert.deepEqual(view.sent[1].args.research_evidence,view.sent[0].args.research_evidence);
  assert.equal(view.toasts.length,1);
});

test('a lost separate-brand reply can be checked after reopening without another confirmation', async () => {
  const view = harness((_,args,count) => {
    if (!args.force_new) return {needs_confirm:true,candidates:[{id:'demo-existing',name:'Demo Existing'}]};
    if (count === 2) throw Error('lost reply');
    return {ok:true,account_client_id:'demo-created'};
  });
  view.actions.addAccountForm(); view.fill(accountFields); await view.submit();
  view.document.querySelector('[name="confirm_separate"]').checked = true;
  await view.submit(); view.actions.addAccountForm();
  assert.equal(view.document.querySelector('#dialogForm').checkValidity(),true);
  await view.submit(); assert.deepEqual(view.sent[2],view.sent[1]); assert.equal(view.toasts.length,1);
});

test('duplicate review can return to editable details before a separate-brand send', async () => {
  const view = harness((_,args) => args.name === 'Demo Corrected Brand'
    ? {ok:true,account_client_id:'demo-corrected'} : {needs_confirm:true,candidates:[{id:'demo-existing',name:'Demo Existing'}]});
  view.actions.addAccountForm(); view.fill(accountFields); await view.submit();
  view.document.querySelector('#nationalEditDetails').click();
  view.fill({name:'Demo Corrected Brand'}); await view.submit();
  assert.equal(view.error(),''); assert.equal(view.sent[1].args.name,'Demo Corrected Brand');
  assert.equal(Object.hasOwn(view.sent[1].args,'force_new'),false); assert.equal(view.toasts.length,1);
});

test('new and reused sub-clients send distinct valid market requests', async () => {
  for (const mode of ['new','existing']) {
    const view = harness(); view.actions.addMarketDealForm();
    view.fill({...marketFields,client_mode:mode,client_name:mode === 'existing' ? 'Demo Existing' : 'Demo New'}); await view.submit();
    assert.equal(view.error(),''); assert.equal(view.toasts.length,1);
    if (mode === 'new') evidenceGate(view.sent[0].args.research_evidence);
    else assert.equal(Object.hasOwn(view.sent[0].args,'research_evidence'),false);
  }
});

test('an existing sub-client name that does not match stays open with evidence guidance', async () => {
  const view = harness(); view.actions.addMarketDealForm(); view.fill({...marketFields,client_mode:'existing'}); await view.submit();
  assert.match(view.error(),/Research evidence/); assert.equal(view.dialog.open,true); assert.deepEqual(view.toasts,[]);
});

test('unconfirmed, refused and incomplete replies never close creation or announce success', async () => {
  for (const payload of [{ok:false,error:'refused'}, {}, {ok:true}, {ok:true,needs_confirm:true,candidates:[]}]) {
    for (const kind of ['account','market']) {
      const view = harness(() => payload);
      view.actions[kind === 'account' ? 'addAccountForm' : 'addMarketDealForm']();
      view.fill(kind === 'account' ? accountFields : marketFields); await view.submit();
      assert.equal(view.dialog.open,true); assert.ok(view.error()); assert.deepEqual(view.toasts,[]);
    }
  }
});

test('lost creation replies retain exact request and key across reopen', async () => {
  for (const kind of ['account','market']) {
    const view = harness((_,args,count) => { if (count === 1) throw Error('lost reply'); return {ok:true,account_client_id:args.account_client_id || 'demo-created',deal_id:'demo-deal'}; });
    const action = kind === 'account' ? 'addAccountForm' : 'addMarketDealForm';
    view.actions[action](); view.fill(kind === 'account' ? accountFields : marketFields); await view.submit();
    assert.equal(view.dialog.open,true); assert.deepEqual(view.toasts,[]);
    view.actions[action]();
    assert.equal(view.document.querySelector(`[name="${kind === 'account' ? 'name' : 'deal_name'}"]`).value, kind === 'account' ? accountFields.name : marketFields.deal_name);
    await view.submit();
    assert.equal(view.error(),''); assert.deepEqual(view.sent[1],view.sent[0]); assert.equal(view.toasts.length,1);
  }
});

test('blank optional market assignment is omitted rather than sent as null', async () => {
  const view = harness(); view.actions.marketAgentForm('demo-deal'); view.fill({agent_name:'Demo Agent',market:'  '}); await view.submit();
  assert.equal(view.error(),''); assert.equal(Object.hasOwn(view.sent[0].args,'market'),false);
});

test('fixture market creation supplies the producer receipt and replays the same deal', async () => {
  const seed = await readFile(new URL('../data/board-seed.json',import.meta.url),'utf8');
  const client = await createFixtureClient({seedUrl:`data:application/json;base64,${Buffer.from(seed).toString('base64')}`});
  const args = {account_client_id:'demo-account-001',client_name:'Demo Existing',deal_name:'Demo New Market',market:'Demo City',idempotency_key:'demo-market-key'};
  const result = await client.createNationalMarketDeal(args);
  assert.equal(result.ok,true); assert.equal(typeof result.deal_id,'string');
  assert.equal(result.account_client_id,args.account_client_id);
  assert.deepEqual(await client.createNationalMarketDeal(args),result);
});

for (const kind of ['account', 'market', 'separate brand']) {
  test(`${kind} retains an unresolved creation through offline checks and reconnect`, async () => {
    let online = true;
    let lost = false;
    const view = harness((_, args) => {
      if (kind === 'separate brand' && !args.force_new)
        return {needs_confirm:true,candidates:[{id:'demo-existing',name:'Demo Existing'}]};
      if (!lost) { lost = true; throw Error('lost reply'); }
      return {ok:true,account_client_id:args.account_client_id || 'demo-created',deal_id:'demo-deal'};
    }, {online:() => online});
    const action = kind === 'market' ? 'addMarketDealForm' : 'addAccountForm';
    view.actions[action](); view.fill(kind === 'market' ? marketFields : accountFields);
    await view.submit();
    if (kind === 'separate brand') {
      view.document.querySelector('[name="confirm_separate"]').checked = true;
      await view.submit();
    }
    const original = view.sent.at(-1);
    online = false;
    view.actions[action](); await view.submit();
    assert.equal(Object.keys(view.state.nationalCreations).length,1);
    assert.equal(view.document.querySelector('#dialogSubmit').textContent,'Check creation outcome');
    assert.equal(view.document.querySelector('#nationalCreationFields').disabled,true);
    assert.deepEqual(view.toasts,[]);
    online = true;
    view.actions[action](); await view.submit();
    assert.deepEqual(view.sent.at(-1),original);
    assert.equal(view.toasts.length,1);
  });
}

test('an initial offline creation releases unsent fields for correction', async () => {
  const view = harness(undefined, {online:() => false});
  view.actions.addAccountForm(); view.fill(accountFields); await view.submit();
  assert.equal(view.sent.length,0);
  assert.deepEqual(view.state.nationalCreations,{});
  assert.equal(view.document.querySelector('#nationalCreationFields').disabled,false);
});

test('a refused reopened separate-brand replay allows deliberate reconfirmation', async () => {
  const view = harness((_, args, count) => {
    if (!args.force_new) return {needs_confirm:true,candidates:[{id:'demo-existing',name:'Demo Existing'}]};
    if (count === 2) throw Error('lost reply');
    if (count === 3) return {ok:false,error:'invalid_request'};
    return {ok:true,account_client_id:'demo-created'};
  });
  view.actions.addAccountForm(); view.fill(accountFields); await view.submit();
  view.document.querySelector('[name="confirm_separate"]').checked = true;
  await view.submit(); view.actions.addAccountForm(); await view.submit();
  const confirm = view.document.querySelector('[name="confirm_separate"]');
  assert.equal(confirm.disabled,false);
  assert.equal(confirm.checked,false);
  await view.submit(); assert.equal(view.sent.length,3);
  confirm.checked = true; await view.submit();
  assert.equal(view.error(),''); assert.equal(view.sent.length,4);
  assert.notEqual(view.sent[3].args.idempotency_key,view.sent[2].args.idempotency_key);
  assert.equal(view.toasts.length,1);
});
