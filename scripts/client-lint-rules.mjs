import { parse } from '@babel/parser';
import { analyze } from 'eslint-scope';
import esquery from 'esquery';
import { JSDOM } from 'jsdom';
import { isUiAsset } from './ui-bundle.mjs';

export function codeRuleIssues(source) {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const issues = [];
  for (const comment of ast.comments) {
    if (/@ts-(?:ignore|expect-error|nocheck)|biome-ignore/.test(comment.value)) issues.push('Suppression directives are forbidden');
  }
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (['TSAnyKeyword', 'TSNonNullExpression', 'TSEnumDeclaration', 'TSModuleDeclaration', 'TSParameterProperty'].includes(node.type)) issues.push(`${node.type} is forbidden`);
    if (['TSAsExpression', 'TSTypeAssertion'].includes(node.type) && node.typeAnnotation.type !== 'TSConstKeyword' && node.typeAnnotation.typeName?.name !== 'const') {
      const previous = source.split('\n')[node.loc.start.line - 2] || '';
      if (!/^\s*\/\/\s+\S.{12,}$/.test(previous)) issues.push('A cast requires an adjacent one-line reason');
    }
    for (const [key, value] of Object.entries(node)) {
      if (['comments', 'leadingComments', 'trailingComments', 'innerComments', 'loc'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast.program);
  return issues;
}

const schedulers = new Set(['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask']);

const client = {
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

const message = 'Use createPageBudget / createRequestBudget for bounded reads; use TanStack Query refetchInterval for React polling. Audited sites need an inline reason naming the bound.';
const restrictions = [

        { selector: 'VariableDeclarator:matches([init.name=/^(EventSource|WebSocket)$/], [init.property.name=/^(EventSource|WebSocket)$/], [init.property.value=/^(EventSource|WebSocket)$/])', message },
        { selector: 'ObjectPattern > Property:matches([key.name=/^(EventSource|WebSocket)$/], [key.value=/^(EventSource|WebSocket)$/])', message },
        { selector: ':matches(WhileStatement, DoWhileStatement, ForStatement, ForOfStatement[await=true], ForOfStatement:has(AwaitExpression), ForInStatement:has(AwaitExpression))', message },
        { selector: 'FunctionDeclaration[id.name=/^create(Page|Request)Budget$/]', message },
        { selector: ':matches(CallExpression, NewExpression):matches([callee.name=/^(setInterval|setTimeout|requestAnimationFrame|requestIdleCallback|queueMicrotask|EventSource|WebSocket)$/], [callee.property.name=/^(setInterval|setTimeout|requestAnimationFrame|requestIdleCallback|queueMicrotask|EventSource|WebSocket)$/], [callee.property.value=/^(setInterval|setTimeout|requestAnimationFrame|requestIdleCallback|queueMicrotask|EventSource|WebSocket)$/], [callee.property.type="TemplateLiteral"][callee.property.expressions.length=0][callee.property.quasis.0.value.cooked=/^(setInterval|setTimeout|requestAnimationFrame|requestIdleCallback|queueMicrotask|EventSource|WebSocket)$/])', message },
        { selector: ':matches(CallExpression, NewExpression):matches([callee.name=/retry|reconnect|refetchInterval/i], [callee.property.name=/retry|reconnect|refetchInterval/i], [callee.property.value=/retry|reconnect|refetchInterval/i])', message },
        { selector: 'Property:matches([key.name=/retry|reconnect|refetchInterval/i], [key.value=/retry|reconnect|refetchInterval/i])', message },
        { selector: 'CallExpression:matches([callee.name="addEventListener"], [callee.property.name="addEventListener"], [callee.property.value="addEventListener"]):not([arguments.0.type="Literal"][arguments.0.value!=/^(focus|online|visibilitychange|pageshow)$/])', message },
];

export class ClientLint {
  constructor(options = {}) { this.options = options; }
  async isPathIgnored(path) {
    return isUiAsset(path) || path === 'tours/day-shell.generated.js' || /(^|\/)vendor\//.test(path) || /\.d\.[cm]?ts$/.test(path);
  }
  async lintText(source, { filePath }) {
    if (await this.isPathIgnored(filePath)) return [];
    const sources = filePath.endsWith('.html')
      ? [...JSDOM.fragment(source).querySelectorAll('script:not([src])')].map(script => script.textContent)
      : [source];
    const messages = [];
    let fatalErrorCount = 0;
    for (const text of sources) {
      let ast;
      try { ast = parse(text, { sourceType: 'module', plugins: ['typescript', 'jsx', 'estree'], ranges: true, allowAwaitOutsideFunction: true }).program; }
      catch (error) { messages.push({ ruleId: null, message: error.message, line: error.loc?.line || 1, column: (error.loc?.column || 0) + 1 }); fatalErrorCount++; continue; }
      const scopes = analyze(ast, { ecmaVersion: 2024, sourceType: 'module', fallback: 'iteration' }).scopes;
      const nodes = [];
      function visit(node, parent) {
        if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
        Object.defineProperty(node, 'parent', { value: parent, configurable: true });
        nodes.push(node);
        for (const [key, value] of Object.entries(node)) {
          if (['comments', 'leadingComments', 'trailingComments', 'innerComments', 'loc', 'tokens'].includes(key)) continue;
          if (Array.isArray(value)) { for (const child of value) visit(child, node); }
          else visit(value, node);
        }
      }
      visit(ast, null);
      const comments = parse(text, { sourceType: 'module', plugins: ['typescript', 'jsx', 'estree'], allowAwaitOutsideFunction: true }).comments;
      const report = (ruleId, detail) => {
        const loc = detail.loc?.start || detail.loc || detail.node.loc.start;
        messages.push({ ruleId, message: detail.message, line: loc.line, column: loc.column + 1 });
      };
      const sourceCode = {
        getAllComments: () => comments,
        getScope: node => [...scopes].reverse().find(scope => scope.block.start <= node.start && scope.block.end >= node.end) || scopes[0],
      };
      for (const [name, rule] of Object.entries(client.rules)) {
        const listeners = Object.entries(rule.create({ sourceCode, report: detail => report(`client/${name}`, detail) }))
          .map(([selector, listener]) => [esquery.parse(selector), listener]);
        for (const node of nodes) for (const [selector, listener] of listeners) {
          const ancestry = []; for (let parent = node.parent; parent; parent = parent.parent) ancestry.push(parent);
          if (esquery.matches(node, selector, ancestry)) listener(node);
        }
      }
      const exempt = node => {
        if (this.options.allowInlineConfig === false) return false;
        let disabled = false;
        for (const comment of comments) {
          const directive = comment.value.split(/\s--\s/, 1)[0];
          const match = directive.match(/^\s*(eslint-disable(?:-next-line|-line)?|eslint-enable)(?:\s+(.*?))?\s*$/);
          if (!match) continue;
          const names = (match[2] || '').split(/[\s,]+/).filter(Boolean);
          if (names.length && !names.includes('no-restricted-syntax')) continue;
          if (match[1] === 'eslint-disable-next-line' && comment.loc.end.line + 1 === node.loc.start.line) return true;
          if (match[1] === 'eslint-disable-line' && comment.loc.start.line === node.loc.start.line) return true;
          if (match[1] === 'eslint-disable' && comment.end < node.start) disabled = true;
          if (match[1] === 'eslint-enable' && comment.end < node.start) disabled = false;
        }
        return disabled;
      };
      for (const restriction of restrictions) {
        const selector = esquery.parse(restriction.selector);
        for (const node of nodes) {
          const ancestry = []; for (let parent = node.parent; parent; parent = parent.parent) ancestry.push(parent);
          if (esquery.matches(node, selector, ancestry) && !exempt(node)) report('no-restricted-syntax', { node, message });
        }
      }
    }
    return [{ filePath, messages, errorCount: messages.length, warningCount: 0, fatalErrorCount }];
  }
}
