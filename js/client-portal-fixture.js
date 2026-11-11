export function createFixtureClientPortalClient() {
  return {
    async read({ slug, password }) {
      if (slug !== 'demo-practice' || password !== 'demo-portal')
        throw new Error('Portal unavailable. Check the portal name and password, then try again.');
      return {
        slug: 'demo-practice',
        roadmap: {current_phase:null,phases:[]},
        publications: [{kind:'milestone',title:'Demo published milestone',content:'A synthetic update chosen for client sharing.'}],
        materials: [
          { kind: 'document', title: 'Demo terms overview', content: 'Synthetic shared material. Review the proposed terms with your CARR advisor.' },
          { kind: 'tour', title: 'Demo tour summary', content: 'Synthetic tour. Two example locations are ready for discussion.' },
          { kind: 'report', title: 'Demo market report', content: 'Synthetic report. This preview contains no client records.' },
        ],
      };
    },
  };
}
