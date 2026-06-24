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
const tours = require('../lib/erp/tours');
const cashflow = require('../lib/erp/cashflow');
const closing = require('../lib/erp/closing');
const ik = require('../lib/erp/ik');

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

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

  /* ---- Méta (formulaires : salariés détaillés, véhicules, contrats) --- */
  r.get('/meta', guard, withData(async (req, res, data) => {
    res.json({
      users: (data.users || []).map((u) => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, name: `${u.firstName} ${u.lastName}`, hireDate: u.hireDate || '', address: u.address || '', birthDate: u.birthDate || '' })),
      vehicles: (data.vehicles || []).map((v) => ({ id: v.id, name: v.name, plate: v.plate })),
      contracts: (data.contracts || []).map((c) => ({ id: c.id, client: c.client || c.name || '', pricePerPoint: c.pricePerPoint })),
      tenderParams: data.settings.tenderParams || {},
    });
  }));

  /* ---- MODULE 1 : retours de tournée ---------------------------------- */
  // POST accessible au chauffeur pour SON retour (userId forcé si non-admin).
  r.post('/tours', authRequired, withData(async (req, res, data) => {
    const b = req.body || {};
    const isAdmin = req.user.role === 'admin';
    const userId = isAdmin && b.userId ? b.userId : req.user.id;
    const u = (data.users || []).find((x) => x.id === userId);
    const num = (x) => Math.round((Number(x) || 0) * 100) / 100;
    const tour = {
      id: erp.eid('tour'), date: b.date || new Date().toISOString().slice(0, 10),
      userId, userName: u ? `${u.firstName} ${u.lastName}` : (b.userName || ''),
      vehicleId: b.vehicleId || null, contractId: b.contractId || null,
      kmStart: num(b.kmStart), kmEnd: num(b.kmEnd),
      pointsPlanned: Math.round(Number(b.pointsPlanned) || 0), pointsDelivered: Math.round(Number(b.pointsDelivered) || 0), pointsFailed: Math.round(Number(b.pointsFailed) || 0),
      failReason: String(b.failReason || '').slice(0, 200), pickups: Math.round(Number(b.pickups) || 0),
      fuelLiters: num(b.fuelLiters), incident: String(b.incident || '').slice(0, 300), createdAt: new Date().toISOString(),
    };
    data.tours.push(tour);
    audit.logAction(data, { ...actor(req), action: 'tour.create', entity: tour.date, detail: `${tour.pointsDelivered} pts` });
    await save();
    res.json({ tour, calc: tours.computeTour(data, tour) });
  }));
  r.get('/tours', guard, withData(async (req, res, data) => {
    const { from, to, userId } = req.query;
    let list = data.tours.slice();
    if (from) list = list.filter((t) => t.date >= from);
    if (to) list = list.filter((t) => t.date <= to);
    if (userId) list = list.filter((t) => t.userId === userId);
    list.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    res.json({ tours: list });
  }));
  r.get('/tours/analytics', guard, withData(async (req, res, data) => {
    res.json(tours.analytics(data, { ym: req.query.ym, from: req.query.from, to: req.query.to }));
  }));
  r.delete('/tours/:id', guard, withData(async (req, res, data) => {
    data.tours = data.tours.filter((t) => t.id !== req.params.id);
    audit.logAction(data, { ...actor(req), action: 'tour.delete', entity: req.params.id });
    await save();
    res.json({ ok: true });
  }));

  /* ---- MODULE 3 : pack fin de contrat --------------------------------- */
  r.post('/documents/pack-depart', guard, withData(async (req, res, data) => {
    const { userId, lastDay, motif } = req.body || {};
    const u = (data.users || []).find((x) => x.id === userId);
    if (!u) return res.status(404).json({ error: 'Salarié introuvable' });
    const vars = {
      company: data.settings.company, date: new Date().toLocaleDateString('fr-FR'),
      salarie: { civilite: u.civilite || 'Monsieur', fullName: `${u.firstName} ${u.lastName}`, lastName: (u.lastName || '').toUpperCase(), address: u.address || '', hireDate: u.hireDate || '', poste: u.poste || 'conducteur VL', coefficient: u.coefficient || '110M' },
      contrat: { lastDay: lastDay || '', motif: motif || '', detail: '' },
    };
    const docs = ['certificat_travail', 'solde_tout_compte', 'attestation_france_travail'].map((type) => ({
      type, label: data.settings.erpTemplates[type].label, html: templates.render(data.settings.erpTemplates[type].body, vars),
    }));
    audit.logAction(data, { ...actor(req), action: 'depart.pack', entity: vars.salarie.fullName, detail: motif || '' });
    res.json({ docs });
  }));

  /* ---- MODULE 4 : avoir + devis --------------------------------------- */
  r.post('/invoices/avoir', guard, withData(async (req, res, data) => {
    const { client, clientAddress, period, lines, vatRate } = req.body || {};
    if (!client || !Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'client et lignes requis' });
    const inv = invoicing.buildInvoice(data, { client, clientAddress, period, lines, vatRate, kind: 'avoir' });
    data.erp.invoices.push(inv);
    audit.logAction(data, { ...actor(req), action: 'avoir.create', entity: inv.number, detail: `${inv.totalTTC} € TTC` });
    await save();
    res.json({ invoice: inv });
  }));
  r.post('/documents/devis', guard, withData(async (req, res, data) => {
    const { client, clientAddress, lines, vatRate, intro } = req.body || {};
    const r2 = (n) => Math.round((n || 0) * 100) / 100;
    const ls = (lines || []).map((l) => ({ designation: l.designation || '', quantite: Number(l.quantite) || 0, prixUnitaire: Number(l.prixUnitaire) || 0, montantHT: r2((Number(l.quantite) || 0) * (Number(l.prixUnitaire) || 0)) }));
    const totalHT = r2(ls.reduce((s, l) => s + l.montantHT, 0));
    const vr = vatRate != null ? Number(vatRate) : 20;
    const tva = r2(totalHT * vr / 100);
    const linesHtml = ls.map((l) => `<tr><td>${esc(l.designation)}</td><td style="text-align:right">${l.quantite}</td><td style="text-align:right">${l.prixUnitaire.toFixed(2)}</td><td style="text-align:right">${l.montantHT.toFixed(2)}</td></tr>`).join('');
    const html = templates.render(data.settings.erpTemplates.devis.body, {
      company: data.settings.company, date: new Date().toLocaleDateString('fr-FR'),
      client: { name: client || '', address: clientAddress || '' },
      devis: { number: `DV-${new Date().getFullYear()}-${String((data.tours || []).length + (data.erp.invoices || []).length + 1).padStart(4, '0')}`, intro: intro || 'Nous avons le plaisir de vous adresser notre proposition tarifaire :', linesHtml, totalHT: totalHT.toFixed(2), vatRate: vr, tva: tva.toFixed(2), totalTTC: r2(totalHT + tva).toFixed(2) },
    });
    res.json({ html });
  }));

  /* ---- MODULE 5 : trésorerie prévisionnelle --------------------------- */
  r.get('/cashflow', guard, withData(async (req, res, data) => {
    res.json(cashflow.forecast(data, Number(req.query.weeks) || 8));
  }));
  r.get('/recurring', guard, withData(async (req, res, data) => { res.json({ recurring: data.erp.recurring }); }));
  r.post('/recurring', guard, withData(async (req, res, data) => {
    const { label, amount, dayOfMonth } = req.body || {};
    if (!label) return res.status(400).json({ error: 'label requis' });
    const item = { id: erp.eid('rec'), label: String(label).slice(0, 80), amount: Math.round((Number(amount) || 0) * 100) / 100, dayOfMonth: Math.min(28, Math.max(1, Number(dayOfMonth) || 1)) };
    data.erp.recurring.push(item);
    await save();
    res.json({ item });
  }));
  r.delete('/recurring/:id', guard, withData(async (req, res, data) => {
    data.erp.recurring = data.erp.recurring.filter((x) => x.id !== req.params.id);
    await save();
    res.json({ ok: true });
  }));

  /* ---- MODULE 6 : clôture mensuelle ----------------------------------- */
  r.post('/closing/:ym', guard, withData(async (req, res, data) => {
    const ym = req.params.ym;
    if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ error: 'Mois invalide (YYYY-MM)' });
    const preview = req.query.preview === '1' || req.query.preview === 'true';
    const result = closing.runMonthlyClosing(data, ym, { preview });
    if (!preview) { audit.logAction(data, { ...actor(req), action: 'closing.run', entity: ym, detail: `${result.draftInvoices.length} factures` }); await save(); }
    res.json(result);
  }));

  /* ---- MODULE 7 : notes de frais / IK --------------------------------- */
  r.get('/expenses', guard, withData(async (req, res, data) => { res.json({ expenses: data.erp.expenses, ikScale: data.settings.ikScale }); }));
  r.post('/expenses', guard, withData(async (req, res, data) => {
    const b = req.body || {};
    const isIK = b.type === 'ik' || (Number(b.km) > 0);
    const amount = isIK ? ik.computeIK(data.settings.ikScale, b.cv, b.km) : Math.round((Number(b.amount) || 0) * 100) / 100;
    const item = { id: erp.eid('exp'), userId: b.userId || null, date: b.date || new Date().toISOString().slice(0, 10), type: b.type || 'frais', amount, km: Math.round(Number(b.km) || 0), cv: Number(b.cv) || 0, note: String(b.note || '').slice(0, 200), status: 'pending' };
    data.erp.expenses.push(item);
    audit.logAction(data, { ...actor(req), action: 'expense.create', entity: item.type, detail: `${amount} €` });
    await save();
    res.json({ item });
  }));
  r.post('/expenses/:id/status', guard, withData(async (req, res, data) => {
    const it = data.erp.expenses.find((x) => x.id === req.params.id);
    if (!it) return res.status(404).json({ error: 'Note introuvable' });
    it.status = ['pending', 'approved', 'rejected'].includes(req.body.status) ? req.body.status : it.status;
    await save();
    res.json({ item: it });
  }));
  r.delete('/expenses/:id', guard, withData(async (req, res, data) => {
    data.erp.expenses = data.erp.expenses.filter((x) => x.id !== req.params.id);
    await save();
    res.json({ ok: true });
  }));
  r.put('/ik-scale', guard, withData(async (req, res, data) => {
    if (req.body && Array.isArray(req.body.brackets)) data.settings.ikScale.brackets = req.body.brackets;
    if (req.body && typeof req.body.note === 'string') data.settings.ikScale.note = req.body.note;
    await save();
    res.json({ ikScale: data.settings.ikScale });
  }));

  /* ---- MODULE 8 : coffre-fort salarié --------------------------------- */
  r.get('/staff-docs', guard, withData(async (req, res, data) => {
    const userId = req.query.userId;
    let list = data.erp.staffDocs.slice();
    if (userId) list = list.filter((d) => d.userId === userId);
    res.json({ docs: list, users: (data.users || []).map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}` })) });
  }));
  r.post('/staff-docs', guard, withData(async (req, res, data) => {
    const b = req.body || {};
    if (!b.userId || !b.label) return res.status(400).json({ error: 'userId et label requis' });
    const doc = { id: erp.eid('sdoc'), userId: b.userId, type: b.type || 'document', label: String(b.label).slice(0, 100), fileName: String(b.fileName || '').slice(0, 160), uploadedAt: new Date().toISOString(), expiry: b.expiry || '' };
    data.erp.staffDocs.push(doc);
    // Échéance -> alimente data.compliance pour réutiliser les alertes existantes.
    if (doc.expiry) {
      data.compliance.push({ id: erp.eid('cmp'), scope: 'user', refId: doc.userId, type: doc.type, label: doc.label, expiry: doc.expiry, note: 'Coffre-fort salarié' });
    }
    audit.logAction(data, { ...actor(req), action: 'staffdoc.add', entity: doc.label });
    await save();
    res.json({ doc });
  }));
  r.delete('/staff-docs/:id', guard, withData(async (req, res, data) => {
    data.erp.staffDocs = data.erp.staffDocs.filter((d) => d.id !== req.params.id);
    await save();
    res.json({ ok: true });
  }));

  /* ---- MODULE 9 : réappro pièces -------------------------------------- */
  r.get('/restock', guard, withData(async (req, res, data) => {
    const low = (data.parts || []).filter((p) => (Number(p.seuilMini) || 0) > 0 && (Number(p.qty) || 0) <= Number(p.seuilMini))
      .map((p) => ({ id: p.id, name: p.name, ref: p.ref, qty: p.qty || 0, seuilMini: p.seuilMini, unit: p.unit || '', fournisseur: p.fournisseur || p.supplier || '', unitPrice: p.unitPrice || 0 }));
    res.json({ items: low });
  }));
  r.post('/restock/order', guard, withData(async (req, res, data) => {
    const { fournisseur, parts } = req.body || {};
    const r2 = (n) => Math.round((n || 0) * 100) / 100;
    const ls = (parts || []).map((p) => ({ ref: p.ref || '', designation: p.name || '', qte: Number(p.qte) || 0, pu: Number(p.unitPrice) || 0 }));
    const totalHT = r2(ls.reduce((s, l) => s + l.qte * l.pu, 0));
    const linesHtml = ls.map((l) => `<tr><td>${esc(l.ref)}</td><td>${esc(l.designation)}</td><td style="text-align:right">${l.qte}</td><td style="text-align:right">${l.pu.toFixed(2)}</td></tr>`).join('');
    const html = templates.render(data.settings.erpTemplates.bon_commande_fournisseur.body, {
      company: data.settings.company, date: new Date().toLocaleDateString('fr-FR'),
      bc: { number: `BC-${new Date().getFullYear()}-${String((data.erp.purchases || []).length + 1).padStart(4, '0')}`, fournisseur: fournisseur || 'Fournisseur', fournisseurAddress: '', linesHtml, totalHT: totalHT.toFixed(2), delai: req.body.delai || 'sous 7 jours' },
    });
    audit.logAction(data, { ...actor(req), action: 'restock.order', entity: fournisseur || '', detail: `${ls.length} réf.` });
    res.json({ html });
  }));

  /* ---- MODULE 10 : accusés de réception ------------------------------- */
  // Côté salarié (authRequired seul) : j'accuse réception.
  r.post('/ack/:type/:id', authRequired, withData(async (req, res, data) => {
    const entry = { id: erp.eid('ack'), type: req.params.type, refId: req.params.id, userId: req.user.id, name: `${req.user.firstName} ${req.user.lastName}`, at: new Date().toISOString() };
    const dup = data.erp.acknowledgements.find((a) => a.type === entry.type && a.refId === entry.refId && a.userId === entry.userId);
    if (!dup) { data.erp.acknowledgements.push(entry); await save(); }
    res.json({ ok: true, ack: dup || entry });
  }));
  r.get('/acks', guard, withData(async (req, res, data) => {
    let list = data.erp.acknowledgements.slice();
    if (req.query.type) list = list.filter((a) => a.type === req.query.type);
    if (req.query.id) list = list.filter((a) => a.refId === req.query.id);
    res.json({ acks: list.sort((a, b) => b.at.localeCompare(a.at)) });
  }));

  app.use('/api/admin/erp', r);
  console.log('ERP : routeur monté sur /api/admin/erp');
}

module.exports = { mount };
