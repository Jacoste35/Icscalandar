'use strict';

/**
 * Routeur ERP — branché sur l'application existante via mount(app, deps).
 * Toutes les routes sont protégées par les middlewares d'auth de l'app
 * (authRequired + adminRequired) passés en paramètre : aucune logique de
 * sécurité dupliquée.
 *
 * Intégration (dans server.js, AVANT le fallback SPA app.get('*')) :
 *   require('./routes/erp').mount(app, { express, authRequired, adminRequired, getData, save });
 */

const erp = require('../lib/erp');
const rules = require('../lib/erp/rules');
const pnl = require('../lib/erp/pnl');
const invoicing = require('../lib/erp/invoicing');
const templates = require('../lib/erp/templates');
const audit = require('../lib/erp/audit');

function mount(app, deps) {
  const { express, authRequired, adminRequired, getData, save } = deps;
  const r = express.Router();
  const guard = [authRequired, adminRequired];

  const withData = (fn) => async (req, res) => {
    try {
      const data = getData();
      erp.ensureErp(data);
      await fn(req, res, data);
    } catch (e) {
      console.error('ERP route:', e);
      res.status(500).json({ error: e.message });
    }
  };
  const actor = (req) => ({ userId: req.user.id, userName: `${req.user.firstName} ${req.user.lastName}` });

  /* ---- Tableau de bord direction -------------------------------------- */
  r.get('/dashboard', guard, withData(async (req, res, data) => {
    const ym = req.query.ym || new Date().toISOString().slice(0, 7);
    res.json({
      ym,
      pnl: pnl.computePnL(data, ym),
      pnlGlobal: pnl.computePnL(data, null),
      treasury: pnl.computeTreasury(data),
      alerts: rules.computeAlerts(data),
      counts: {
        invoices: data.erp.invoices.length,
        unpaid: data.erp.invoices.filter((i) => i.status === 'sent').length,
        compliance: data.compliance.length,
      },
    });
  }));

  r.get('/alerts', guard, withData(async (req, res, data) => {
    res.json({ alerts: rules.computeAlerts(data) });
  }));

  /* ---- Conformité (documents à échéance) ------------------------------ */
  r.get('/compliance', guard, withData(async (req, res, data) => {
    res.json({ items: data.compliance, vehicles: data.vehicles, users: (data.users || []).map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}` })) });
  }));
  r.post('/compliance', guard, withData(async (req, res, data) => {
    const { scope, refId, type, label, expiry, note } = req.body || {};
    if (!label || !expiry) return res.status(400).json({ error: 'label et expiry requis' });
    const item = { id: erp.eid('cmp'), scope: scope || 'company', refId: refId || null, type: type || '', label, expiry, note: note || '' };
    data.compliance.push(item);
    audit.logAction(data, { ...actor(req), action: 'compliance.add', entity: label, detail: expiry });
    await save();
    res.json({ item });
  }));
  r.delete('/compliance/:id', guard, withData(async (req, res, data) => {
    data.compliance = data.compliance.filter((c) => c.id !== req.params.id);
    audit.logAction(data, { ...actor(req), action: 'compliance.delete', entity: req.params.id });
    await save();
    res.json({ ok: true });
  }));

  /* ---- Facturation ----------------------------------------------------- */
  r.get('/invoices', guard, withData(async (req, res, data) => {
    res.json({ invoices: data.erp.invoices.slice().reverse(), contracts: data.contracts || [] });
  }));
  r.post('/invoices', guard, withData(async (req, res, data) => {
    const { client, clientAddress, period, lines, vatRate, dueDays } = req.body || {};
    if (!client || !Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'client et lignes requis' });
    const inv = invoicing.buildInvoice(data, { client, clientAddress, period, lines, vatRate, dueDays });
    data.erp.invoices.push(inv);
    audit.logAction(data, { ...actor(req), action: 'invoice.create', entity: inv.number, detail: `${inv.totalTTC} € TTC` });
    await save();
    res.json({ invoice: inv });
  }));
  r.post('/invoices/:id/status', guard, withData(async (req, res, data) => {
    const inv = data.erp.invoices.find((i) => i.id === req.params.id);
    if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
    const { status } = req.body || {};
    if (!['draft', 'sent', 'paid'].includes(status)) return res.status(400).json({ error: 'statut invalide' });
    inv.status = status;
    if (status === 'paid') inv.paidAt = new Date().toISOString();
    audit.logAction(data, { ...actor(req), action: 'invoice.status', entity: inv.number, detail: status });
    await save();
    res.json({ invoice: inv });
  }));
  r.delete('/invoices/:id', guard, withData(async (req, res, data) => {
    const inv = data.erp.invoices.find((i) => i.id === req.params.id);
    data.erp.invoices = data.erp.invoices.filter((i) => i.id !== req.params.id);
    audit.logAction(data, { ...actor(req), action: 'invoice.delete', entity: inv ? inv.number : req.params.id });
    await save();
    res.json({ ok: true });
  }));
  // Facture imprimable (HTML -> PDF via impression navigateur).
  r.get('/invoices/:id/print', guard, withData(async (req, res, data) => {
    const inv = data.erp.invoices.find((i) => i.id === req.params.id);
    if (!inv) return res.status(404).send('Facture introuvable');
    res.type('html').send(invoicing.renderInvoiceHtml(inv, data.settings.company));
  }));

  /* ---- Documents (publipostage) --------------------------------------- */
  r.get('/templates', guard, withData(async (req, res, data) => {
    res.json({ templates: data.settings.erpTemplates });
  }));
  r.put('/templates/:type', guard, withData(async (req, res, data) => {
    const t = data.settings.erpTemplates[req.params.type];
    if (!t) return res.status(404).json({ error: 'modèle inconnu' });
    if (typeof req.body.body === 'string') t.body = req.body.body;
    audit.logAction(data, { ...actor(req), action: 'template.edit', entity: req.params.type });
    await save();
    res.json({ template: t });
  }));
  // Génère un brouillon de document rempli (pas encore enregistré).
  r.post('/documents/render', guard, withData(async (req, res, data) => {
    const { type, vars } = req.body || {};
    const tpl = data.settings.erpTemplates[type];
    if (!tpl) return res.status(404).json({ error: 'modèle inconnu' });
    const fullVars = Object.assign({ company: data.settings.company, date: new Date().toLocaleDateString('fr-FR') }, vars || {});
    const html = templates.render(tpl.body, fullVars);
    res.json({ html, label: tpl.label });
  }));
  // Enregistre un avertissement validé dans l'historique des sanctions existant.
  r.post('/documents/save-sanction', guard, withData(async (req, res, data) => {
    const { userId, type, motif } = req.body || {};
    const u = (data.users || []).find((x) => x.id === userId);
    const sanction = {
      id: erp.eid('san'),
      userId,
      userName: u ? `${u.firstName} ${u.lastName}` : '',
      type: type || 'Avertissement',
      date: new Date().toISOString().slice(0, 10),
      motif: motif || '',
      createdBy: req.user.id,
      createdByName: `${req.user.firstName} ${req.user.lastName}`,
      createdAt: new Date().toISOString(),
    };
    if (!Array.isArray(data.sanctions)) data.sanctions = [];
    data.sanctions.push(sanction);
    audit.logAction(data, { ...actor(req), action: 'sanction.create', entity: sanction.userName, detail: sanction.type });
    await save();
    res.json({ sanction });
  }));

  /* ---- Journal d'audit & société -------------------------------------- */
  r.get('/audit', guard, withData(async (req, res, data) => {
    res.json({ log: data.erp.auditLog.slice(-200).reverse() });
  }));
  r.get('/company', guard, withData(async (req, res, data) => {
    res.json({ company: data.settings.company });
  }));
  r.put('/company', guard, withData(async (req, res, data) => {
    Object.assign(data.settings.company, req.body || {});
    audit.logAction(data, { ...actor(req), action: 'company.update' });
    await save();
    res.json({ company: data.settings.company });
  }));

  app.use('/api/admin/erp', r);
  console.log('ERP : routeur monté sur /api/admin/erp');
}

module.exports = { mount };
