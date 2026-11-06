import { createServer as httpServer } from 'node:http';

export function createServer(listener) {
  return httpServer((req, res) => {
    if (new URL(req.url, 'http://fixture.invalid').pathname === '/app-release'
      && req.headers['x-doctorcre-release-reader'] !== '1') {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('App release reads require the shared reader');
      return;
    }
    return listener(req, res);
  });
}
