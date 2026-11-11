import { mountWatchControl } from './ui-watches.generated.js';
import { createLeaseRadarClient } from './lease-radar-client.js';
import { leaseRadarFixture } from './lease-radar-fixture.js';
import { resolveDealroomBoot } from './boot-mode.js';
import { mountLeaseRadar } from './lease-radar.js';
const boot=resolveDealroomBoot(location);
const client=boot.mode==='live' ? createLeaseRadarClient() : {readLeaseRadar:async()=>leaseRadarFixture()};
const radar=mountLeaseRadar({document,window,client});
window.addEventListener('pagehide',event=>{if(!event.persisted)radar.dispose();});

import { mountClientAnniversaries } from './ui-client-anniversaries.generated.js';
import { createClientAnniversariesClient } from './ui-client-anniversaries.generated.js';
const anniversaries = createClientAnniversariesClient();
const anniversaryHost = document.getElementById('clientAnniversaries');
if (anniversaryHost) mountClientAnniversaries(anniversaryHost, {load:signal=>anniversaries.read({signal})});

const leaseDialog = document.getElementById('leaseDetail');
let leaseWatch = null, dealWatch = null, watchHost = null, watchLease = null, watchDeal = null;
const syncDealWatch = deal => {
  if (deal === watchDeal) return;
  dealWatch?.dispose(); dealWatch = null;
  watchHost?.querySelector('[data-deal-watch-host]')?.remove();
  watchDeal = deal;
  if (deal && watchHost) {
    const host = document.createElement('div'); host.dataset.dealWatchHost = ''; watchHost.append(host);
    dealWatch = mountWatchControl(host, {subject:{subject_type:'deal',subject_id:deal}});
  }
};
const syncLeaseWatch = () => {
  const id = leaseDialog?.open ? new URL(location.href).searchParams.get('lease') : null;
  const dealLink = leaseDialog?.querySelector('.lease-detail-links a[data-radar-key="deal"]');
  const deal = dealLink && new URL(dealLink.href).searchParams.get('deal');
  if (id === watchLease && watchHost) {
    if (!watchHost.isConnected && leaseDialog?.open) leaseDialog.append(watchHost);
    syncDealWatch(deal);
    return;
  }
  leaseWatch?.dispose(); dealWatch?.dispose(); watchHost?.remove(); dealWatch = null; leaseWatch = null; watchHost = null; watchLease = id;
  watchDeal = null;
  if (!id || !leaseDialog?.open) return;
  watchHost = document.createElement('div'); watchHost.dataset.leaseWatchHost = id; leaseDialog.append(watchHost);
  const leaseHost = document.createElement('div'); watchHost.append(leaseHost);
  leaseWatch = mountWatchControl(leaseHost, {subject:{subject_type:'lease',subject_id:id}});
  syncDealWatch(deal);
};
const leaseWatchObserver = new MutationObserver(syncLeaseWatch);
if (leaseDialog) leaseWatchObserver.observe(leaseDialog,{attributes:true,attributeFilter:['open'],childList:true});
window.addEventListener('pagehide',event=>{if(!event.persisted){leaseWatchObserver.disconnect();leaseWatch?.dispose();dealWatch?.dispose();}});
