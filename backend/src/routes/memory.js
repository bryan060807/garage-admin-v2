const express = require("express");
const repository = require("../lib/repository");

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
  "/incidents",
  asyncRoute(async (_req, res) => {
    const items = await repository.listIncidents();
    res.json({ items });
  }),
);

router.post(
  "/incidents",
  asyncRoute(async (req, res) => {
    const { title } = req.body || {};
    if (!title) {
      return res.status(400).json({ error: "title is required" });
    }

    const item = await repository.createIncident(req.body);
    res.status(201).json({ item });
  }),
);

router.get(
  "/services",
  asyncRoute(async (_req, res) => {
    const items = await repository.listServiceFacts();
    res.json({ items });
  }),
);

router.post(
  "/services",
  asyncRoute(async (req, res) => {
    const { serviceName, factKey } = req.body || {};
    if (!serviceName || !factKey) {
      return res.status(400).json({ error: "serviceName and factKey are required" });
    }

    const item = await repository.upsertServiceFact(req.body);
    res.status(201).json({ item });
  }),
);

router.get(
  "/audit",
  asyncRoute(async (_req, res) => {
    const items = await repository.listAudit();
    res.json({ items });
  }),
);

router.post(
  "/audit",
  asyncRoute(async (req, res) => {
    const { actionType, target } = req.body || {};
    if (!actionType || !target) {
      return res.status(400).json({ error: "actionType and target are required" });
    }

    const item = await repository.createAudit(req.body);
    res.status(201).json({ item });
  }),
);

module.exports = router;
