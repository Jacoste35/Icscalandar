'use strict';

/**
 * Journal d'audit ERP — trace qui a fait quoi et quand. Indispensable dès qu'il
 * y a de la facturation, de la paie ou du disciplinaire (couverture prud'homale,
 * contrôle URSSAF/expert-comptable).
 */
function logAction(data, { userId, userName, action, entity, detail }) {
  if (!data.erp) return;
  data.erp.auditLog.push({
    at: new Date().toISOString(),
    userId: userId || null,
    userName: userName || null,
    action,                 // ex. 'invoice.create', 'document.generate', 'compliance.add'
    entity: entity || null, // ex. 'invoice ICS-2026-0007'
    detail: detail || null,
  });
  // Borne la taille pour ne pas gonfler la base indéfiniment.
  if (data.erp.auditLog.length > 5000) data.erp.auditLog.splice(0, data.erp.auditLog.length - 5000);
}

module.exports = { logAction };
