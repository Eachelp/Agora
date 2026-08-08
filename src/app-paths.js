const os = require("node:os");
const path = require("node:path");

const AGORA_HOME_ENV = "AGORA_HOME";

function defaultAgoraHome(env = process.env, home = os.homedir()) {
  const override = env?.[AGORA_HOME_ENV];
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  return path.join(home, ".agora");
}

module.exports = { AGORA_HOME_ENV, defaultAgoraHome };
