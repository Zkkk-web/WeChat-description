import { classifyMail } from "./classifyMail.js";
import { normalizeMailEvent } from "./normalizeMail.js";
import { planMailWrites } from "./routeMail.js";
import { isLarkBaseEnabled, writePlannedWrites } from "../integrations/larkBase.js";

export async function processMailEvent(event, options = {}) {
  const mail = normalizeMailEvent(event);
  const classification = classifyMail(mail);
  const plannedWrites = planMailWrites(mail, classification);
  const larkBase = options.larkBase;
  let actualWrites = [];
  let writeStatus = "disabled";
  let writeError = "";

  if (isLarkBaseEnabled(larkBase)) {
    writeStatus = "succeeded";
    try {
      actualWrites = await writePlannedWrites(larkBase, plannedWrites, options);
    } catch (error) {
      writeStatus = "failed";
      writeError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    mail,
    classification,
    plannedWrites,
    actualWrites,
    writeStatus,
    writeError,
  };
}
