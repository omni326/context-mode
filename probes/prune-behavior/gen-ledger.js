// Fixture generator: writes ledger.txt with a runtime-drawn secret on line 137,
// and prints the value once for the driver. Only the file and the eventual
// `read` tool result ever carry the value.
const c = require("crypto");
const fs = require("fs");
const v = c.randomBytes(16).toString("hex");
const lines = [];
for (let i = 1; i <= 400; i++) {
  lines.push(i === 137 ? "FLUSH-7731 = " + v : "row " + i + " " + c.randomBytes(24).toString("hex"));
}
fs.writeFileSync(__dirname + "/ledger.txt", lines.join("\n") + "\n");
console.log(v);
