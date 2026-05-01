const express = require("express");
const serviceOperations = require("../lib/serviceOperations");
const serviceDiscovery = require("../lib/serviceDiscovery");

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
  "/",
  asyncRoute(async (_req, res) => {
    const result = await serviceDiscovery.listUnifiedServices();

    res.status(result.ok ? 200 : 502).json({
      ok: result.ok,
      items: result.items,
      sources: result.sources,
    });
  }),
);

router.get(
  "/:service/logs",
  asyncRoute(async (req, res) => {
    const response = await serviceOperations.fetchServiceLogs(req.params.service);

    res.status(response.ok ? 200 : response.status || 500).json({
      ...(response.data || {}),
      ok: response.ok,
      error: response.error || null,
    });
  }),
);

router.get(
  "/:service/health",
  asyncRoute(async (req, res) => {
    const response = await serviceOperations.fetchServiceHealth(req.params.service);

    res.status(response.ok ? 200 : response.status || 500).json({
      ...(response.data || {}),
      ok: response.ok,
      error: response.error || null,
    });
  }),
);

module.exports = router;
