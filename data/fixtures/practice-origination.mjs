export function practiceOriginationFixture({limit = 25, before_id} = {}) {
  const cards = [
    ['6', 'Demo New Practice', 'enumeration', 'research'],
    ['5', 'Demo Client Practice', 'registry_update', 'relationship_follow_up'],
    ['4', 'Demo Similar Practice', 'pecos_correction', 'identity_review'],
    ['3', 'Demo Enrollment Practice', 'pecos_observation', 'research'],
    ['2', 'Demo Registry Practice', 'registry_update', 'research'],
    ['1', 'Demo Group Practice', 'pecos_observation', 'research'],
  ].map(([id,name,kind,route]) => {
    const source = kind.startsWith('pecos') ? 'pecos' : 'nppes';
    const npi = String(1234567890 + Number(id));
    const evidence_date = `2026-10-${20 + Number(id)}`;
    return {id,source,record_key:source === 'pecos' ? `${npi}|DEMO-${id}` : npi,npi,name,
      city:'Demo City',state:'FL',kind,evidence_date,date_basis:source === 'pecos' ? 'publication' : kind,
      source_url:source === 'pecos' ? 'https://data.cms.gov/provider-characteristics/medicare-provider-supplier-enrollment/medicare-fee-for-service-public-provider-enrollment' : `https://npiregistry.cms.hhs.gov/provider-view/${npi}`,
      facts:source === 'pecos' ? {enrollment_id:`DEMO-${id}`,provider_type:'Demo specialty'} : {},
      published_on:'2026-10-26',recorded_at:'2026-10-26T12:00:00Z',route,
      client_ids:route === 'relationship_follow_up' ? ['demo-client'] : [],
      client_refs:route === 'relationship_follow_up' ? ['DEMO-CLIENT'] : [],
      why_now:`${({enumeration:'NPI enumerated',registry_update:'NPPES registry updated',pecos_correction:'Public PECOS evidence corrected',pecos_observation:'Public PECOS enrollment observed'})[kind]} on ${evidence_date}`};
  }).filter(card => !before_id || Number(card.id) < Number(before_id));
  return {ok:true,contract:'practice-origination.v1',cards:cards.slice(0,limit),
    next_cursor:cards.length > limit ? cards[limit-1].id : null, outreach_started:false,
    coverage:[
      {source:'nppes',enabled:true,status:'available',coverage:'AL/FL practices in the NPPES territory filter',checkpoint:'demo-nppes',published_on:'2026-10-26'},
      {source:'pecos',enabled:true,status:'available',coverage:'AL/FL Medicare public provider enrollment observations',checkpoint:'demo-pecos',published_on:'2026-10-26'},
      ...['formation-al','formation-fl','recorder-escambia-fl','recorder-baldwin-al','recorder-other'].map(source => ({source,enabled:false,status:source === 'recorder-other' ? 'uncovered' : 'unavailable',coverage:source === 'recorder-other' ? 'uncovered' : 'unavailable'})),
    ]};
}
