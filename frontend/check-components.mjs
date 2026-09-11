/* Find identifiers a module uses but never defines or imports.
 *
 * Written after shipping `<TrialStrip …/>` whose definition a string-replace
 * had silently failed to insert. The bundler is happy — an undefined global is
 * legal JavaScript — and it only fails when React reaches that line, at which
 * point the screen is blank. A parse-level check catches it in a second.
 *
 * It checked only JSX tags at first, and that let the identical mistake
 * through a second time: an `import { printReportNode }` line whose anchor had
 * changed, so the replace matched nothing, the call compiled, and the Print
 * button on Cash & bank threw "printReportNode is not defined". Called
 * functions are checked too now, which is the other half of the same class.
 *
 * Run with no arguments it checks every .jsx under src/.
 *
 *   node check-components.mjs
 *   node check-components.mjs src/App.jsx
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/* The parser is a devDependency. If it is not installed — somebody running
   this from a copy that was never `npm install`ed — say so and pass, because
   a missing checker must not be the thing that stops a shop opening. */
let Parser, jsx, walk;
try {
  ({ Parser } = await import('acorn'));
  jsx = (await import('acorn-jsx')).default;
  walk = await import('acorn-walk');
} catch {
  console.log('components: parser not installed, skipped (run npm install to enable)');
  process.exit(0);
}

const P = Parser.extend(jsx());

/* acorn-walk does not know the JSX node types; teach it to descend. */
const base = walk.make({});
for (const t of ['JSXElement', 'JSXFragment', 'JSXOpeningElement', 'JSXClosingElement',
                 'JSXAttribute', 'JSXSpreadAttribute', 'JSXExpressionContainer',
                 'JSXText', 'JSXIdentifier', 'JSXMemberExpression', 'JSXEmptyExpression',
                 'JSXNamespacedName', 'JSXClosingFragment', 'JSXOpeningFragment']) {
  base[t] = (node, st, c) => {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach((n) => n && n.type && c(n, st));
      else if (v && v.type) c(v, st);
    }
  };
}

const GLOBALS = new Set([
  'window', 'document', 'console', 'localStorage', 'sessionStorage', 'navigator',
  'location', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'JSON', 'Math', 'Date', 'Number',
  'String', 'Boolean', 'Array', 'Object', 'Set', 'Map', 'WeakMap', 'Promise', 'Error',
  'RegExp', 'Intl', 'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'FormData',
  'Image', 'Audio', 'Event', 'CustomEvent', 'AbortController', 'TextEncoder',
  'TextDecoder', 'crypto', 'atob', 'btoa', 'alert', 'confirm', 'prompt', 'isNaN',
  'parseInt', 'parseFloat', 'undefined', 'NaN', 'Infinity', 'globalThis', 'structuredClone',
  'React', 'process', 'require', 'module', 'exports', '__dirname', 'arguments', 'Symbol',
  'Uint8Array', 'ArrayBuffer', 'DataView', 'Proxy', 'Reflect', 'BigInt', 'queueMicrotask',
  'performance', 'history', 'screen', 'matchMedia', 'getComputedStyle', 'MutationObserver',
  'IntersectionObserver', 'ResizeObserver', 'XMLHttpRequest', 'WebSocket', 'Worker',
  /* Called as bare functions, which the call check reaches and the component
     check never did. */
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'setImmediate', 'clearImmediate', 'reportError', 'print', 'open', 'close',
  'Number', 'BigInt', 'Function', 'eval',
]);

function declaredNames(ast) {
  const names = new Set();
  const add = (n) => { if (n) names.add(n); };
  const pattern = (node) => {
    if (!node) return;
    if (node.type === 'Identifier') add(node.name);
    else if (node.type === 'ObjectPattern') node.properties.forEach((p) =>
      pattern(p.value || p.argument));
    else if (node.type === 'ArrayPattern') node.elements.forEach(pattern);
    else if (node.type === 'AssignmentPattern') pattern(node.left);
    else if (node.type === 'RestElement') pattern(node.argument);
  };
  walk.full(ast, (node) => {
    switch (node.type) {
      case 'VariableDeclarator': pattern(node.id); break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.id) add(node.id.name);
        (node.params || []).forEach(pattern);
        break;
      case 'ClassDeclaration': if (node.id) add(node.id.name); break;
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
      case 'ImportSpecifier': add(node.local.name); break;
      case 'CatchClause': pattern(node.param); break;
      case 'LabeledStatement': add(node.label.name); break;
    }
  }, base);
  return names;
}

function everyJsx(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = dir + '/' + e.name;
    if (e.isDirectory()) everyJsx(p, out);
    else if (e.name.endsWith('.jsx')) out.push(p);
  }
  return out;
}

const files = process.argv.length > 2
  ? process.argv.slice(2)
  : everyJsx(path.join(path.dirname(fileURLToPath(import.meta.url)), 'src'));

let bad = 0;
for (const f of files) {
  let ast;
  try {
    ast = P.parse(fs.readFileSync(f, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
  } catch (e) { console.log(`PARSE ${f} → ${e.message}`); bad++; continue; }

  const declared = declaredNames(ast);
  const missing = new Map();

  /* Anything reached through a dot or a key is somebody else's namespace, and
     nothing here can say whether it exists. Only bare names are checked. */
  const note = (n, how) => {
    if (declared.has(n) || GLOBALS.has(n)) return;
    const key = `${how}:${n}`;
    missing.set(key, (missing.get(key) || 0) + 1);
  };

  walk.full(ast, (node) => {
    /* <Thing /> — only capitalised names, which is what React treats as a
       component rather than a DOM tag. */
    if (node.type === 'JSXOpeningElement' && node.name && node.name.type === 'JSXIdentifier') {
      const n = node.name.name;
      if (/^[A-Z]/.test(n)) note(n, 'component');
    }
    /* thing(…) — a call on a bare name. `a.b()` is skipped: the callee is a
       MemberExpression and what it resolves to is not knowable from here. */
    if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier') {
      note(node.callee.name, 'function');
    }
  }, base);

  if (missing.size) {
    bad++;
    for (const [key, count] of missing) {
      const [how, n] = key.split(':');
      const used = how === 'component' ? `<${n}>` : `${n}()`;
      console.log(`MISSING ${f} → ${used} used ${count}× but never defined or imported`);
    }
  }
}
if (bad) {
  console.log(`\n${bad} file(s) reference something that does not exist. The bundle would`);
  console.log('build anyway and it would throw the moment that line ran.');
} else {
  console.log(`components: ${files.length} files, all references resolve`);
}
process.exit(bad ? 1 : 0);
