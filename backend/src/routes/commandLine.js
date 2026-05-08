const express = require("express");
const commandLine = require("../lib/commandLine");

function createRouter(service = commandLine) {
  const router = express.Router();

  router.get("/actions", (_req, res) => {
    res.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      items: service.listCommandActions(),
    });
  });

  router.post("/run", async (req, res, next) => {
    try {
      const actionId = String(req.body?.actionId || "").trim();

      if (!actionId) {
        return res.status(400).json({
          ok: false,
          code: "missing_action_id",
          message: "actionId is required.",
        });
      }

      const result = await service.runCommandAction(actionId, req.body?.params || {});
      return res.status(200).json(result);
    } catch (error) {
      return next(error);
    }
  });

  router.use((error, _req, res, next) => {
    if (!error?.statusCode) {
      return next(error);
    }

    return res.status(error.statusCode).json({
      ok: false,
      code: error.code || "command_line_error",
      message: error.message || "Command line request failed.",
      ...(error.details || {}),
    });
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
