const express = require("express");

const assistantLookup = require("../lib/assistantLookup");

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

function sendLookupResult(res, result) {
  const { status = 200, ...payload } = result;
  res.status(status).json(payload);
}

router.get(
  "/reports",
  asyncRoute(async (req, res) => {
    const result = await assistantLookup.listReports({
      query: req.query?.q,
    });

    sendLookupResult(res, result);
  }),
);

router.get(
  "/reports/:id",
  asyncRoute(async (req, res) => {
    const result = await assistantLookup.getReportDetail(req.params.id);

    sendLookupResult(res, result);
  }),
);

router.post(
  "/search-files",
  asyncRoute(async (req, res) => {
    const result = await assistantLookup.searchFiles(req.body || {});

    sendLookupResult(res, result);
  }),
);

router.post(
  "/read-file",
  asyncRoute(async (req, res) => {
    const result = await assistantLookup.readFilePreview(req.body || {});

    sendLookupResult(res, result);
  }),
);

router.post(
  "/logs/query",
  asyncRoute(async (req, res) => {
    const result = await assistantLookup.queryLogs(req.body || {});

    sendLookupResult(res, result);
  }),
);

module.exports = router;
