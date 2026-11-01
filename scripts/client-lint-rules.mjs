const schedulers = new Set(['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask']);

export default {
  rules: {
    'no-scheduler-alias': {
      meta: { schema: [] },
      create(context) {
        const name = node => {
          if (!node.computed) return node.property.name;
          let key = node.property;
          if (key.type === 'Identifier') {
            let scope = context.sourceCode.getScope(key);
            while (scope && !scope.set.has(key.name)) scope = scope.upper;
            const variable = scope?.set.get(key.name);
            if (variable?.defs.length !== 1) return;
            const definition = variable.defs[0];
            if (definition.type !== 'Variable' || definition.parent.kind !== 'const') return;
            key = definition.node.init;
          }
          if (key?.type === 'Literal') return key.value;
          if (key?.type === 'TemplateLiteral' && key.expressions.length === 0) return key.quasis[0].value.cooked;
        };
        const globals = new Set(['window', 'globalThis', 'self']);
        const isGlobal = node => node?.type === 'Identifier' && globals.has(node.name);
        const check = node => {
          const parent = node.parent;
          if (parent.type === 'CallExpression' && parent.callee === node && !(node.computed && node.property.type === 'Identifier')) return;
          if (parent.type === 'UnaryExpression' && parent.operator === 'typeof') return;
          if ((parent.type === 'ConditionalExpression' || parent.type === 'IfStatement') && parent.test === node) return;
          context.report({ node, message: parent.type === 'CallExpression' && parent.callee === node
            ? 'Do not call schedulers through const-bound computed keys; use a direct bounded call site.'
            : 'Do not alias schedulers; call the scheduler directly with a bounded call-site exemption.' });
        };
        return {
          VariableDeclarator(node) { if (node.id.type === 'Identifier' && isGlobal(node.init)) globals.add(node.id.name); },
          AssignmentExpression(node) { if (node.left.type === 'Identifier' && isGlobal(node.right)) globals.add(node.left.name); },
          Identifier(node) {
            if (!schedulers.has(node.name)) return;
            const scope = context.sourceCode.getScope(node);
            if (scope.references.some(ref => ref.identifier === node && ref.isRead())) check(node);
            if (node.parent.type === 'ExportSpecifier' && node.parent.local === node) check(node);
          },
          MemberExpression(node) { if (isGlobal(node.object) && schedulers.has(name(node))) check(node); },
          'ObjectPattern > Property'(node) {
            const owner = node.parent.parent;
            const key = name({ computed: node.computed, property: node.key });
            if (['window', 'globalThis', 'self'].includes(key) && node.value.type === 'Identifier' && isGlobal(owner.init || owner.right)) globals.add(node.value.name);
            const binding = node.value.name || node.value.left?.name;
            const parameter = /Function/.test(owner.type) && owner.params.includes(node.parent) && binding === key;
            if (!parameter && schedulers.has(key)) {
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
            const words = reason.toLowerCase().match(/[a-z]+(?:\/[a-z]+)?/g) || [];
            const placeholder = /\b(?:todo|fixme|tbd|n\/a|temporary|temp|later|xxx|placeholder)\b/i;
            const boundOrOwner = /^(?:once|cleared|clearTimeout|clearInterval|cancel|dispose|unmount|abort|stop|max|cap|limit|until|after|only|single|owner|debounce|throttle)$/i;
            if (placeholder.test(reason) || words.filter(word => !placeholder.test(word) && !boundOrOwner.test(word)).length < 4 || !words.some(word => boundOrOwner.test(word))) {
              context.report({ loc: comment.loc, message: 'Exemption reasons must explain a bound or owner in at least four words.' });
            }
          }
        } };
      },
    },
  },
};
