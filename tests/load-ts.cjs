const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Each loader isolates module state. OS/network entry points are denied unless a test
// supplies a fixture adapter; the Electron executable is never launched.
module.exports = function loader(overrides = {}, platform = process.platform, env = {}) {
  const cache = new Map();
  const root = path.resolve(__dirname, '..');
  const blocked = () => { throw new Error('Unexpected OS side effect in safety test'); };
  const defaults = {
    electron: { app: { getPath: blocked }, shell: { trashItem: blocked }, safeStorage: {} },
    'node:child_process': { execFile: blocked, spawn: blocked },
    './aiProviders/claude': { askClaude: blocked },
    './aiProviders/openai': { askOpenAi: blocked },
  };
  function load(file) {
    const abs = path.resolve(root, file);
    if (!abs.startsWith(root + path.sep)) throw new Error('Module outside fixture source tree');
    if (cache.has(abs)) return cache.get(abs).exports;
    const mod = { exports: {} }; cache.set(abs, mod);
    const source = fs.readFileSync(abs, 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const req = id => {
      if (Object.hasOwn(overrides, id)) return overrides[id];
      if (Object.hasOwn(defaults, id)) return defaults[id];
      if (id.startsWith('.')) return load(path.resolve(path.dirname(abs), id + '.ts'));
      return require(id);
    };
    const fn = vm.runInThisContext('(function(require,module,exports,process){' + compiled + '\n})', { filename: abs });
    fn(req, mod, mod.exports, { platform, env, pid: process.pid });
    return mod.exports;
  }
  return load;
};
