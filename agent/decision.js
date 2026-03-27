function decideAction(aiResult) {
  if (!aiResult) return { action: "none" };

  const { severity, confidence, suggested_action } = aiResult;

  //if decision is not trustworthy even to AI
  if (confidence < 0.6) {
    return { action: "none", reason: "Low confidence" };
  }

  // if AI suggests restart with high confidence
  if (severity === "high") {
    if (suggested_action.toLowerCase().includes("restart")) {
      return { action: "restart_service" };
    }

    if (suggested_action.toLowerCase().includes("scale")) {
      return { action: "scale_service" };
    }
  }

  return { action: "log_only" };
}

module.exports = decideAction;