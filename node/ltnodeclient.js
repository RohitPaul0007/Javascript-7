let net = require("net");
let moduleCache = require("module")._cache;
let vm = require("vm");
let Module = require("module").Module;
let fs = require("fs");
let fpath = require("path");
let util = require("util");

let sandboxes = {};
let s = null;

let connected = false;
let currentModule = null;

function connect(script, port, cid) {
  s = net.connect(port, "localhost");
  s.on("connect", function() {
    connected = true;
    send({"name":fpath.basename(script), "type":"nodejs", "client-id": cid, "dir":fpath.dirname(script), "tags": ["nodejs.client"], "commands":["editor.eval.js"]});
    init(script);
  });
  s.on("data", function(d) {
    var req = JSON.parse(d.toString());
    handle(req);
  });
  s.on("error", function(e) {
    console.error("connect error:" + e.stack);
  });

}

var sharedGlob = {};
function context(path) {
  var sandbox = {};
  var mod = new Module(path);
  var exp = {};
  mod.id = path;
  mod.filename = path;
  mod.parent = currentModule;
  mod.paths = Module._nodeModulePaths(fpath.dirname(path));
  mod.exports = exp;
  for (var k in sharedGlob) {
    sandbox[k] = sharedGlob[k];
  }
  sandbox.lttools = process.mainModule.exports;
  sandbox.require = modRequire(mod);
  sandbox.__filename = fpath.basename(path);
  sandbox.__dirname = fpath.dirname(path);
  sandbox.module = mod;
  sandbox.global = sharedGlob;
  sandbox.GLOBAL = sharedGlob;
  sandbox.root = sharedGlob;
  sandbox.exports = exp;
  return vm.createContext(sandbox);
}

function send(msg) {
  s.write(JSON.stringify(msg) + "\n");
}

function response(req, cmd, data) {
  send([req[0], cmd, data]);
}

function wrappedFile(path) {
  return "(function (exports, require, module, __filename, __dirname) { " + cleanCode(fs.readFileSync(path)) + " })";
}

function getSB(path) {
  return sandboxes[path.toLowerCase()];
}

function cleanCode(code) {
  return code.toString().replace(/\n*#!.*\n/gim, "\n");
}

function modRequire(mod) {
  var req = function(path) {
    return sbRequire(mod.require, req.resolve, path);
  };
  req.resolve = function(path) {
    return Module._resolveFilename(path, mod);
  };
  req.cache = moduleCache;
  req.extensions = mod.require.extensions;
  return req;
}

function sbRequire(require, resolve, path) {
  if(!path) return;

  var path = resolve(path);
  if(!getSB(path)) {
    if(path.match(/[\\\/]/) && fpath.extname(path) == ".js") {
      var sb = sandboxes[path.toLowerCase()] = context(path);
      moduleCache[path] = sb.module;
      prevModule = currentModule;
      currentModule = sb.module;
      vm.runInContext(cleanCode(fs.readFileSync(path)), sb, path);
      currentModule = prevModule;
      sb.module.loaded = true;
    } else {
      return require(path);
    }
  }

  var curSb = getSB(path);
  var exports = curSb.module.exports;
  if(typeof(exports) == "function" || ((typeof exports === 'object') && (exports !== null) && Object.keys(exports).length)) {
    return exports;
  }
  if(typeof(curSb.exports) == "function" || ((typeof curSb.exports === 'object') && (curSb.exports !== null) && Object.keys(curSb.exports).length)) {
    return curSb.exports;
  }
  return exports;
}


function init(path) {
  sandboxes["ltuser"] = context("ltuser");
  sbRequire(require, require.resolve, path);
  //require(path);
  //TODO: fixup mainModule and such
}

function handle(req) {
  if(req[1] == "client.close") {
    s.end();
    process.exit(0);
  } else if(req[1] == "editor.eval.js") {
    var path = req[2].path || "ltuser";
    if(path != "ltuser") {
      sbRequire(require, require.resolve, path);
    }
    try {
      currentModule = getSB(path).module;
      response(req, "editor.eval.js.result", {meta: req[2].meta,
                                              "no-inspect": true,
                                              result: util.inspect(vm.runInContext(req[2].code, getSB(path)), false, 2)
                                             });
    } catch(e) {
      response(req, "editor.eval.js.exception", {meta: req[2].meta, ex: e.stack});
    }
  }
}

function watch(exp, meta) {
  meta["no-inspect"] = true;
  response({}, "clients.raise-on-object", [meta.obj, "editor.eval.js.watch", {result: util.inspect(exp, false, 1), meta: meta}]);
  return exp;
}

exports.handle = handle;
exports.connect = connect;
exports.watch = watch;

global.lttools = exports;
for (var k in global) {
  sharedGlob[k] = global[k];
}

if(process.mainModule == module) {
  connect(process.argv[2], process.argv[3], parseInt(process.argv[4]));
}
