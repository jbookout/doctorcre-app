export const APP_REPOSITORY = 'DoctorCRE/doctorcre-app';
export const APP_REPOSITORY_ALIASES = Object.freeze([APP_REPOSITORY, 'jbookout/doctorcre-app']);
export const isAppRepository = value => APP_REPOSITORY_ALIASES.includes(value);
export const canonicalRepository = value => isAppRepository(value) ? APP_REPOSITORY
  : value === 'jbookout/carr-system' ? 'DoctorCRE/carr-system' : value;
export const PORTFOLIO_REPOSITORIES = Object.freeze(['DoctorCRE/carr-system', APP_REPOSITORY, 'jbookout/software-factory']);
export function isPortfolioPullRequest(href) {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/[1-9]\d*$/.exec(href);
  return Boolean(match && PORTFOLIO_REPOSITORIES.includes(canonicalRepository(match[1])));
}
