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
    [['dashboard', 'Tableau de bord'], ['invoices', 'Facturation'], ['documents', 'Documents'],
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
      if (tab === 'invoices') return renderInvoices(await api('GET', '/invoices'));
      if (tab === 'documents') return renderDocuments(await api('GET', '/templates'), await api('GET', '/compliance'));
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
      </div>`;
    bodyEl.appendChild(form);
    const preview = E('div', 'erp-card'); preview.style.display = 'none'; preview.style.background = '#fff'; preview.style.color = '#1e293b';
    bodyEl.appendChild(preview);

    let lastType = '', lastUserId = '', lastMotif = '';
    form.querySelector('#dc-gen').onclick = async () => {
      const type = form.querySelector('#dc-type').value;
      const userId = form.querySelector('#dc-user').value;
      const motif = form.querySelector('#dc-motif').value;
      const faits = form.querySelector('#dc-faits').value;
      const u = users.find((x) => x.id === userId);
      const vars = { motif, faits, salarie: u ? { fullName: u.name, lastName: (u.name.split(' ').slice(-1)[0] || '').toUpperCase(), civilite: 'Monsieur', address: '', hireDate: '', poste: 'conducteur VL' } : {} };
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

  // ---- Démarrage : on attend que l'app soit chargée et que l'on soit admin
  function boot() {
    isAdmin().then((ok) => { if (ok) build(); });
  }
  if (document.readyState === 'complete') setTimeout(boot, 1500);
  else window.addEventListener('load', () => setTimeout(boot, 1500));
})();
