declare const worker: { fetch(request: Request, env: { GIT_SHA: string; APP_ENV: string }): Promise<Response> };
export default worker;
