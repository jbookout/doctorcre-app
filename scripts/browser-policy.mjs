import { chromium } from 'playwright';
import { createChromiumLauncher } from './browser-policy-internal.mjs';

export const launchChromium = createChromiumLauncher(chromium);
