const schedulers = new Set(['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask']);
const name = node => node.computed ? node.property.value : node.property.name;

export default {
  rules: {
    'no-scheduler-alias': {
      meta: { schema: [] },
      create(context) {
        const check = node => {
          const parent = node.parent;
          if (parent.type === 'CallExpression' && parent.callee === node) return;
          if (parent.type === 'UnaryExpression' && parent.operator === 'typeof') return;
          if ((parent.type === 'ConditionalExpression' || parent.type === 'IfStatement') && parent.test === node) return;
          context.report({ node, message: 'Do not alias schedulers; call the scheduler directly with a bounded call-site exemption.' });
        };
        return {
          Identifier(node) {
            if (!schedulers.has(node.name)) return;
            const scope = context.sourceCode.getScope(node);
            if (scope.references.some(ref => ref.identifier === node && ref.isRead())) check(node);
            if (node.parent.type === 'ExportSpecifier' && node.parent.local === node) check(node);
          },
          MemberExpression(node) { if (['window', 'globalThis', 'self'].includes(node.object.name) && schedulers.has(name(node))) check(node); },
          'ObjectPattern > Property'(node) {
            const owner = node.parent.parent;
            const key = node.key.name || node.key.value;
            const binding = node.value.name || node.value.left?.name;
            const parameter = /Function/.test(owner.type) && owner.params.includes(node.parent) && binding === key;
            if (!parameter && schedulers.has(node.key.name || node.key.value)) {
              context.report({ node, message: 'Do not destructure schedulers; call the scheduler directly.' });
            }
          },
        };
      },
    },
    'bounded-exemption': {
      meta: { schema: [] },
      create(context) {
        return { Program() {
          for (const comment of context.sourceCode.getAllComments()) {
            if (!/eslint-disable(?:-next-line|-line)?\b/.test(comment.value)) continue;
            const [directive, reason = ''] = comment.value.split(/\s--\s/, 2);
            if (!directive.includes('no-restricted-syntax') && !/^\s*eslint-disable(?:-next-line|-line)?\s*$/.test(directive)) continue;
            if (!/\d|\b(?:cleanup|cancel)\b/i.test(reason)) {
              context.report({ loc: comment.loc, message: 'Exemption reasons must contain a number, cleanup, or cancel.' });
            }
          }
        } };
      },
    },
  },
};
