const express = require("express");
const bridgeClient = require("../lib/bridgeClient");

const router = express.Router();

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

router.get(
  "/health",
  asyncRoute(async (_req, res) => {
    const response = await bridgeClient.getHealth();
    res.status(response.ok ? 200 : response.status || 500).json({
      ok: response.ok,
      data: response.data || null,
      error: response.error || null,
    });
  }),
);

router.get(
  "/logs/:service",
  asyncRoute(async (req, res) => {
    const service = req.params.service;

    if (!service) {
      return res.status(400).json({ error: "service is required" });
    }

    const response = await bridgeClient.getLogs(service);
    let logs = "";

    if (typeof response.data === "string") {
      logs = response.data;
    } else if (response.data && typeof response.data.logs === "string") {
      logs = response.data.logs;
    } else if (response.data != null) {
      logs = JSON.stringify(response.data, null, 2);
    }

    res.status(response.ok ? 200 : response.status || 500).json({
      ok: response.ok,
      service,
      logs,
      error: response.error || null,
    });
  }),
);

module.exports = router;
