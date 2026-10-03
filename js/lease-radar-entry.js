import { createLeaseRadarClient } from './lease-radar-client.js';
import { leaseRadarFixture } from './lease-radar-fixture.js';
import { resolveDealroomBoot } from './boot-mode.js';
import { mountLeaseRadar } from './lease-radar.js';
const boot=resolveDealroomBoot(location);
const client=boot.mode==='live' ? createLeaseRadarClient() : {readLeaseRadar:async()=>leaseRadarFixture()};
const radar=mountLeaseRadar({document,window,client});
window.addEventListener('pagehide',event=>{if(!event.persisted)radar.dispose();});
