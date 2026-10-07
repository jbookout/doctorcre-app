import { randomUUID } from 'node:crypto';
import { defineTool, getToolContext } from 'e2e/agent';
import { tool } from 'ai';
import { z } from 'zod';
import { seedFixture } from './support.ts';

export function createQaTools(baseUrl: string, namespace = process.env.QA_NAMESPACE || 'round2') {
  return {
    seedFixtureAccount: defineTool(tool({
      description: `Replace only the explicitly named synthetic QA namespace with realistic, large, or empty deals/leads/invoices. The configured namespace is ${namespace}; individual tests may use a suffix. Supply the current authenticated viewer and exact active test namespace. This tool does not switch browser cookies or identity.`,
      inputSchema: z.object({variant:z.enum(['realistic','large','empty']),namespace:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/),viewer:z.enum(['joe','dell'])}).strict(),
      execute: async input => {
        const {synthetic,namespace:seededNamespace,viewer,variant,counts}=await seedFixture(baseUrl,input.namespace,input.viewer,input.variant,true);
        return {synthetic,namespace:seededNamespace,viewer,variant,counts};
      },
    }), { mutates:true, platforms:['web'] }),
    captureEvidence: defineTool(tool({
      description: 'Capture a masked screenshot of the current page as step evidence.',
      inputSchema: z.object({label:z.string().optional()}).strict(),
      execute: async (input, options) => {
        const context = getToolContext(options);
        const observed = await context.observe({pixels:true});
        if (!observed.pixels) return {withheld:observed.pixelsWithheld || 'UNSUPPORTED_CAPABILITY'};
        return {evidence:await context.attachScreenshot(observed.pixels, `${input.label || 'qa'}-${randomUUID()}`)};
      },
    }), {mutates:false, platforms:['web']}),
  };
}
