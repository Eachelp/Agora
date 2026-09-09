const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { getInstalledFonts } = require("../src/installed-fonts");
const {
  getAutostartFile,
  isLinuxAutoLaunchEnabled,
  quoteDesktopExec,
  setLinuxAutoLaunchEnabled,
} = require("../src/linux-auto-launch");
const { secretToolArgs } = require("../src/linux-credential");

test("Linux fonts are read from fontconfig family names", async () => {
  let invocation = null;
  const run = (command, args, options, callback) => {
    invocation = { command, args, options };
    callback(null, "DejaVu Sans,DejaVu Sans Condensed\nNoto Sans CJK KR\n");
  };

  const fonts = await getInstalledFonts({ run, platform: "linux" });
  assert.deepEqual(fonts, ["DejaVu Sans", "DejaVu Sans Condensed", "Noto Sans CJK KR"]);
  assert.equal(invocation.command, "fc-list");
  assert.deepEqual(invocation.args, ["--format=%{family}\\n"]);
});

test("Linux auto launch writes and removes one XDG desktop entry", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-linux-autostart-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const executable = "/home/person/Code Pet.AppImage";

  setLinuxAutoLaunchEnabled(true, { home, executable, args: ["--settings"] });

  const file = getAutostartFile({ home });
  assert.equal(isLinuxAutoLaunchEnabled({ home }), true);
  const contents = fs.readFileSync(file, "utf8");
  assert.match(contents, /^\[Desktop Entry\]$/m);
  assert.match(contents, new RegExp(`Exec=${quoteDesktopExec(executable)} ${quoteDesktopExec("--settings")}`));

  setLinuxAutoLaunchEnabled(false, { home });
  assert.equal(fs.existsSync(file), false);
});

test("Linux credentials use fixed secret-tool attributes", () => {
  assert.deepEqual(secretToolArgs("lookup", "gemini:antigravity"), [
    "lookup", "application", "agora", "target", "gemini:antigravity",
  ]);
  assert.deepEqual(secretToolArgs("store", "gemini:antigravity"), [
    "store", "--label=Agora", "application", "agora", "target", "gemini:antigravity",
  ]);
});
