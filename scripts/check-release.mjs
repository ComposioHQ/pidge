import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const failures = [];
const rules = [
  [
    "personal deployment hostname or path",
    /(?:[\w.-]+\.)?exe\.xyz|\/home\/(?:exedev|brendan)|olearycr\x65w|brendan\x40/i,
  ],
  ["real authentication link", /https:\/\/connect\.composio\.dev\/link\/[A-Za-z0-9_-]+/],
  [
    "provider credential",
    /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{15,})\b/,
  ],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["live service identifier", /\b(?:wrun_|trs_|ca_|spc-msg-)[A-Za-z0-9]{10,}\b/],
];
for (const file of files) {
  const attribute = execFileSync("git", ["check-attr", "export-ignore", "--", file], { encoding: "utf8" });
  if (attribute.trimEnd().endsWith(": set")) continue;
  if (
    /^(?:spike|design|node_modules|\.next|\.output|\.eve|\.workflow-data|\.data)(?:\/|$)/.test(file) ||
    /(?:^|\/)\.env(?:$|\.(?!example$))/.test(file) ||
    file === "GOAL.md"
  ) {
    failures.push(`${file}: private or generated file must not be exported`);
    continue;
  }
  const body = readFileSync(file);
  if (body.includes(0)) continue;
  for (const [index, line] of body.toString("utf8").split("\n").entries()) {
    for (const [label, pattern] of rules) {
      if (pattern.test(line)) failures.push(`${file}:${index + 1}: ${label}; redact it or use a fictional example`);
    }
    for (const phone of line.matchAll(/\+\d{10,15}\b/g)) {
      if (!/^\+1\d{3}555\d{4}$/.test(phone[0]) && phone[0] !== "+442079460958") {
        failures.push(`${file}:${index + 1}: non-fictional phone number; use a reserved example`);
      }
    }
    for (const email of line.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) {
      const domain = email[1].toLowerCase();
      if (
        !/^(?:(?:[a-z0-9-]+\.)*example\.(?:com|org|net)|[a-z0-9.-]+\.example|pidge\.invalid|b\.co)$/.test(domain) &&
        email[0].toLowerCase() !== "security@composio.dev"
      ) {
        failures.push(`${file}:${index + 1}: personal email; use an example address`);
      }
    }
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Release privacy check passed for ${files.length} tracked paths, excluding export-ignore files.`);
}
