import path from "node:path";
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(path.join(process.cwd(), "lib", "index.js")).href);
let failures = 0;
function check(label, actual, expected) {
  const ok = Array.isArray(expected) ? JSON.stringify(actual) === JSON.stringify(expected) : Object.is(actual, expected) || String(actual).includes(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  -> ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
  if (!ok) failures++;
}
check("exports toWslPath", typeof mod.toWslPath, "function");
check("exports WslBashExecutor", typeof mod.WslBashExecutor, "function");
check("toWslPath drive path", mod.toWslPath("E:\\work dir\\proj"), "/mnt/e/work dir/proj");
check("toWslPath forward slashes", mod.toWslPath("E:/work/proj"), "/mnt/e/work/proj");
check("toWslPath bare drive", mod.toWslPath("C:"), "/mnt/c");
check("toWslPath UNC wsl.localhost", mod.toWslPath("\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\proj"), "/home/me/proj");
check("toWslPath UNC wsl$", mod.toWslPath("\\\\wsl$\\Ubuntu-22.04\\opt"), "/opt");
check("toWslPath POSIX passthrough", mod.toWslPath("/home/me"), "/home/me");
check("toWslPath relative passthrough", mod.toWslPath("foo/bar"), "foo/bar");
// wslCommand: build the in-shell export prefix (spec.env + dshEnv precedence, quoting).
function wslCommand(spec, mfe) { return mod.wslCommand(spec, mfe); }
{
  const mfe = { NO_COLOR: "1", TERM: "dumb" };
  const out = wslCommand({ command: "echo x", env: { ENTERPRI:"a'b" }, dshEnv: { DSH_T: "wörld" } }, mfe);
  check("wslCommand exports NO_COLOR", out, "export NO_COLOR='1'");
  check("wslCommand exports TERM", out, "export TERM='dumb'");
  const lines = out.split("\n");
  check("wslCommand command appended last", lines[lines.length - 1], "echo x");
  check("wslCommand preserves quote inside value", out, "export ENTERPRI='a'\\''b'");
  check("wslCommand DSH_T wins", out, "export DSH_T='wörld'");
}
console.log(failures === 0 ? "\nALL RUNTIME PURES PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
