// Tes updater (company-agents/updater.js): modulnya termuat dan tipe update dikenali. Jalankan: sh tests/run-js.sh
import { isUrgentUpdate, checkPixelHqUpdate, executePixelHqUpdate } from "./updater.js";

let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; print(`GAGAL: ${m}`); } };
ok(typeof checkPixelHqUpdate === "function" && typeof executePixelHqUpdate === "function", "fungsi updater ada");
ok(isUrgentUpdate("hotfix") && isUrgentUpdate(" Critical ") && !isUrgentUpdate("normal") && !isUrgentUpdate(undefined), "tipe update penting");
print(`${passed} lolos, ${failed} gagal`);
if (failed) imports.system.exit(1);
