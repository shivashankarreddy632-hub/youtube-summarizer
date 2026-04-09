// Patches youtube-transcript package after npm install
// Removes "type":"module" from its package.json so it works as CommonJS
const fs = require("fs");
const pkgPath = "node_modules/youtube-transcript/package.json";

if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (pkg.type === "module") {
    delete pkg.type;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    console.log("✅ Patched youtube-transcript: removed type:module");
  } else {
    console.log("ℹ️  youtube-transcript already patched or no patch needed");
  }
} else {
  console.log("⚠️  youtube-transcript not found, skipping patch");
}
