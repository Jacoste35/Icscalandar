'use strict';
/*
 * Panneau ERP — surcouche autonome du panneau administrateur.
 *
 * Volontairement découplé de app.js : il ne dépend QUE du jeton d'auth
 * (localStorage 'ics_token') et de la nouvelle API /api/admin/erp. Il s'affiche
 * uniquement pour les administrateurs, via un bouton flottant qui ouvre un
 * overlay plein écran à onglets. Aucun risque pour l'application existante.
 */
(function () {
  const TOKEN = () => localStorage.getItem('ics_token');
  const E = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
  const euro = (n) => (Math.round((n || 0) * 100) / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

  async function api(method, path, body) {
    const res = await fetch('/api/admin/erp' + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN() },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    return res.json();
  }

  // ---- Vérifie le rôle admin avant d'afficher quoi que ce soit ----------
  async function isAdmin() {
    try {
      const r = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + TOKEN() } });
      if (!r.ok) return false;
      const { user } = await r.json();
      return user && user.role === 'admin';
    } catch (e) { return false; }
  }

  function injectStyles() {
    if (document.getElementById('erp-style')) return;
    const s = E('style'); s.id = 'erp-style';
    s.textContent = `
      #erp-fab{position:fixed;right:18px;bottom:18px;z-index:9998;background:#1e1b4b;color:#fff;border:none;border-radius:999px;padding:12px 18px;font-weight:700;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer}
      #erp-overlay{position:fixed;inset:0;z-index:9999;background:#0f172a;color:#e2e8f0;display:none;flex-direction:column;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
      #erp-overlay.open{display:flex}
      .erp-top{display:flex;align-items:center;gap:14px;padding:12px 18px;background:#1e1b4b;border-bottom:1px solid #312e81}
      .erp-top h2{margin:0;font-size:16px;flex:1}
      .erp-top button{background:#312e81;border:none;color:#fff;border-radius:8px;padding:8px 12px;cursor:pointer}
      .erp-tabs{display:flex;gap:6px;padding:10px 18px;flex-wrap:wrap;background:#111827}
      .erp-tabs button{background:#1f2937;border:1px solid #374151;color:#cbd5e1;border-radius:8px;padding:8px 12px;cursor:pointer}
      .erp-tabs button.active{background:#4f46e5;border-color:#4f46e5;color:#fff}
      .erp-body{flex:1;overflow:auto;padding:18px}
      .erp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
      .erp-card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:14px}
      .erp-card .k{color:#94a3b8;font-size:12px}
      .erp-card .v{font-size:22px;font-weight:700;margin-top:4px}
      .erp-alert{display:flex;gap:10px;align-items:flex-start;background:#1e293b;border-left:4px solid #64748b;border-radius:8px;padding:10px 12px;margin:8px 0}
      .erp-alert.critique{border-color:#ef4444}.erp-alert.urgent{border-color:#f59e0b}.erp-alert.info{border-color:#3b82f6}
      .erp-alert .badge{font-size:10px;text-transform:uppercase;font-weight:700;padding:2px 6px;border-radius:5px;background:#334155}
      table.erp{width:100%;border-collapse:collapse;margin-top:10px}
      table.erp th,table.erp td{padding:8px 10px;border-bottom:1px solid #334155;text-align:left;font-size:13px}
      table.erp th{color:#94a3b8;font-weight:600}
      .erp-btn{background:#4f46e5;border:none;color:#fff;border-radius:8px;padding:8px 12px;cursor:pointer;font-weight:600}
      .erp-btn.ghost{background:#334155}
      .erp-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}
      .erp-row input,.erp-row select,.erp-row textarea{background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:8px;padding:8px}
      .erp-row textarea{width:100%;min-height:90px}
      h3.erp{margin:18px 0 6px;font-size:15px;color:#f1f5f9}
      .pill{font-size:11px;padding:2px 8px;border-radius:999px;background:#334155}
      .pill.draft{background:#475569}.pill.sent{background:#b45309}.pill.paid{background:#15803d}
    `;
    document.head.appendChild(s);
  }

  let root, bodyEl, current = 'dashboard';

  function build() {
    injectStyles();
    const fab = E('button'); fab.id = 'erp-fab'; fab.textContent = '⚙︎ ERP';
    fab.onclick = () => { root.classList.add('open'); load(current); };
    document.body.appendChild(fab);

    root = E('div'); root.id = 'erp-overlay';
    const top = E('div', 'erp-top', '<h2>Pilotage ERP — INTER COLIS SERVICES</h2>');
    const close = E('button'); close.textContent = '✕ Fermer'; close.onclick = () => root.classList.remove('open');
    top.appendChild(close);

    const tabs = E('div', 'erp-tabs');
    [['dashboard', 'Tableau de bord'], ['tours', 'Tournées'], ['invoices', 'Facturation'],
     ['cashflow', 'Trésorerie'], ['closing', 'Clôture'], ['documents', 'Documents'],
     ['rh', 'RH'], ['expenses', 'Frais'], ['stock', 'Réappro'],
     ['compliance', 'Conformité'], ['audit', 'Journal']].forEach(([id, label]) => {
      const b = E('button'); b.textContent = label; b.dataset.tab = id;
      if (id === current) b.classList.add('active');
      b.onclick = () => { current = id; [...tabs.children].forEach((x) => x.classList.toggle('active', x.dataset.tab === id)); load(id); };
      tabs.appendChild(b);
    });

    bodyEl = E('div', 'erp-body', 'Chargement…');
    root.append(top, tabs, bodyEl);
    document.body.appendChild(root);
  }

  async function load(tab) {
    bodyEl.innerHTML = 'Chargement…';
    try {
      if (tab === 'dashboard') return renderDashboard(await api('GET', '/dashboard'));
      if (tab === 'tours') return renderTours(await api('GET', '/meta'), await api('GET', '/tours/analytics?ym=' + ymNow()));
      if (tab === 'invoices') return renderInvoices(await api('GET', '/invoices'));
      if (tab === 'cashflow') return renderCashflow(await api('GET', '/cashflow'), await api('GET', '/recurring'));
      if (tab === 'closing') return renderClosing();
      if (tab === 'documents') return renderDocuments(await api('GET', '/templates'), await api('GET', '/meta'));
      if (tab === 'rh') return renderRh(await api('GET', '/meta'), await api('GET', '/staff-docs'));
      if (tab === 'expenses') return renderExpenses(await api('GET', '/meta'), await api('GET', '/expenses'));
      if (tab === 'stock') return renderStock(await api('GET', '/restock'));
      if (tab === 'compliance') return renderCompliance(await api('GET', '/compliance'));
      if (tab === 'audit') return renderAudit(await api('GET', '/audit'));
    } catch (e) { bodyEl.innerHTML = `<div class="erp-alert critique">Erreur : ${e.message}</div>`; }
  }

  function renderDashboard(d) {
    const p = d.pnl, t = d.treasury;
    bodyEl.innerHTML = '';
    const grid = E('div', 'erp-grid');
    [['CA du mois', euro(p.ca)], ['Charges', euro(p.charges)], ['Résultat', euro(p.result)],
     ['Marge', p.marginPct + ' %'], ['Trésorerie', euro(t.balance)], ['Factures impayées', d.counts.unpaid]]
      .forEach(([k, v]) => { const c = E('div', 'erp-card'); c.append(E('div', 'k', k), E('div', 'v', String(v))); grid.appendChild(c); });
    bodyEl.appendChild(grid);

    bodyEl.appendChild(E('h3', 'erp', `Alertes (${d.alerts.length})`));
    if (!d.alerts.length) bodyEl.appendChild(E('div', null, 'Aucune alerte. Tout est à jour.'));
    d.alerts.forEach((a) => {
      const el = E('div', 'erp-alert ' + a.level);
      el.innerHTML = `<span class="badge">${a.level}</span><div><strong>${a.title}</strong><br><span style="color:#94a3b8">${a.detail}</span></div>`;
      bodyEl.appendChild(el);
    });
  }

  function renderInvoices(d) {
    bodyEl.innerHTML = '';
    bodyEl.appendChild(E('h3', 'erp', 'Nouvelle facture'));
    const contracts = d.contracts || [];
    const form = E('div');
    form.innerHTML = `
      <div class="erp-row">
        <input id="iv-client" placeholder="Client (donneur d'ordre)" list="iv-contracts" style="min-width:200px">
        <datalist id="iv-contracts">${contracts.map((c) => `<option value="${c.client || c.name || ''}">`).join('')}</datalist>
        <input id="iv-period" placeholder="Période (2026-06)" style="width:130px">
        <input id="iv-vat" type="number" value="20" style="width:70px" title="TVA %">
      </div>
      <div id="iv-lines"></div>
      <div class="erp-row"><button class="erp-btn ghost" id="iv-add">+ Ligne</button>
      <button class="erp-btn" id="iv-create">Générer la facture</button></div>`;
    bodyEl.appendChild(form);
    const linesBox = form.querySelector('#iv-lines');
    const addLine = (des = '', q = 1, pu = '') => {
      const row = E('div', 'erp-row');
      row.innerHTML = `<input class="il-des" placeholder="Désignation" value="${des}" style="min-width:240px">
        <input class="il-qte" type="number" value="${q}" style="width:80px" title="Qté">
        <input class="il-pu" type="number" value="${pu}" style="width:110px" title="P.U. HT">
        <button class="erp-btn ghost il-del">✕</button>`;
      row.querySelector('.il-del').onclick = () => row.remove();
      linesBox.appendChild(row);
    };
    addLine('Prestation de livraison', 21, 560);
    form.querySelector('#iv-add').onclick = () => addLine();
    form.querySelector('#iv-create').onclick = async () => {
      const lines = [...linesBox.querySelectorAll('.erp-row')].map((r) => ({
        designation: r.querySelector('.il-des').value,
        quantite: +r.querySelector('.il-qte').value,
        prixUnitaire: +r.querySelector('.il-pu').value,
      })).filter((l) => l.designation);
      try {
        await api('POST', '/invoices', {
          client: form.querySelector('#iv-client').value,
          period: form.querySelector('#iv-period').value,
          vatRate: +form.querySelector('#iv-vat').value, lines,
        });
        load('invoices');
      } catch (e) { alert('Erreur : ' + e.message); }
    };

    bodyEl.appendChild(E('h3', 'erp', 'Factures'));
    const tbl = E('table', 'erp');
    tbl.innerHTML = `<thead><tr><th>N°</th><th>Client</th><th>Date</th><th>TTC</th><th>Statut</th><th></th></tr></thead><tbody></tbody>`;
    const tb = tbl.querySelector('tbody');
    (d.invoices || []).forEach((inv) => {
      const tr = E('tr');
      tr.innerHTML = `<td>${inv.number}</td><td>${inv.client}</td><td>${inv.date}</td><td>${euro(inv.totalTTC)}</td>
        <td><span class="pill ${inv.status}">${inv.status}</span></td>
        <td class="erp-row" style="margin:0">
          <button class="erp-btn ghost" data-print>PDF</button>
          ${inv.status !== 'paid' ? '<button class="erp-btn ghost" data-sent>Envoyée</button><button class="erp-btn" data-paid>Payée</button>' : ''}
        </td>`;
      tr.querySelector('[data-print]').onclick = async () => {
        const res = await fetch('/api/admin/erp/invoices/' + inv.id + '/print', { headers: { Authorization: 'Bearer ' + TOKEN() } });
        const html = await res.text();
        const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        window.open(url, '_blank');
      };
      const sent = tr.querySelector('[data-sent]'); if (sent) sent.onclick = async () => { await api('POST', `/invoices/${inv.id}/status`, { status: 'sent' }); load('invoices'); };
      const paid = tr.querySelector('[data-paid]'); if (paid) paid.onclick = async () => { await api('POST', `/invoices/${inv.id}/status`, { status: 'paid' }); load('invoices'); };
      tb.appendChild(tr);
    });
    bodyEl.appendChild(tbl);
  }

  function renderDocuments(t, comp) {
    bodyEl.innerHTML = '';
    bodyEl.appendChild(E('h3', 'erp', 'Générer un document (publipostage)'));
    const types = Object.entries(t.templates);
    const users = (comp.users || []);
    const form = E('div');
    form.innerHTML = `
      <div class="erp-row">
        <select id="dc-type">${types.map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
        <select id="dc-user"><option value="">— salarié (si concerné) —</option>${users.map((u) => `<option value="${u.id}">${u.name}</option>`).join('')}</select>
      </div>
      <div class="erp-row"><input id="dc-motif" placeholder="Motif / objet" style="min-width:260px"></div>
      <div class="erp-row"><textarea id="dc-faits" placeholder="Faits précis (dates, détails) — ou tout texte libre"></textarea></div>
      <div class="erp-row">
        <button class="erp-btn" id="dc-gen">Générer le brouillon</button>
        <button class="erp-btn ghost" id="dc-save" style="display:none">Valider &amp; enregistrer (sanction)</button>
        <button class="erp-btn ghost" id="dc-pack">📦 Pack départ (3 documents)</button>
      </div>`;
    bodyEl.appendChild(form);
    form.querySelector('#dc-pack').onclick = async () => {
      const userId = form.querySelector('#dc-user').value;
      if (!userId) return alert('Sélectionnez un salarié.');
      const lastDay = prompt('Dernier jour travaillé (AAAA-MM-JJ) :', new Date().toISOString().slice(0, 10));
      if (!lastDay) return;
      const motif = prompt('Motif de la rupture :', 'Rupture conventionnelle') || '';
      try {
        const { docs } = await api('POST', '/documents/pack-depart', { userId, lastDay, motif });
        const w = window.open('', '_blank');
        w.document.write(docs.map((d) => `<h2>${d.label}</h2>${d.html}<hr style="page-break-after:always">`).join(''));
        w.document.close();
      } catch (e) { alert('Erreur : ' + e.message); }
    };
    const preview = E('div', 'erp-card'); preview.style.display = 'none'; preview.style.background = '#fff'; preview.style.color = '#1e293b';
    bodyEl.appendChild(preview);

    let lastType = '', lastUserId = '', lastMotif = '';
    form.querySelector('#dc-gen').onclick = async () => {
      const type = form.querySelector('#dc-type').value;
      const userId = form.querySelector('#dc-user').value;
      const motif = form.querySelector('#dc-motif').value;
      const faits = form.querySelector('#dc-faits').value;
      const u = users.find((x) => x.id === userId);
      const vars = {
        motif, faits,
        salarie: u ? { fullName: u.name, lastName: (u.lastName || u.name.split(' ').slice(-1)[0] || '').toUpperCase(), civilite: 'Monsieur', address: u.address || '', birthDate: u.birthDate || '', hireDate: u.hireDate || '', poste: 'conducteur VL ≤ 3,5 T', coefficient: '110M' } : {},
        contrat: { type: 'CDI', lieu: 'Éterville (14930) et déplacements', horaires: '151,67 h/mois (35 h hebdomadaires)', remuneration: 'selon grille — à compléter', periodeEssai: '1 mois', motif: motif, terme: '', objet: motif, clause: faits, dateEffet: '', lastDay: '', detail: '' },
      };
      try {
        const { html } = await api('POST', '/documents/render', { type, vars });
        preview.innerHTML = `<div contenteditable="true" style="outline:none">${html}</div>`;
        preview.style.display = 'block';
        lastType = type; lastUserId = userId; lastMotif = motif;
        const printBtn = E('button', 'erp-btn ghost', 'Imprimer / PDF'); printBtn.style.marginTop = '10px';
        printBtn.onclick = () => { const w = window.open('', '_blank'); w.document.write(preview.firstChild.innerHTML); w.document.close(); w.print(); };
        preview.appendChild(printBtn);
        form.querySelector('#dc-save').style.display = (type === 'avertissement') ? 'inline-block' : 'none';
      } catch (e) { alert('Erreur : ' + e.message); }
    };
    form.querySelector('#dc-save').onclick = async () => {
      if (!lastUserId) return alert('Sélectionnez un salarié.');
      try { await api('POST', '/documents/save-sanction', { userId: lastUserId, type: 'Avertissement', motif: lastMotif }); alert('Avertissement enregistré dans le dossier du salarié.'); }
      catch (e) { alert('Erreur : ' + e.message); }
    };
  }

  function renderCompliance(d) {
    bodyEl.innerHTML = '';
    bodyEl.appendChild(E('h3', 'erp', 'Ajouter une échéance'));
    const form = E('div');
    form.innerHTML = `
      <div class="erp-row">
        <select id="cm-scope"><option value="company">Société</option><option value="user">Salarié</option><option value="vehicle">Véhicule</option></select>
        <select id="cm-ref"><option value="">—</option></select>
        <input id="cm-label" placeholder="Type (Permis B, Assurance, Visite médicale…)" style="min-width:240px">
        <input id="cm-expiry" type="date">
        <button class="erp-btn" id="cm-add">Ajouter</button>
      </div>`;
    bodyEl.appendChild(form);
    const ref = form.querySelector('#cm-ref');
    const fillRef = () => {
      const scope = form.querySelector('#cm-scope').value;
      const src = scope === 'vehicle' ? (d.vehicles || []).map((v) => [v.id, v.plate || v.name])
        : scope === 'user' ? (d.users || []).map((u) => [u.id, u.name]) : [];
      ref.innerHTML = '<option value="">—</option>' + src.map(([id, n]) => `<option value="${id}">${n}</option>`).join('');
    };
    fillRef(); form.querySelector('#cm-scope').onchange = fillRef;
    form.querySelector('#cm-add').onclick = async () => {
      try {
        await api('POST', '/compliance', {
          scope: form.querySelector('#cm-scope').value, refId: ref.value || null,
          label: form.querySelector('#cm-label').value, expiry: form.querySelector('#cm-expiry').value,
        });
        load('compliance');
      } catch (e) { alert('Erreur : ' + e.message); }
    };

    bodyEl.appendChild(E('h3', 'erp', 'Échéances suivies'));
    const tbl = E('table', 'erp');
    tbl.innerHTML = `<thead><tr><th>Type</th><th>Concerne</th><th>Échéance</th><th></th></tr></thead><tbody></tbody>`;
    const tb = tbl.querySelector('tbody');
    (d.items || []).forEach((c) => {
      const who = c.scope === 'vehicle' ? ((d.vehicles || []).find((v) => v.id === c.refId) || {}).plate
        : c.scope === 'user' ? ((d.users || []).find((u) => u.id === c.refId) || {}).name : 'Société';
      const tr = E('tr');
      tr.innerHTML = `<td>${c.label}</td><td>${who || '—'}</td><td>${c.expiry}</td><td><button class="erp-btn ghost" data-del>Supprimer</button></td>`;
      tr.querySelector('[data-del]').onclick = async () => { await api('DELETE', '/compliance/' + c.id); load('compliance'); };
      tb.appendChild(tr);
    });
    bodyEl.appendChild(tbl);
  }

  function renderAudit(d) {
    bodyEl.innerHTML = '';
    bodyEl.appendChild(E('h3', 'erp', 'Journal d\'audit (200 dernières actions)'));
    const tbl = E('table', 'erp');
    tbl.innerHTML = `<thead><tr><th>Date</th><th>Utilisateur</th><th>Action</th><th>Objet</th><th>Détail</th></tr></thead><tbody></tbody>`;
    const tb = tbl.querySelector('tbody');
    (d.log || []).forEach((l) => {
      const tr = E('tr');
      tr.innerHTML = `<td>${new Date(l.at).toLocaleString('fr-FR')}</td><td>${l.userName || ''}</td><td>${l.action}</td><td>${l.entity || ''}</td><td>${l.detail || ''}</td>`;
      tb.appendChild(tr);
    });
    bodyEl.appendChild(tbl);
  }

  const ymNow = () => new Date().toISOString().slice(0, 10).slice(0, 7);
  const opt = (v, l, sel) => `<option value="${v}"${sel ? ' selected' : ''}>${l}</option>`;

  /* ---- MODULE 1 : Tournées -------------------------------------------- */
  function renderTours(meta, an) {
    bodyEl.innerHTML = '';
    bodyEl.appendChild(E('h3', 'erp', 'Saisir un retour de tournée'));
    const f = E('div');
    f.innerHTML = `
      <div class="erp-row">
        <input id="t-date" type="date" value="${new Date().toISOString().slice(0, 10)}">
        <select id="t-user">${(meta.users || []).map((u) => opt(u.id, u.name)).join('')}</select>
        <select id="t-veh"><option value="">— véhicule —</option>${(meta.vehicles || []).map((v) => opt(v.id, (v.plate || v.name))).join('')}</select>
        <select id="t-ctr"><option value="">— contrat —</option>${(meta.contracts || []).map((c) => opt(c.id, c.client)).join('')}</select>
      </div>
      <div class="erp-row">
        <input id="t-km1" type="number" placeholder="Km début" style="width:110px">
        <input id="t-km2" type="number" placeholder="Km fin" style="width:110px">
        <input id="t-pp" type="number" placeholder="Pts prévus" style="width:110px">
        <input id="t-pd" type="number" placeholder="Pts livrés" style="width:110px">
        <input id="t-pf" type="number" placeholder="Pts échec" style="width:110px">
        <input id="t-pick" type="number" placeholder="Ramassages" style="width:120px">
        <input id="t-fuel" type="number" placeholder="Litres (opt.)" style="width:120px">
      </div>
      <div class="erp-row">
        <input id="t-fr" placeholder="Motif d'échec" style="min-width:220px">
        <input id="t-inc" placeholder="Incident (opt.)" style="min-width:220px">
        <button class="erp-btn" id="t-save">Enregistrer le retour</button>
      </div>`;
    bodyEl.appendChild(f);
    f.querySelector('#t-save').onclick = async () => {
      try {
        await api('POST', '/tours', {
          date: f.querySelector('#t-date').value, userId: f.querySelector('#t-user').value, vehicleId: f.querySelector('#t-veh').value, contractId: f.querySelector('#t-ctr').value,
          kmStart: +f.querySelector('#t-km1').value, kmEnd: +f.querySelector('#t-km2').value,
          pointsPlanned: +f.querySelector('#t-pp').value, pointsDelivered: +f.querySelector('#t-pd').value, pointsFailed: +f.querySelector('#t-pf').value,
          pickups: +f.querySelector('#t-pick').value, fuelLiters: +f.querySelector('#t-fuel').value,
          failReason: f.querySelector('#t-fr').value, incident: f.querySelector('#t-inc').value,
        });
        load('tours');
      } catch (e) { alert('Erreur : ' + e.message); }
    };
    bodyEl.appendChild(E('h3', 'erp', `Analyse du mois (${an.ym}) — marge ${euro(an.totals.marge)}`));
    const tbl = E('table', 'erp');
    tbl.innerHTML = `<thead><tr><th>Date</th><th>Chauffeur</th><th>Client</th><th>Km</th><th>Pts</th><th>Recette</th><th>Coût</th><th>Marge</th><th></th></tr></thead><tbody></tbody>`;
    const tb = tbl.querySelector('tbody');
    (an.rows || []).forEach((r) => {
      const tr = E('tr'); if (r.marge < 0) tr.style.background = 'rgba(239,68,68,.18)';
      tr.innerHTML = `<td>${r.date}</td><td>${r.userName || ''}</td><td>${r.client}</td><td>${r.km}</td><td>${r.points}</td><td>${euro(r.recette)}</td><td>${euro(r.coutTotal)}</td><td><strong>${euro(r.marge)}</strong></td><td><button class="erp-btn ghost" data-del>✕</button></td>`;
      tr.querySelector('[data-del]').onclick = async () => { await api('DELETE', '/tours/' + r.id); load('tours'); };
      tb.appendChild(tr);
    });
    bodyEl.appendChild(tbl);
    bodyEl.appendChild(barRow('Marge par client', (an.byClient || []).map((c) => ({ label: c.key, value: c.marge }))));
  }

  // Mini-graphe SVG inline (barres horizontales, valeurs +/-).
  function barRow(title, items) {
    const wrap = E('div'); wrap.appendChild(E('h3', 'erp', title));
    if (!items.length) { wrap.appendChild(E('div', null, '—')); return wrap; }
    const max = Math.max(1, ...items.map((i) => Math.abs(i.value)));
    items.forEach((i) => {
      const row = E('div'); row.style.cssText = 'display:grid;grid-template-columns:150px 1fr auto;gap:8px;align-items:center;margin:4px 0';
      const w = Math.round(Math.abs(i.value) / max * 100);
      row.innerHTML = `<span style="color:#94a3b8;font-size:12px">${i.label}</span><span style="background:#0f172a;border-radius:5px;overflow:hidden"><span style="display:block;height:14px;width:${w}%;background:${i.value < 0 ? '#ef4444' : '#22c55e'}"></span></span><span style="${i.value < 0 ? 'color:#ef4444' : ''}">${euro(i.value)}</span>`;
      wrap.appendChild(row);
    });
    return wrap;
  }

  /* ---- MODULE 5 : Trésorerie prévisionnelle --------------------------- */
  function renderCashflow(fc, rec) {
    bodyEl.innerHTML = '';
    if (fc.anyNegative) bodyEl.appendChild(E('div', 'erp-alert critique', `<span class="badge">critique</span><div>Trésorerie projetée négative — solde minimum ${euro(fc.lowestBalance)}.</div>`));
    bodyEl.appendChild(E('h3', 'erp', `Prévision ${fc.weeks} semaines (départ ${euro(fc.start)})`));
    const tbl = E('table', 'erp');
    tbl.innerHTML = `<thead><tr><th>Sem.</th><th>Du</th><th>Encaiss.</th><th>Décaiss.</th><th>Solde projeté</th></tr></thead><tbody></tbody>`;
    const tb = tbl.querySelector('tbody');
    fc.buckets.forEach((b) => { const tr = E('tr'); if (b.negative) tr.style.background = 'rgba(239,68,68,.18)'; tr.innerHTML = `<td>${b.week}</td><td>${b.from}</td><td>${euro(b.in)}</td><td>${euro(b.out)}</td><td><strong>${euro(b.balance)}</strong></td>`; tb.appendChild(tr); });
    bodyEl.appendChild(tbl);
    bodyEl.appendChild(E('h3', 'erp', 'Charges récurrentes'));
    const f = E('div'); f.innerHTML = `<div class="erp-row"><input id="rc-label" placeholder="Libellé (Loyer, URSSAF…)" style="min-width:200px"><input id="rc-amt" type="number" placeholder="Montant €" style="width:130px"><input id="rc-day" type="number" placeholder="Jour" style="width:90px" value="5"><button class="erp-btn" id="rc-add">+ Ajouter</button></div>`;
    bodyEl.appendChild(f);
    f.querySelector('#rc-add').onclick = async () => { try { await api('POST', '/recurring', { label: f.querySelector('#rc-label').value, amount: +f.querySelector('#rc-amt').value, dayOfMonth: +f.querySelector('#rc-day').value }); load('cashflow'); } catch (e) { alert(e.message); } };
    const tbl2 = E('table', 'erp'); tbl2.innerHTML = `<thead><tr><th>Libellé</th><th>Montant</th><th>Jour</th><th></th></tr></thead><tbody></tbody>`;
    (rec.recurring || []).forEach((x) => { const tr = E('tr'); tr.innerHTML = `<td>${x.label}</td><td>${euro(x.amount)}</td><td>${x.dayOfMonth}</td><td><button class="erp-btn ghost" data-del>✕</button></td>`; tr.querySelector('[data-del]').onclick = async () => { await api('DELETE', '/recurring/' + x.id); load('cashflow'); }; tbl2.querySelector('tbody').appendChild(tr); });
    bodyEl.appendChild(tbl2);
  }

  /* ---- MODULE 6 : Clôture mensuelle ----------------------------------- */
  function renderClosing() {
    bodyEl.innerHTML = '';
    bodyEl.appendChild(E('h3', 'erp', 'Clôture mensuelle en 1 clic'));
    const f = E('div'); f.innerHTML = `<div class="erp-row"><input id="cl-ym" type="month" value="${ymNow()}"><button class="erp-btn ghost" id="cl-preview">Aperçu</button><button class="erp-btn" id="cl-run">Exécuter la clôture</button></div>`;
    bodyEl.appendChild(f);
    const out = E('div'); bodyEl.appendChild(out);
    const run = async (preview) => {
      const ym = f.querySelector('#cl-ym').value;
      try {
        const r = await api('POST', `/closing/${ym}${preview ? '?preview=1' : ''}`);
        out.innerHTML = `<div class="erp-grid" style="margin-top:10px">
          ${['CA', 'Charges', 'Résultat', 'Marge tournées', 'À encaisser'].map((k, i) => `<div class="erp-card"><div class="k">${k}</div><div class="v">${euro([r.recap.ca, r.recap.charges, r.recap.resultat, r.recap.margeTournees, r.recap.aEncaisser][i])}</div></div>`).join('')}</div>
          <p>${preview ? 'APERÇU — rien n\'a été enregistré.' : 'Clôture exécutée.'} Factures brouillon : <strong>${r.draftInvoices.length}</strong> · Relances préparées : <strong>${r.overdue.length}</strong> · Lignes de paie : <strong>${r.payroll.length}</strong></p>`;
      } catch (e) { alert('Erreur : ' + e.message); }
    };
    f.querySelector('#cl-preview').onclick = () => run(true);
    f.querySelector('#cl-run').onclick = () => { if (confirm('Exécuter la clôture (génère les factures brouillon) ?')) run(false); };
  }

  /* ---- MODULE 7 : Frais / IK ------------------------------------------ */
  function renderExpenses(meta, d) {
    bodyEl.innerHTML = '';
    bodyEl.appendChild(E('div', 'erp-alert info', `<span class="badge">info</span><div>${(d.ikScale && d.ikScale.note) || 'Vérifiez le barème IK sur impots.gouv.fr.'}</div>`));
    bodyEl.appendChild(E('h3', 'erp', 'Nouvelle note de frais'));
    const f = E('div'); f.innerHTML = `<div class="erp-row">
      <select id="x-user">${(meta.users || []).map((u) => opt(u.id, u.name)).join('')}</select>
      <select id="x-type">${opt('ik', 'Indemnité km (IK)')}${opt('frais', 'Frais réel')}</select>
      <input id="x-km" type="number" placeholder="Km (si IK)" style="width:110px">
      <input id="x-cv" type="number" placeholder="CV fiscaux" style="width:110px" value="5">
      <input id="x-amt" type="number" placeholder="Montant € (si frais)" style="width:150px">
      <input id="x-note" placeholder="Note" style="min-width:160px">
      <button class="erp-btn" id="x-add">Ajouter</button></div>`;
    bodyEl.appendChild(f);
    f.querySelector('#x-add').onclick = async () => { try { await api('POST', '/expenses', { userId: f.querySelector('#x-user').value, type: f.querySelector('#x-type').value, km: +f.querySelector('#x-km').value, cv: +f.querySelector('#x-cv').value, amount: +f.querySelector('#x-amt').value, note: f.querySelector('#x-note').value }); load('expenses'); } catch (e) { alert(e.message); } };
    const names = {}; (meta.users || []).forEach((u) => names[u.id] = u.name);
    const tbl = E('table', 'erp'); tbl.innerHTML = `<thead><tr><th>Date</th><th>Salarié</th><th>Type</th><th>Km</th><th>Montant</th><th>Statut</th><th></th></tr></thead><tbody></tbody>`;
    (d.expenses || []).forEach((x) => { const tr = E('tr'); tr.innerHTML = `<td>${x.date}</td><td>${names[x.userId] || ''}</td><td>${x.type}</td><td>${x.km || '—'}</td><td><strong>${euro(x.amount)}</strong></td><td><span class="pill ${x.status === 'approved' ? 'paid' : x.status === 'rejected' ? 'sent' : 'draft'}">${x.status}</span></td><td class="erp-row" style="margin:0">${x.status !== 'approved' ? '<button class="erp-btn ghost" data-ok>Valider</button>' : ''}<button class="erp-btn ghost" data-del>✕</button></td>`; const ok = tr.querySelector('[data-ok]'); if (ok) ok.onclick = async () => { await api('POST', `/expenses/${x.id}/status`, { status: 'approved' }); load('expenses'); }; tr.querySelector('[data-del]').onclick = async () => { await api('DELETE', '/expenses/' + x.id); load('expenses'); }; tbl.querySelector('tbody').appendChild(tr); });
    bodyEl.appendChild(tbl);
  }

  /* ---- MODULE 8 : RH / coffre-fort ------------------------------------ */
  function renderRh(meta, d) {
    bodyEl.innerHTML = '';
    bodyEl.appendChild(E('h3', 'erp', 'Coffre-fort salarié (métadonnées)'));
    const f = E('div'); f.innerHTML = `<div class="erp-row">
      <select id="r-user">${(meta.users || []).map((u) => opt(u.id, u.name)).join('')}</select>
      <input id="r-label" placeholder="Document (Permis B, RIB, Visite médicale…)" style="min-width:240px">
      <input id="r-file" placeholder="Nom de fichier (réf.)" style="min-width:160px">
      <input id="r-exp" type="date" title="Échéance (optionnel)">
      <button class="erp-btn" id="r-add">Ajouter</button></div>
      <p style="color:#94a3b8;font-size:12px">Une échéance renseignée crée automatiquement une alerte de conformité. (Stockage du fichier binaire prévu avec PostgreSQL.)</p>`;
    bodyEl.appendChild(f);
    f.querySelector('#r-add').onclick = async () => { try { await api('POST', '/staff-docs', { userId: f.querySelector('#r-user').value, label: f.querySelector('#r-label').value, fileName: f.querySelector('#r-file').value, expiry: f.querySelector('#r-exp').value }); load('rh'); } catch (e) { alert(e.message); } };
    const names = {}; (d.users || []).forEach((u) => names[u.id] = u.name);
    const tbl = E('table', 'erp'); tbl.innerHTML = `<thead><tr><th>Salarié</th><th>Document</th><th>Fichier</th><th>Échéance</th><th></th></tr></thead><tbody></tbody>`;
    (d.docs || []).forEach((x) => { const tr = E('tr'); tr.innerHTML = `<td>${names[x.userId] || ''}</td><td>${x.label}</td><td>${x.fileName || '—'}</td><td>${x.expiry || '—'}</td><td><button class="erp-btn ghost" data-del>✕</button></td>`; tr.querySelector('[data-del]').onclick = async () => { await api('DELETE', '/staff-docs/' + x.id); load('rh'); }; tbl.querySelector('tbody').appendChild(tr); });
    bodyEl.appendChild(tbl);
  }

  /* ---- MODULE 9 : Réappro pièces -------------------------------------- */
  function renderStock(d) {
    bodyEl.innerHTML = '';
    bodyEl.appendChild(E('h3', 'erp', `Pièces sous le seuil (${(d.items || []).length})`));
    if (!d.items.length) { bodyEl.appendChild(E('div', null, 'Aucune pièce à réapprovisionner.')); return; }
    const tbl = E('table', 'erp'); tbl.innerHTML = `<thead><tr><th>Pièce</th><th>Réf.</th><th>Stock</th><th>Seuil</th><th>Fournisseur</th></tr></thead><tbody></tbody>`;
    (d.items || []).forEach((p) => { const tr = E('tr'); tr.innerHTML = `<td>${p.name}</td><td>${p.ref || '—'}</td><td>${p.qty} ${p.unit || ''}</td><td>${p.seuilMini}</td><td>${p.fournisseur || '—'}</td>`; tbl.querySelector('tbody').appendChild(tr); });
    bodyEl.appendChild(tbl);
    const btn = E('button', 'erp-btn', 'Générer le bon de commande'); btn.style.marginTop = '12px';
    btn.onclick = async () => {
      try {
        const { html } = await api('POST', '/restock/order', { fournisseur: (d.items[0].fournisseur || 'Fournisseur'), parts: d.items.map((p) => ({ ref: p.ref, name: p.name, qte: Math.max(1, (p.seuilMini * 2) - p.qty), unitPrice: p.unitPrice })) });
        const w = window.open('', '_blank'); w.document.write(html); w.document.close();
      } catch (e) { alert(e.message); }
    };
    bodyEl.appendChild(btn);
  }

  // ---- Démarrage : on attend que l'app soit chargée et que l'on soit admin
  function boot() {
    isAdmin().then((ok) => { if (ok) build(); });
  }
  if (document.readyState === 'complete') setTimeout(boot, 1500);
  else window.addEventListener('load', () => setTimeout(boot, 1500));
})();
