const { randomUUID } = require("crypto");
const { query } = require("../db");

function mapIncident(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    severity: row.severity,
    summary: row.summary,
    serviceName: row.service_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapServiceFact(row) {
  return {
    id: row.id,
    serviceName: row.service_name,
    factType: row.fact_type,
    factKey: row.fact_key,
    factValue: row.fact_value,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAudit(row) {
  const input = row.input && typeof row.input === "object" ? row.input : {};

  return {
    id: row.id,
    actionType: row.action_type,
    target: row.target,
    status: row.status,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    input,
    actionReview: input.actionReview || null,
    result: row.result,
    createdAt: row.created_at,
  };
}

async function listIncidents() {
  const result = await query(
    `SELECT id, title, status, severity, summary, service_name, created_at, updated_at
     FROM incidents
     ORDER BY created_at DESC
     LIMIT 100`,
  );
  return result.rows.map(mapIncident);
}

async function createIncident(input) {
  const result = await query(
    `INSERT INTO incidents (id, title, status, severity, summary, service_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, title, status, severity, summary, service_name, created_at, updated_at`,
    [
      randomUUID(),
      input.title,
      input.status || "open",
      input.severity || "medium",
      input.summary || "",
      input.serviceName || null,
    ],
  );
  return mapIncident(result.rows[0]);
}

async function listServiceFacts() {
  const result = await query(
    `SELECT id, service_name, fact_type, fact_key, fact_value, source, created_at, updated_at
     FROM service_facts
     ORDER BY service_name ASC, updated_at DESC
     LIMIT 100`,
  );
  return result.rows.map(mapServiceFact);
}

async function upsertServiceFact(input) {
  const result = await query(
    `INSERT INTO service_facts (id, service_name, fact_type, fact_key, fact_value, source)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (service_name, fact_key)
     DO UPDATE SET
       fact_type = EXCLUDED.fact_type,
       fact_value = EXCLUDED.fact_value,
       source = EXCLUDED.source,
       updated_at = NOW()
     RETURNING id, service_name, fact_type, fact_key, fact_value, source, created_at, updated_at`,
    [
      randomUUID(),
      input.serviceName,
      input.factType || "note",
      input.factKey,
      JSON.stringify(input.factValue || {}),
      input.source || "manual",
    ],
  );
  return mapServiceFact(result.rows[0]);
}

async function listAudit() {
  const result = await query(
    `SELECT id, action_type, target, status, requested_by, approved_by, input, result, created_at
     FROM action_audit
     ORDER BY created_at DESC
     LIMIT 100`,
  );
  return result.rows.map(mapAudit);
}

async function getAudit(id) {
  const result = await query(
    `SELECT id, action_type, target, status, requested_by, approved_by, input, result, created_at
     FROM action_audit
     WHERE id = $1`,
    [id],
  );

  return result.rows[0] ? mapAudit(result.rows[0]) : null;
}

async function createAudit(input) {
  const result = await query(
    `INSERT INTO action_audit (id, action_type, target, status, requested_by, approved_by, input, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
     RETURNING id, action_type, target, status, requested_by, approved_by, input, result, created_at`,
    [
      input.id || randomUUID(),
      input.actionType,
      input.target,
      input.status || "pending",
      input.requestedBy || "system",
      input.approvedBy || null,
      JSON.stringify(input.input || {}),
      JSON.stringify(input.result || {}),
    ],
  );
  return mapAudit(result.rows[0]);
}

async function updateAudit(id, input) {
  const hasInput = Object.prototype.hasOwnProperty.call(input, "input");
  const hasResult = Object.prototype.hasOwnProperty.call(input, "result");
  const result = await query(
    `UPDATE action_audit
     SET
       status = COALESCE($2, status),
       approved_by = COALESCE($3, approved_by),
       result = COALESCE($4::jsonb, result),
       input = COALESCE($5::jsonb, input)
     WHERE id = $1
     RETURNING id, action_type, target, status, requested_by, approved_by, input, result, created_at`,
    [
      id,
      input.status || null,
      input.approvedBy || null,
      hasResult ? JSON.stringify(input.result || {}) : null,
      hasInput ? JSON.stringify(input.input || {}) : null,
    ],
  );

  return result.rows[0] ? mapAudit(result.rows[0]) : null;
}

module.exports = {
  listIncidents,
  createIncident,
  listServiceFacts,
  upsertServiceFact,
  listAudit,
  getAudit,
  createAudit,
  updateAudit,
};
