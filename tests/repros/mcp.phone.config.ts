import { web } from '@e2e-dev/web';
import config from '../../e2e.round2.config.ts';
import { seedFixture } from '../qa/support.ts';
const url = process.env.QA_APP_URL || 'http://127.0.0.1:18997';
const seeded = await seedFixture(url, 'round2-repros-mcp', 'joe', 'realistic', true);
export default { ...config, output: '.e2e/repros-mcp-phone', targets: [{ name: 'app-desktop', app: { url }, engine: web({ viewport: { width: 390, height: 844 }, initScripts: [`document.cookie = ${JSON.stringify(`${seeded.cookie.name}=${seeded.cookie.value}; Path=/; SameSite=Lax`)};`] }) }] };
