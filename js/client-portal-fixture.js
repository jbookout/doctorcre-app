export function createFixtureClientPortalClient() {
  return {
    async read({ slug, password }) {
      if (slug !== 'demo-practice' || password !== 'demo-portal')
        throw new Error('Portal unavailable. Check the portal name and password, then try again.');
      return {
        slug: 'demo-practice',
        roadmap: { current_phase: 'negotiation', phases: [
          { slug: 'on_deck', label: 'Prospective Client' }, { slug: 'research', label: 'Research' },
          { slug: 'site_selection', label: 'Site selection' }, { slug: 'negotiation', label: 'Negotiation' },
          { slug: 'legal', label: 'Legal' }, { slug: 'diligence', label: 'Diligence' },
          { slug: 'closing', label: 'Closing' }, { slug: 'closed', label: 'Closed' },
        ] },
        materials: [
          { kind: 'document', title: 'Demo terms overview', content: 'Synthetic shared material. Review the proposed terms with your CARR advisor.' },
          { kind: 'tour', title: 'Demo tour summary', content: 'Synthetic tour. Two example locations are ready for discussion.' },
          { kind: 'report', title: 'Demo market report', content: 'Synthetic report. This preview contains no client records.' },
        ],
      };
    },
  };
}
