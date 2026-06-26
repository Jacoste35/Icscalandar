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
const docsign = require('../lib/erp/docsign');

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
    const { client, clientAddress, period, lines, vatRate, dueDays, mentions } = req.body || {};
    if (!client || !Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'client et lignes requis' });
    const inv = invoicing.buildInvoice(data, { client, clientAddress, period, lines, vatRate, dueDays, mentions });
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
    if (typeof req.body.label === 'string' && req.body.label.trim()) t.label = req.body.label.slice(0, 80);
    if (typeof req.body.category === 'string' && req.body.category.trim()) t.category = req.body.category.slice(0, 40);
    audit.logAction(data, { ...actor(req), action: 'template.edit', entity: req.params.type });
    await save();
    res.json({ template: t });
  }));
  // Crée un nouveau modèle de lettre (envoyé par l'admin pour enrichir la base).
  r.post('/templates', guard, withData(async (req, res, data) => {
    const { label, category, body } = req.body || {};
    if (!label || !body) return res.status(400).json({ error: 'Titre et contenu requis' });
    const base = 'custom_' + String(label).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'custom';
    let key = base, i = 2;
    while (data.settings.erpTemplates[key]) key = base + '_' + (i++);
    data.settings.erpTemplates[key] = { label: String(label).slice(0, 80), category: String(category || 'Personnalisés').slice(0, 40), body: String(body), custom: true };
    audit.logAction(data, { ...actor(req), action: 'template.create', entity: key });
    await save();
    res.json({ key, template: data.settings.erpTemplates[key] });
  }));
  // Supprime un modèle personnalisé (les modèles par défaut sont protégés).
  r.delete('/templates/:type', guard, withData(async (req, res, data) => {
    const t = data.settings.erpTemplates[req.params.type];
    if (!t) return res.status(404).json({ error: 'modèle inconnu' });
    if (!t.custom) return res.status(400).json({ error: 'Modèle par défaut : non supprimable' });
    delete data.settings.erpTemplates[req.params.type];
    audit.logAction(data, { ...actor(req), action: 'template.delete', entity: req.params.type });
    await save();
    res.json({ ok: true });
  }));
  // Options de génération : motifs RH + « faits » types (listes éditables).
  r.get('/doc-options', guard, withData(async (req, res, data) => {
    res.json({ motifs: data.settings.docMotifs || [], faits: data.settings.docFaits || [] });
  }));
  r.post('/doc-options/motif', guard, withData(async (req, res, data) => {
    const m = String((req.body || {}).motif || '').trim();
    if (!m) return res.status(400).json({ error: 'Motif vide' });
    data.settings.docMotifs = data.settings.docMotifs || [];
    if (!data.settings.docMotifs.includes(m)) data.settings.docMotifs.push(m);
    await save();
    res.json({ motifs: data.settings.docMotifs });
  }));
  r.delete('/doc-options/motif', guard, withData(async (req, res, data) => {
    const v = String(req.query.value || '');
    data.settings.docMotifs = (data.settings.docMotifs || []).filter((x) => x !== v);
    await save();
    res.json({ motifs: data.settings.docMotifs });
  }));
  r.post('/doc-options/fait', guard, withData(async (req, res, data) => {
    const { label, text } = req.body || {};
    if (!label || !text) return res.status(400).json({ error: 'Libellé et texte requis' });
    data.settings.docFaits = data.settings.docFaits || [];
    data.settings.docFaits.push({ label: String(label).slice(0, 80), text: String(text).slice(0, 2000) });
    await save();
    res.json({ faits: data.settings.docFaits });
  }));
  r.delete('/doc-options/fait', guard, withData(async (req, res, data) => {
    const v = String(req.query.value || '');
    data.settings.docFaits = (data.settings.docFaits || []).filter((f) => f.label !== v);
    await save();
    res.json({ faits: data.settings.docFaits });
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
    const groupsById = Object.fromEntries((data.groups || []).map((g) => [g.id, g]));
    res.json({
      users: (data.users || []).map((u) => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, name: `${u.firstName} ${u.lastName}`, hireDate: u.hireDate || '', address: u.address || '', birthDate: u.birthDate || '', groupId: u.groupId || null, groupName: (groupsById[u.groupId] || {}).name || 'Sans groupe' })),
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

  // Document imprimable (publipostage -> page HTML complète -> PDF navigateur).
  r.post('/documents/print', guard, withData(async (req, res, data) => {
    const { type, vars, title, html: rawHtml } = req.body || {};
    let inner = rawHtml;
    if (!inner) {
      const tpl = data.settings.erpTemplates[type];
      if (!tpl) return res.status(404).send('Modèle inconnu');
      inner = templates.render(tpl.body, Object.assign({ company: data.settings.company, date: new Date().toLocaleDateString('fr-FR') }, vars || {}));
    }
    res.type('html').send(printableDoc(title || (data.settings.erpTemplates[type] && data.settings.erpTemplates[type].label) || 'Document', inner));
  }));

  // Justificatif de frais / IK imprimable.
  r.get('/expenses/:id/print', guard, withData(async (req, res, data) => {
    const exp = data.erp.expenses.find((x) => x.id === req.params.id);
    if (!exp) return res.status(404).send('Note de frais introuvable');
    const u = (data.users || []).find((x) => x.id === exp.userId);
    res.type('html').send(invoicing.renderExpenseHtml(exp, u, data.settings.company, data.settings.ikScale));
  }));

  /* ---- Documents adressés aux salariés + accusé de réception ---------- */
  // Admin : valide et adresse un document à un salarié.
  r.post('/documents/issue', guard, withData(async (req, res, data) => {
    const { userId, type, vars, html: rawHtml, label } = req.body || {};
    const u = (data.users || []).find((x) => x.id === userId);
    if (!u) return res.status(404).json({ error: 'Salarié introuvable' });
    const tpl = data.settings.erpTemplates[type];
    const inner = rawHtml || (tpl ? templates.render(tpl.body, Object.assign({ company: data.settings.company, date: new Date().toLocaleDateString('fr-FR') }, vars || {})) : '');
    const doc = {
      id: erp.eid('doc'), userId, userName: `${u.firstName} ${u.lastName}`,
      type: type || 'document', label: label || (tpl && tpl.label) || 'Document', html: inner,
      createdAt: new Date().toISOString(), createdBy: req.user.id, createdByName: `${req.user.firstName} ${req.user.lastName}`,
      status: 'sent', viewedAt: null, ackedAt: null, ackBy: null, ackName: null, ackRef: null,
    };
    data.erp.documents.push(doc);
    audit.logAction(data, { ...actor(req), action: 'document.issue', entity: doc.label, detail: doc.userName });
    await save();
    res.json({ document: { id: doc.id, label: doc.label, userName: doc.userName, status: doc.status } });
  }));
  // Admin : suivi de tous les documents adressés (lu/reçu).
  r.get('/documents', guard, withData(async (req, res, data) => {
    res.json({ documents: data.erp.documents.slice().reverse().map((d) => ({ id: d.id, userId: d.userId, userName: d.userName, label: d.label, type: d.type, createdAt: d.createdAt, status: d.status, viewedAt: d.viewedAt || null, ackedAt: d.ackedAt, ackName: d.ackName })) });
  }));
  // Salarié : ses propres documents (authRequired seul).
  r.get('/my-documents', authRequired, withData(async (req, res, data) => {
    const mine = data.erp.documents.filter((d) => d.userId === req.user.id).slice().reverse()
      .map((d) => ({ id: d.id, label: d.label, type: d.type, createdAt: d.createdAt, status: d.status, viewedAt: d.viewedAt || null, ackedAt: d.ackedAt }));
    res.json({ documents: mine });
  }));
  // Admin : annule / supprime l'envoi d'un document (et la signature associée).
  r.delete('/documents/:id', guard, withData(async (req, res, data) => {
    const doc = data.erp.documents.find((d) => d.id === req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document introuvable' });
    data.erp.documents = data.erp.documents.filter((d) => d.id !== req.params.id);
    if (doc.ackRef) data.erp.acknowledgements = data.erp.acknowledgements.filter((a) => a.id !== doc.ackRef);
    audit.logAction(data, { ...actor(req), action: 'document.cancel', entity: doc.label, detail: doc.userName });
    await save();
    res.json({ ok: true });
  }));
  // Marque un document comme « ouvert/lu » par son destinataire (sans le signer).
  r.post('/documents/:id/seen', authRequired, withData(async (req, res, data) => {
    const doc = data.erp.documents.find((d) => d.id === req.params.id);
    if (!doc || doc.userId !== req.user.id) return res.status(404).json({ error: 'Document introuvable' });
    if (!doc.viewedAt) { doc.viewedAt = new Date().toISOString(); if (doc.status === 'sent') doc.status = 'read'; await save(); }
    res.json({ ok: true, viewedAt: doc.viewedAt });
  }));
  // Document imprimable (le salarié destinataire ou l'admin).
  r.get('/documents/:id/view', authRequired, withData(async (req, res, data) => {
    const doc = data.erp.documents.find((d) => d.id === req.params.id);
    if (!doc) return res.status(404).send('Document introuvable');
    if (req.user.role !== 'admin' && doc.userId !== req.user.id) return res.status(403).send('Accès refusé');
    // Le destinataire qui ouvre son document : on horodate la première lecture.
    if (doc.userId === req.user.id && req.user.role !== 'admin' && !doc.viewedAt) {
      doc.viewedAt = new Date().toISOString(); if (doc.status === 'sent') doc.status = 'read'; await save();
    }
    res.type('html').send(printableDoc(doc.label, doc.html));
  }));
  // Salarié : accuse réception / signe électroniquement sa lecture.
  r.post('/documents/:id/ack', authRequired, withData(async (req, res, data) => {
    const doc = data.erp.documents.find((d) => d.id === req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document introuvable' });
    if (doc.userId !== req.user.id) return res.status(403).json({ error: 'Document non destiné à ce compte' });
    if (doc.status !== 'acked') {
      doc.status = 'acked'; doc.ackedAt = new Date().toISOString();
      doc.ackBy = req.user.id; doc.ackName = `${req.user.firstName} ${req.user.lastName}`; doc.ackRef = erp.eid('sig');
      data.erp.acknowledgements.push({ id: doc.ackRef, type: 'document', refId: doc.id, userId: req.user.id, name: doc.ackName, at: doc.ackedAt });
      audit.logAction(data, { userId: req.user.id, userName: doc.ackName, action: 'document.ack', entity: doc.label, detail: doc.ackedAt });
      await save();
    }
    res.json({ ok: true, ackedAt: doc.ackedAt, stamp: docsign.frenchStamp(doc.ackedAt) });
  }));
  // Attestation de prise de connaissance (admin ou destinataire).
  r.get('/documents/:id/attestation', authRequired, withData(async (req, res, data) => {
    const doc = data.erp.documents.find((d) => d.id === req.params.id);
    if (!doc) return res.status(404).send('Document introuvable');
    if (req.user.role !== 'admin' && doc.userId !== req.user.id) return res.status(403).send('Accès refusé');
    if (doc.status !== 'acked') return res.status(400).send('Le document n\'a pas encore été signé.');
    res.type('html').send(docsign.renderAttestationHtml(doc, data.settings.company));
  }));

  /* ---- MODULE Facturation : profils par donneur d'ordre --------------- */
  r.get('/billing-profiles', guard, withData(async (req, res, data) => {
    res.json({ profiles: data.settings.billingProfiles, company: data.settings.company });
  }));
  r.put('/billing-profiles/:key', guard, withData(async (req, res, data) => {
    const p = data.settings.billingProfiles[req.params.key];
    if (!p) return res.status(404).json({ error: 'Profil inconnu' });
    const b = req.body || {};
    if (b.clientAddress != null) p.clientAddress = String(b.clientAddress).slice(0, 200);
    if (Array.isArray(b.mentions)) p.mentions = b.mentions.map((m) => String(m).slice(0, 160));
    if (Array.isArray(b.lignes)) p.lignes = b.lignes.map((l) => ({ designation: String(l.designation || '').slice(0, 160), prixUnitaire: Number(l.prixUnitaire) || 0, unit: String(l.unit || '').slice(0, 30) }));
    audit.logAction(data, { ...actor(req), action: 'billing.profile', entity: req.params.key });
    await save();
    res.json({ profile: p });
  }));

  // Réinitialise un profil transporteur sur le modèle de référence (factures réelles).
  r.post('/billing-profiles/:key/reset', guard, withData(async (req, res, data) => {
    const defs = require('../lib/erp/billing').DEFAULT_PROFILES;
    const def = defs[req.params.key];
    if (!def) return res.status(404).json({ error: 'Profil inconnu' });
    data.settings.billingProfiles[req.params.key] = JSON.parse(JSON.stringify(def));
    audit.logAction(data, { ...actor(req), action: 'billing.profile.reset', entity: req.params.key });
    await save();
    res.json({ profile: data.settings.billingProfiles[req.params.key] });
  }));

  app.use('/api/admin/erp', r);
  console.log('ERP : routeur monté sur /api/admin/erp');
}

// Enrobe un fragment de publipostage dans une page A4 imprimable (en-tête société).
function printableDoc(title, inner) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { margin: 20mm; }
  body { font: 13px/1.6 'Times New Roman', Georgia, serif; color:#111; max-width:780px; margin:0 auto; padding:10px; }
  .lh { border-bottom:2px solid #111; padding-bottom:8px; margin-bottom:18px; }
  .lh-co { font-weight:700; font-size:16px; }
  .lh-ad { color:#444; font-size:12px; }
  h2 { text-align:center; font-size:17px; }
  p { margin:9px 0; text-align:justify; }
  .addr { margin-left:55%; }
  .meta { color:#333; font-size:12px; }
  .sign { margin-top:34px; }
  table { border-collapse:collapse; }
  @media print { .noprint { display:none; } }
</style></head><body>
${inner}
<p class="noprint" style="margin-top:26px;text-align:center"><button onclick="window.print()" style="padding:8px 16px;font-size:14px;cursor:pointer">Imprimer / Enregistrer en PDF</button></p>
</body></html>`;
}

module.exports = { mount };
