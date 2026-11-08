import { mountWatchControl } from './ui-watches.js';
import { createLeaseRadarClient } from './lease-radar-client.js';
import { leaseRadarFixture } from './lease-radar-fixture.js';
import { resolveDealroomBoot } from './boot-mode.js';
import { mountLeaseRadar } from './lease-radar.js';
const boot=resolveDealroomBoot(location);
const client=boot.mode==='live' ? createLeaseRadarClient() : {readLeaseRadar:async()=>leaseRadarFixture()};
const radar=mountLeaseRadar({document,window,client});
window.addEventListener('pagehide',event=>{if(!event.persisted)radar.dispose();});

import { mountClientAnniversaries } from './ui-client-anniversaries.js';
import { createClientAnniversariesClient } from './ui-client-anniversaries.js';
const anniversaries = createClientAnniversariesClient();
const anniversaryHost = document.getElementById('clientAnniversaries');
if (anniversaryHost) mountClientAnniversaries(anniversaryHost, {load:signal=>anniversaries.read({signal})});

const leaseDialog = document.getElementById('leaseDetail');
let leaseWatch = null, watchHost = null, watchLease = null;
const syncLeaseWatch = () => {
  const id = leaseDialog?.open ? new URL(location.href).searchParams.get('lease') : null;
  if (id === watchLease && watchHost) {
    if (!watchHost.isConnected && leaseDialog?.open) leaseDialog.append(watchHost);
    return;
  }
  leaseWatch?.dispose(); leaseWatch = null; watchHost = null; watchLease = id;
  if (!id || !leaseDialog?.open) return;
  watchHost = document.createElement('div'); leaseDialog.append(watchHost);
  leaseWatch = mountWatchControl(watchHost, {subject:{subject_type:'lease',subject_id:id}});
};
const leaseWatchObserver = new MutationObserver(syncLeaseWatch);
if (leaseDialog) leaseWatchObserver.observe(leaseDialog,{attributes:true,attributeFilter:['open'],childList:true});
window.addEventListener('pagehide',event=>{if(!event.persisted){leaseWatchObserver.disconnect();leaseWatch?.dispose();}});
