// Synthetic partner questions with explicit record answers, never live data.
const deal = { id: 'demo-deal-a', name: 'Demo Practice A', owner: 'demo-partner', phase: 'Research', next_step: 'Compare sample options', next_date: '2026-10-07', version: 4 };
const loop = { loop_id: 'demo-loop-a', number: '201', title: 'Demo Review', owner: 'demo-partner', status: 'open', due_on: '2026-10-07', version: 4 };
const work = { human_ref: 'WR-DEMO-A', title: 'Demo Request', state: 'ready', owner: 'demo-partner', next_human_action: 'Review sample plan', version: 4 };
const incident = { ref: 'INC-DEMO-A', title: 'Demo Incident', state: 'open', severity: 'high', owner_actor: 'demo-partner', version: 4 };
const party = { id: 'demo-party-a', name: 'Demo Practice A', owner_label:'Demo partner', recorded_status:'active', recorded_status_label:'Active', recorded_stage:'active', recorded_stage_label:'Active', city:'Demo City', record_version:4 };
const event = { id: 'demo-event-a', name: 'Demo Event', starts_at: '2026-10-07T12:00:00Z', location: 'Demo City', version: 4 };
const conversation = { id: 'demo-chat-a', title: 'Demo Discussion', visibility: 'private', version: 4 };
const rows = [
  ['home', 'getBoard', { deals: [deal] }, [], 'deal', deal.id, 'Next step', 'Compare sample options', 'What is the next step for Demo Practice A?'],
  ['deals', 'getDeal', { deal, activities: [{ summary: 'Sample options compared', occurred_at: '2026-10-01T12:00:00Z' }] }, [deal.id], 'deal', deal.id, 'Owner', 'demo-partner', 'Who owns Demo Practice A?'],
  ['leads', 'getLeadBoard', { leads: [{ ...deal, stage: 'new', score: 72 }] }, [], 'lead', deal.id, 'Score', 72, 'What is the score of Demo Practice A?'],
  ['tours', 'tourDetail', { id: 'demo-tour-a', name: 'Demo Tour', status: 'draft', scheduled_at: '2026-10-07T12:00:00Z', version: 4, stops: [] }, ['demo-tour-a'], 'tour', 'demo-tour-a', 'Date', '2026-10-07T12:00:00Z', 'When is Demo Tour scheduled?'],
  ['clients', 'businessRecord', { record: party }, [{ dataset: 'clients', id: party.id }], 'clients', party.id, 'Market', 'Demo City', 'Where is Demo Practice A?'],
  ['vendors', 'businessRecord', { record: { ...party, name: 'Demo Vendor A' } }, [{ dataset: 'vendors', id: party.id }], 'vendors', party.id, 'Status', 'Active', 'What is the status of Demo Vendor A?'],
  ['calendar', 'getDeal', { deal, activities: [] }, [deal.id], 'deal', deal.id, 'Due', '2026-10-07', 'When is Demo Practice A next due?'],
  ['ideas', 'loopBoard', { loops:[{number:'201',label:loop.title,owner:loop.owner,version:4}] }, [{summary:true}], 'loop', '201', 'Owner', 'demo-partner', 'Who owns Demo Review?'],
  ['events', 'listIndustryEvents', { events: [event] }, [], 'event', event.id, 'Location', 'Demo City', 'Where is Demo Event?'],
  ['control', 'currentWorkItem', { current: [work] }, [], 'work', work.human_ref, 'Next step', 'Review sample plan', 'What needs attention for Demo Request?'],
  ['progress', 'readProgressBoard', { snapshot: { version: 4, snapshot_json: { tasks: { 'demo-task-a': { title: 'Demo Progress', status: 'ready' } } } } }, [{ board_id: 'demo-board-a' }], 'task', 'demo-task-a', 'Status', 'ready', 'What is the status of Demo Progress?'],
  ['work', 'systemRecord', work, [work.human_ref], 'work', work.human_ref, 'Status', 'ready', 'Is Demo Request ready?'],
  ['inventory', 'workInventory', { items: [{ id: 'demo-item-a', kind: 'loop', title: 'Demo Inventory Item', status: 'open', version: 4 }] }, [], 'loop', 'demo-item-a', 'Status', 'open', 'Is Demo Inventory Item open?'],
  ['incidents', 'getIncident', { incident }, [{ ref: incident.ref }], 'incident', incident.ref, 'Priority', 'high', 'What is the priority of Demo Incident?'],
  ['room', 'roomTurns', { turns: [{ msg_id: 'demo-message-a', seq: '22', body: 'Demo review is ready', at: '2026-10-01T12:00:00Z', origin_actor: 'demo-partner' }] }, [], 'room-turn', 'demo-message-a', 'Owner', 'demo-partner', 'Who posted the Demo review update?'],
  ['queue', 'roomQueue', { events: [{ task_id: 'demo-task-a', card: { title: 'Demo Queue Task', status: 'running', priority: 'normal', updated_at: '2026-10-01T12:00:00Z' }, summary: 'Sample task started', projected_at: '2026-10-01T12:00:00Z' }] }, [], 'room-task', 'demo-task-a', 'Status', 'running', 'Is Demo Queue Task running?'],
  ['updates', 'notificationFeed', { notifications: [{ id: 'demo-notice-a', reason: 'Demo Review requested', severity: 'action_required', read_at: null, version: 4 }] }, [], 'notification', 'demo-notice-a', 'Status', 'Unseen', 'Have I seen the Demo Review notification?'],
  ['chats', 'readDocConversation', { identity:conversation, latest_sequence:2, more:false, turns: [{sequence:1,body:'Older discussion',at:'2026-10-01T11:00:00Z'},{sequence:2,body:'Sample review approved',at:'2026-10-01T12:00:00Z'}] }, [{ conversation_id: conversation.id }], 'conversation', conversation.id, 'Recent activity', 'Sample review approved', 'What was last said in Demo Discussion?'],
  ['tasks', 'readLoop', { loop }, [{ loop_id: loop.loop_id }], 'loop', loop.loop_id, 'Due', '2026-10-07', 'When is Demo Review due?'],
  ['search', 'find', { parties: [{ ref: party.id, name: party.name, city: party.city }] }, [{ query: 'Demo' }], 'party', party.id, 'Market', 'Demo City', 'Where is the matched Demo Practice A?'],
  ['charts', 'getBoard', { deals: [deal] }, [], 'deal', deal.id, 'Stage', 'Research', 'What stage is Demo Practice A in?'],
  ['status', 'readAssuranceHealth', { scope: { workflow_key: 'demo-workflow' }, state: 'healthy', capability_stage: 'ready' }, [], 'workflow', 'demo-workflow', 'Status', 'healthy', 'Is the Demo workflow healthy?'],
];
const names = ['Demo Practice A','Demo Practice A','Demo Practice A','Demo Tour','Demo Practice A','Demo Vendor A','Demo Practice A','Demo Review','Demo Event','Demo Request','Demo Progress','Demo Request','Demo Inventory Item','Demo Incident','Demo review is ready','Demo Queue Task','Demo Review requested','Demo Discussion','Demo Review','Demo Practice A','Demo Practice A','demo-workflow'];
export const docEvaluationSet = rows.map(([page, method, payload, args, kind, recordId, question, answer, prompt], index) => ({ recordName:names[index], page, method, payload, args, kind, recordId, question, answer, prompt }));
export const unsupportedDocPages = ['design', 'share'];

// Additional producer states that previously escaped the page-family gate.
docEvaluationSet.push(
 {page:'chats',method:'readDocConversation',payload:{identity:conversation,latest_sequence:6,more:true,turns:[{sequence:1,body:'Earlier discussion',at:'2026-10-01T10:00:00Z'},{sequence:2,body:'Later first-page discussion',at:'2026-10-01T11:00:00Z'}]},args:[{conversation_id:conversation.id}],kind:'conversation',recordId:conversation.id,recordName:conversation.title,question:'Recent activity',answer:null,prompt:'What is the latest activity when only the first conversation page was read?'},
 {page:'leads',method:'getClaimCard',payload:{candidates:[{pool_id:1,display_name:'Demo candidate',base_version:4,city:'Demo City'}]},args:[],kind:'candidate',recordId:'1',recordName:'Demo candidate',question:'Market',answer:'Demo City',prompt:'Where is the open Demo candidate?'},
 {page:'search',method:'findAndCatchUp',payload:{state:'completed',match:{kind:'client',target:'C-DEMO',name:'Demo Practice A'},catch_up:{timeline:[{summary:'Old review',occurred_at:'2026-10-01T11:00:00Z'},{summary:'Latest review',occurred_at:'2026-10-01T12:00:00Z'}]}},args:[{query:'Demo'}],kind:'catch-up',recordId:'C-DEMO',recordName:'Demo Practice A',question:'Recent activity',answer:'Latest review',prompt:'What is the latest Demo Practice A activity?'},
 {page:'clients',method:'businessRecord',payload:{record:party},args:[{dataset:'clients',id:party.id}],kind:'clients',recordId:party.id,recordName:party.name,question:'Owner',answer:'Demo partner',prompt:'Who owns the recorded client?'}
);
