export function assertStagingDeployment(config) {
  const stage = config.env?.staging;
  if (stage?.name !== 'doctorcre-app-staging' || stage.workers_dev !== true || !Array.isArray(stage.routes) || stage.routes.length
    || stage.vars?.APP_ENV !== 'staging' || stage.services?.length !== 1
    || stage.services[0].binding !== 'CARR' || stage.services[0].service !== 'carr-mcp-staging') {
    throw new Error('E2E deployment requires the isolated staging Worker and CARR binding');
  }
}
