export const title='Share into a selected deal';
export const state=v=>v.phase;
export const step=(action)=>({Stage:'share received',Authenticate:'sign in',Bind:'account verified',Choose:'choose deal',Reserve:'file documents',Upload:'reservation confirmed',Commit:'bytes uploaded',Unknown:'response unavailable',Reconcile:'check same receipt',Readback:'attachment hash and deal confirmed',Quota:'local quota denied',Cancel:'cancel or logout',Expire:'one day elapsed'}[action] || null);
