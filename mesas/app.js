// Mesas do evento: planta partilhada, grupos e alocação. Requinte / CNB.
// Toda a lógica de negócio está no servidor (funções mesas_*); esta página só mostra e chama.

const CFG = window.CONFIG || {};
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  realtime: { params: { eventsPerSecond: 5 } },
});

const S = 40; // píxeis por metro na planta
const CORES_GRUPO = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];

const st = {
  eu: null, eventos: [], evento: null, tipos: [], elementos: [], mesas: [], grupos: [], bilhetes: {}, utilizadores: [],
  resumo: null, vista: 'planta', mesaSel: null, grupoSel: null, destaque: null,
  zoom: { k: 1, x: 0, y: 0 }, editor: { sel: new Set(), movendo: null }, canalTR: null, timerRecarga: null,
};

// ---------------------------------------------------------------- utilidades
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mt = (v) => (Number(v) || 0).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' MT';
const dh = (v) => v ? new Date(v).toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const gestao = () => st.eu && (st.eu.nivel === 'admin' || st.eu.nivel === 'gestao');
const podeAlocar = () => st.eu && ['admin', 'gestao', 'caixa'].includes(st.eu.nivel);
const meu = (g) => st.eu && g.registado_por === st.eu.id;

function aviso(msg, erro = false, ms = 3500) {
  const a = $('#aviso'); if (!a) return;
  a.textContent = msg; a.classList.toggle('erro', erro); a.classList.remove('escondido');
  clearTimeout(a._t); a._t = setTimeout(() => a.classList.add('escondido'), ms);
}
function modal(html) {
  const m = $('#modal'); $('#modal-caixa').innerHTML = html; m.classList.remove('escondido');
  m.onclick = (e) => { if (e.target === m) fecharModal(); };
  return $('#modal-caixa');
}
function fecharModal() { const m = $('#modal'); if (m) { m.classList.add('escondido'); $('#modal-caixa').innerHTML = ''; } }
function confirmar(titulo, texto, botao = 'Confirmar', pedirMotivo = false) {
  return new Promise((res) => {
    const c = modal(`<h2>${esc(titulo)}</h2><p>${esc(texto)}</p>
      ${pedirMotivo ? '<label>Motivo <input id="motivo-conf" autofocus></label>' : ''}
      <div class="linha-btns"><button class="btn primario" id="conf-sim">${esc(botao)}</button><button class="btn" id="conf-nao">Cancelar</button></div>`);
    $('#conf-sim', c).onclick = () => { const mo = pedirMotivo ? $('#motivo-conf', c).value.trim() : true; if (pedirMotivo && !mo) return; fecharModal(); res(mo); };
    $('#conf-nao', c).onclick = () => { fecharModal(); res(null); };
  });
}
async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(limparErro(error.message));
  return data;
}
function limparErro(m) { return String(m || 'Erro').replace(/^.*?: /, '').replace(/\(SQLSTATE.*$/, ''); }
async function tentar(fn, msgOk) {
  try { const r = await fn(); if (msgOk) aviso(msgOk); await recarregar(); return r; }
  catch (e) { aviso(e.message, true, 6000); return undefined; }
}
const mesaPorId = (id) => st.mesas.find((m) => m.id === id);
const grupoPorId = (id) => st.grupos.find((g) => g.id === id);
const mesaDoGrupo = (g) => st.mesas.find((m) => (m.grupos || []).some((x) => x.grupo_id === g.id));
const corGrupo = (id) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return CORES_GRUPO[h % CORES_GRUPO.length]; };
const telefone = (t) => t ? `<a href="tel:${esc(t.replace(/\s/g, ''))}">${esc(t)}</a>` : '';
const daEncomenda = (g) => !!(g && g.bilhetes_encomenda_id);
const badgeEnc = (g) => daEncomenda(g) ? '<span class="etiqueta encomenda" title="Grupo criado pela compra de bilhetes">bilhetes</span>' : '';

// ---------------------------------------------------------------- dados
async function carregarTudo() {
  const ev = st.evento.id;
  const [tipos, elementos, mesas, grupos, bilhetes, utilizadores, evento] = await Promise.all([
    sb.from('mesas_tipos').select('*').eq('evento_id', ev).order('ordem'),
    sb.from('mesas_elementos').select('*').eq('evento_id', ev).order('ordem'),
    sb.from('mesas_v_estado').select('*').eq('evento_id', ev),
    sb.from('mesas_grupos').select('*').eq('evento_id', ev).order('registado_em', { ascending: false }),
    sb.from('mesas_bilhetes_grupo').select('*').eq('evento_id', ev).order('ordem'),
    sb.from('mesas_utilizadores').select('id,nome,nivel,email,activo'),
    sb.from('mesas_eventos').select('*').eq('id', ev).single(),
  ]);
  for (const r of [tipos, elementos, mesas, grupos, bilhetes, utilizadores, evento]) if (r.error) throw new Error(r.error.message);
  st.tipos = tipos.data; st.elementos = elementos.data; st.mesas = mesas.data.sort((a, b) => ordemCodigo(a.codigo, b.codigo));
  st.grupos = grupos.data; st.utilizadores = utilizadores.data; st.evento = evento.data;
  st.bilhetes = {}; for (const b of bilhetes.data) (st.bilhetes[b.grupo_id] ||= []).push(b);
  try { st.resumo = await rpc('mesas_resumo', { p_evento: ev }); } catch { st.resumo = null; }
}
function ordemCodigo(a, b) {
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (!isNaN(na) && !isNaN(nb) && String(na) === a && String(nb) === b) return na - nb;
  return String(a).localeCompare(String(b), 'pt', { numeric: true });
}
async function recarregar() {
  try { await carregarTudo(); } catch (e) { aviso('Sem ligação: ' + e.message, true); return; }
  desenharContadores(); desenharVista();
}
function pedirRecarga() { clearTimeout(st.timerRecarga); st.timerRecarga = setTimeout(recarregar, 400); }
function ligarTempoReal() {
  if (CFG.SEM_TEMPO_REAL || st.canalTR) return;
  st.canalTR = sb.channel('mesas-' + st.evento.id);
  for (const t of ['mesas_mesas', 'mesas_grupos', 'mesas_alocacoes', 'mesas_lugares_ocupados', 'mesas_elementos', 'mesas_tipos', 'mesas_eventos', 'mesas_bilhetes_grupo'])
    st.canalTR.on('postgres_changes', { event: '*', schema: 'public', table: t }, pedirRecarga);
  st.canalTR.subscribe();
  setInterval(() => { if (document.visibilityState === 'visible') pedirRecarga(); }, 45000);
  window.addEventListener('online', () => aviso('Ligação recuperada.'));
  window.addEventListener('offline', () => aviso('Sem rede: a planta pode estar desactualizada e as alocações vão falhar.', true, 8000));
}

// ---------------------------------------------------------------- arranque e entrada
async function arrancar() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return mostrarEntrada();
  await depoisDeEntrar();
}
function mostrarEntrada(msg = '') {
  $('#app').innerHTML = ''; $('#app').append($('#t-entrada').content.cloneNode(true));
  $('#erro-entrada').textContent = msg;
  if (CFG.ENTRADA_UNICA) { const a = document.createElement('a'); a.className = 'btn largo'; a.href = CFG.ENTRADA_UNICA; a.textContent = 'Entrar com nome e PIN (entrada única da equipa)'; $('#btn-criar-conta').before(a); }
  $('#form-entrada').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const { error } = await sb.auth.signInWithPassword({ email: f.get('email').trim(), password: f.get('senha') });
    if (error) { $('#erro-entrada').textContent = 'Não foi possível entrar: ' + error.message; return; }
    await depoisDeEntrar();
  };
  $('#btn-criar-conta').onclick = async () => {
    const f = new FormData($('#form-entrada'));
    if (!f.get('email') || !f.get('senha')) { $('#erro-entrada').textContent = 'Escreva o email e a palavra-passe que quer usar.'; return; }
    const { error } = await sb.auth.signUp({ email: f.get('email').trim(), password: f.get('senha') });
    if (error) { $('#erro-entrada').textContent = error.message; return; }
    $('#erro-entrada').textContent = 'Conta criada. Se o email exigir confirmação, confirme-o e depois entre.';
  };
}
async function depoisDeEntrar() {
  const { data: eu, error } = await sb.rpc('mesas_quem_sou');
  if (error || !eu || !eu.id) {
    await sb.auth.signOut();
    return mostrarEntrada('Esta conta não faz parte da equipa do módulo de mesas. Peça ao administrador para a adicionar.');
  }
  st.eu = eu;
  const { data: eventos } = await sb.from('mesas_eventos').select('*').order('data', { ascending: false });
  st.eventos = eventos || [];
  if (!st.eventos.length) { return mostrarEntrada('Ainda não há eventos criados.'); }
  const guardado = localStorage.getItem('mesas_evento');
  st.evento = st.eventos.find((e) => e.id === guardado) || st.eventos.find((e) => e.estado !== 'fechado') || st.eventos[0];
  $('#app').innerHTML = ''; $('#app').append($('#t-app').content.cloneNode(true));
  $('#eu-nome').textContent = `${eu.nome} (${nomeNivel(eu.nivel)})`;
  $('#btn-sair').onclick = async () => { await sb.auth.signOut(); location.hash = ''; location.reload(); };
  $('#pesquisa').oninput = (e) => pesquisar(e.target.value);
  $('#pesquisa').onkeydown = (e) => { if (e.key === 'Enter') { location.hash = '#planta'; pesquisar(e.target.value, true); } };
  if (!gestao()) $$('.so-gestao').forEach((a) => a.classList.add('escondido'));
  window.onhashchange = () => { st.vista = (location.hash || '#planta').slice(1); desenharVista(); };
  st.vista = (location.hash || '#planta').slice(1);
  await carregarTudo();
  ligarTempoReal();
  desenharContadores(); desenharVista();
}
const nomeNivel = (n) => ({ admin: 'administrador', gestao: 'gestão', caixa: 'caixa', consulta: 'consulta' }[n] || n);

function desenharContadores() {
  const r = st.resumo; const c = $('#contadores'); if (!c) return;
  $('#evento-nome').textContent = st.evento.nome + (st.evento.planta_fechada ? ' (planta fechada)' : '');
  if (!r) { c.innerHTML = ''; return; }
  const livres = r.lugares - r.ocupados - r.lugares_bloqueados;
  c.innerHTML = `
    <div><b>${r.pessoas_registadas}</b>pessoas registadas</div>
    <div><b>${r.pessoas_sentadas}</b>sentadas</div>
    <div><b>${r.grupos_por_sentar}</b>grupos por sentar (${r.pessoas_por_sentar})</div>
    <div><b>${livres}</b>lugares livres de ${r.lugares}</div>
    <div><b>${mt(r.receita)}</b>${gestao() ? 'receita' : 'a minha receita'}</div>`;
}

// ---------------------------------------------------------------- vistas
function desenharVista() {
  $$('#nav a').forEach((a) => a.classList.toggle('activa', a.dataset.vista === st.vista));
  const v = $('#vista'); if (!v) return;
  if ((st.vista === 'editor' || st.vista === 'definicoes') && !gestao()) st.vista = 'planta';
  v.className = ''; v.innerHTML = '';
  ({ planta: vistaPlanta, grupos: vistaGrupos, listas: vistaListas, historico: vistaHistorico, editor: vistaEditor, definicoes: vistaDefinicoes }[st.vista] || vistaPlanta)(v);
}

// ------------------------------------------------ planta
function vistaPlanta(v) {
  v.innerHTML = `<div class="ecra-planta">
    <div class="area-planta" id="area-planta"><h1 class="so-impressao cabecalho-impressao">${esc(st.evento.nome)}, planta das mesas, ${dh(new Date())}</h1>
      <div class="zoom"><button class="btn" id="z-mais">+</button><button class="btn" id="z-menos">-</button><button class="btn" id="z-tudo" title="Ver tudo">&#8982;</button></div>
      <div class="legenda"><span class="l-livre">livre</span><span class="l-parcial">parcial</span><span class="l-cheia">cheia</span><span class="l-provisoria">provisória</span><span class="l-bloqueada">bloqueada</span><span class="l-mista">mista</span></div>
    </div>
    <aside class="painel" id="painel"></aside></div>`;
  desenharSVG($('#area-planta'), false);
  $('#z-mais').onclick = () => zoomAo(1.25); $('#z-menos').onclick = () => zoomAo(0.8); $('#z-tudo').onclick = () => { st.zoom = { k: 1, x: 0, y: 0 }; aplicarZoom(); };
  desenharPainel();
}

function desenharPainel() {
  const p = $('#painel'); if (!p) return;
  if (st.mesaSel) { const m = mesaPorId(st.mesaSel); if (m) return p.innerHTML = fichaMesa(m), ligarFichaMesa(p, m); st.mesaSel = null; }
  const porSentar = st.grupos.filter((g) => g.estado === 'por_sentar');
  const sel = st.grupoSel ? grupoPorId(st.grupoSel) : null;
  p.innerHTML = `
    ${sel ? `<div class="cartao seleccionado"><h3>A sentar: ${esc(sel.cliente_nome)}</h3><p>${sel.pessoas} pessoas, ${esc(sel.tipo_bilhete)}. Toque numa mesa da planta ou peça uma sugestão.</p>
      <div class="linha-btns"><button class="btn primario" id="btn-sugerir">Sugerir mesa</button><button class="btn" id="btn-desel">Deixar para depois</button></div></div>` : ''}
    <div class="linha-btns">${podeAlocar() ? '<button class="btn primario" id="btn-novo-grupo">Novo grupo</button>' : ''}<a class="btn" href="#grupos">Todos os grupos</a></div>
    <h3>Grupos por sentar (${porSentar.length})</h3>
    ${porSentar.length ? porSentar.map((g) => cartaoGrupo(g, true)).join('') : '<p class="suave">Nenhum grupo à espera de mesa.</p>'}`;
  if ($('#btn-novo-grupo', p)) $('#btn-novo-grupo', p).onclick = () => formGrupo();
  if ($('#btn-sugerir', p)) $('#btn-sugerir', p).onclick = () => sugerirESentar(st.grupoSel);
  if ($('#btn-desel', p)) $('#btn-desel', p).onclick = () => { st.grupoSel = null; desenharPainel(); desenharSVGMesas(); };
  $$('.cartao-grupo', p).forEach((c) => { c.onclick = () => { st.grupoSel = c.dataset.id; st.mesaSel = null; desenharPainel(); }; });
}
function cartaoGrupo(g, curto = false) {
  const m = mesaDoGrupo(g);
  return `<div class="cartao clicavel cartao-grupo ${st.grupoSel === g.id ? 'seleccionado' : ''}" data-id="${g.id}">
    <h3>${esc(g.cliente_nome)} <span class="etiqueta ${g.estado}">${nomeEstadoGrupo(g.estado)}</span>${badgeEnc(g)}</h3>
    <p>${g.pessoas} ${g.pessoas === 1 ? 'pessoa' : 'pessoas'}, ${esc(g.tipo_bilhete)}${m ? `, mesa <b>${esc(m.codigo)}</b>` : ''}${g.cliente_telefone ? ', ' + telefone(g.cliente_telefone) : ''}</p>
    ${curto ? '' : `<p class="suave">Registado por ${esc(nomeUtilizador(g.registado_por))} em ${dh(g.registado_em)}${g.observacoes ? '. ' + esc(g.observacoes) : ''}</p>`}</div>`;
}
const nomeEstadoGrupo = (e) => ({ por_sentar: 'por sentar', provisorio: 'provisório', sentado: 'sentado', cancelado: 'cancelado' }[e] || e);
const nomeUtilizador = (id) => (st.utilizadores.find((u) => u.id === id) || {}).nome || (id ? 'outro utilizador' : 'sistema');

function fichaMesa(m) {
  const tipo = st.tipos.find((t) => t.id === m.tipo_id);
  const grupos = m.grupos || [];
  const sel = st.grupoSel ? grupoPorId(st.grupoSel) : null;
  const livres = m.lugares - m.ocupados;
  return `<div class="cartao"><h3>Mesa ${esc(m.codigo)} <span class="etiqueta">${nomeEstadoMesa(m.estado)}</span>${m.modo === 'mista' ? '<span class="etiqueta mista">mista</span>' : ''}</h3>
    <p>${tipo ? esc(tipo.nome) + ', ' : ''}${m.lugares} lugares, ${livres} livres${m.sector ? ', ' + esc(m.sector) : ''}${m.bloqueada ? '. Bloqueada: ' + esc(m.bloqueio_motivo || 'sem motivo') : ''}</p>
    ${sel && podeAlocar() && !m.bloqueada && livres >= sel.pessoas ? `<div class="linha-btns"><button class="btn primario" id="btn-sentar-aqui">Sentar ${esc(sel.cliente_nome)} aqui (${sel.pessoas})</button></div>` : ''}
    ${sel && livres < sel.pessoas ? `<p class="erro">Não cabe: o grupo tem ${sel.pessoas} pessoas e há ${livres} lugares livres.</p>` : ''}
    <div class="linha-btns"><button class="btn" id="btn-fechar-ficha">Voltar</button>
      ${gestao() ? `<button class="btn" id="btn-bloquear">${m.bloqueada ? 'Desbloquear' : 'Bloquear'}</button>` : ''}</div></div>
    ${grupos.map((x) => { const g = grupoPorId(x.grupo_id) || x; const vis = gestao() || meu(g); return `
      <div class="cartao" style="border-left:4px solid ${corGrupo(x.grupo_id)}"><h3>${esc(x.cliente_nome)} <span class="etiqueta ${x.estado === 'provisoria' ? 'provisorio' : 'sentado'}">${x.estado === 'provisoria' ? 'provisório' : 'sentado'}</span></h3>
      <p>${x.pessoas} pessoas, lugares ${(x.lugares || []).join(', ')}, ${esc(x.tipo_bilhete)}${g.cliente_telefone ? ', ' + telefone(g.cliente_telefone) : ''}</p>
      <p class="suave">Sentado por ${esc(x.por || 'sistema')} em ${dh(x.em)}${x.observacoes ? '. ' + esc(x.observacoes) : ''}</p>
      ${vis && st.bilhetes[x.grupo_id] ? `<p class="suave">Bilhetes: ${st.bilhetes[x.grupo_id].map((b) => esc(b.numero || '?')).join(', ')}. Total ${mt(st.bilhetes[x.grupo_id].reduce((s, b) => s + Number(b.valor), 0))}</p>` : ''}
      <div class="linha-btns">
        <button class="btn pequeno btn-ver-grupo" data-id="${x.grupo_id}">Ficha do grupo</button>
        ${podeAlocar() && (gestao() || meu(g)) ? `<button class="btn pequeno btn-mudar" data-id="${x.grupo_id}">Mudar de mesa</button>` : ''}
        ${x.estado === 'provisoria' && podeAlocar() ? `<button class="btn pequeno btn-confirmar" data-id="${x.grupo_id}">Confirmar</button>` : ''}
        ${gestao() ? `<button class="btn pequeno perigo btn-anular" data-id="${x.grupo_id}">Anular</button>` : ''}
      </div></div>`; }).join('')}
    ${!grupos.length ? '<p class="suave">Ninguém sentado nesta mesa.</p>' : ''}`;
}
const nomeEstadoMesa = (e) => ({ livre: 'livre', parcial: 'parcial', cheia: 'cheia', provisoria: 'provisória', bloqueada: 'bloqueada' }[e] || e);
function ligarFichaMesa(p, m) {
  $('#btn-fechar-ficha', p).onclick = () => { st.mesaSel = null; desenharPainel(); desenharSVGMesas(); };
  if ($('#btn-sentar-aqui', p)) $('#btn-sentar-aqui', p).onclick = () => sentarEm(st.grupoSel, m.id);
  if ($('#btn-bloquear', p)) $('#btn-bloquear', p).onclick = async () => {
    if (m.bloqueada) return tentar(() => rpc('mesas_bloquear', { p_mesa: m.id, p_bloquear: false, p_motivo: null }), 'Mesa desbloqueada.');
    const mo = await confirmar('Bloquear mesa ' + m.codigo, 'A mesa sai da venda e das sugestões.', 'Bloquear', true);
    if (mo) tentar(() => rpc('mesas_bloquear', { p_mesa: m.id, p_bloquear: true, p_motivo: mo }), 'Mesa bloqueada.');
  };
  $$('.btn-ver-grupo', p).forEach((b) => b.onclick = () => fichaGrupo(b.dataset.id));
  $$('.btn-mudar', p).forEach((b) => b.onclick = () => { st.grupoSel = b.dataset.id; st.mesaSel = null; aviso('Toque na mesa de destino ou peça uma sugestão.'); desenharPainel(); desenharSVGMesas(); });
  $$('.btn-confirmar', p).forEach((b) => b.onclick = () => tentar(() => rpc('mesas_confirmar_provisoria', { p_grupo: b.dataset.id }), 'Reserva confirmada.'));
  $$('.btn-anular', p).forEach((b) => b.onclick = async () => {
    const mo = await confirmar('Anular alocação', 'O grupo volta à lista de grupos por sentar.', 'Anular', true);
    if (mo) tentar(() => rpc('mesas_anular_alocacao', { p_grupo: b.dataset.id, p_motivo: mo }), 'Alocação anulada.');
  });
}

// Sentar um grupo numa mesa (com escolha de lugares nas mistas e opção de reserva provisória).
async function sentarEm(grupoId, mesaId) {
  const g = grupoPorId(grupoId), m = mesaPorId(mesaId); if (!g || !m) return;
  const jaSentado = !!mesaDoGrupo(g);
  const ocupados = new Set((m.grupos || []).flatMap((x) => x.lugares || []));
  let lugaresHtml = '';
  if (m.modo === 'mista') {
    lugaresHtml = `<p>Escolha o primeiro lugar (os ${g.pessoas} lugares seguintes ficam para o grupo) ou deixe o sistema escolher.</p>
      <div class="lugares-picker">${Array.from({ length: m.lugares }, (_, i) => i + 1).map((n) => `<div class="lugar ${ocupados.has(n) ? 'ocupado' : ''}" data-n="${n}">${n}</div>`).join('')}</div>
      <p class="suave">Os lugares estão numerados aos pares, frente a frente: 1 e 2, 3 e 4, e assim por diante.</p>`;
  }
  const c = modal(`<h2>${jaSentado ? 'Mudar' : 'Sentar'} ${esc(g.cliente_nome)} na mesa ${esc(m.codigo)}</h2>
    <p>${g.pessoas} pessoas. Mesa ${m.modo === 'mista' ? 'mista' : 'exclusiva'} de ${m.lugares} lugares, ${m.lugares - m.ocupados} livres.</p>
    ${lugaresHtml}
    ${jaSentado ? '<label>Motivo da mudança <input id="motivo-mudar"></label>' : '<label><input type="checkbox" id="chk-prov" style="width:auto"> Reserva provisória (ainda sem pagamento, expira em ' + st.evento.prazo_provisoria_horas + ' h)</label>'}
    <div class="linha-btns"><button class="btn primario" id="ok-sentar">${jaSentado ? 'Mudar' : 'Sentar'}</button><button class="btn" id="nao-sentar">Cancelar</button></div><p class="erro" id="erro-sentar"></p>`);
  let escolha = null;
  $$('.lugar', c).forEach((l) => l.onclick = () => {
    const n = Number(l.dataset.n); const seq = Array.from({ length: g.pessoas }, (_, i) => n + i);
    if (seq.some((x) => x > m.lugares || ocupados.has(x))) { $('#erro-sentar', c).textContent = 'A partir desse lugar não há ' + g.pessoas + ' lugares seguidos livres.'; return; }
    escolha = seq; $('#erro-sentar', c).textContent = '';
    $$('.lugar', c).forEach((x) => x.classList.toggle('escolhido', seq.includes(Number(x.dataset.n))));
  });
  $('#nao-sentar', c).onclick = fecharModal;
  $('#ok-sentar', c).onclick = async () => {
    try {
      if (jaSentado) await rpc('mesas_mover', { p_grupo: g.id, p_mesa: m.id, p_lugares: escolha, p_motivo: $('#motivo-mudar', c).value || null });
      else await rpc('mesas_alocar', { p_grupo: g.id, p_mesa: m.id, p_lugares: escolha, p_provisoria: $('#chk-prov', c).checked });
      fecharModal(); st.grupoSel = null; st.mesaSel = m.id; aviso(`${g.cliente_nome} na mesa ${m.codigo}.`); await recarregar();
    } catch (e) { $('#erro-sentar', c).textContent = e.message; }
  };
}
async function sugerirESentar(grupoId) {
  const g = grupoPorId(grupoId); if (!g) return;
  let sug; try { sug = await rpc('mesas_sugerir', { p_grupo: g.id }); } catch (e) { return aviso(e.message, true); }
  const c = modal(`<h2>Mesa para ${esc(g.cliente_nome)} (${g.pessoas})</h2>
    ${sug.map((s) => s.mesa_id ? `<div class="sugestao" data-id="${s.mesa_id}"><b>Mesa ${esc(s.codigo)}</b> <span class="suave">lugares ${(s.lugares || []).join(', ')}</span><br>${esc(s.porque)}</div>`
                        : `<p class="erro">${esc(s.porque)}</p>`).join('')}
    <div class="linha-btns"><button class="btn" id="fechar-sug">Escolher na planta</button></div>`);
  $('#fechar-sug', c).onclick = fecharModal;
  $$('.sugestao', c).forEach((d) => d.onclick = () => { fecharModal(); st.destaque = d.dataset.id; desenharSVGMesas(); sentarEm(g.id, d.dataset.id); });
}

// ------------------------------------------------ SVG da planta
function desenharSVG(area, editor) {
  const ev = st.evento; const W = Number(ev.largura_m) * S, H = Number(ev.altura_m) * S;
  area.insertAdjacentHTML('afterbegin', `<svg id="svg-planta" class="${editor ? 'editor' : ''}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="Inter, system-ui, sans-serif">
    <g id="g-zoom"><rect x="0" y="0" width="${W}" height="${H}" fill="#fff" id="fundo-planta"/><g id="g-elementos"></g><g id="g-mesas"></g></g></svg>`);
  desenharSVGElementos(editor); desenharSVGMesas(); aplicarZoom();
  ligarPanZoom(area, editor);
}
function desenharSVGElementos(editor) {
  const g = $('#g-elementos'); if (!g) return;
  const cores = { exterior: ['#eef4ea', 'none'], palco: ['#e4e0ee', '#2b2b2b'], pista: ['#ececec', '#2b2b2b'], bar: ['#d6ebe8', '#2f7a73'], buffet: ['#f6e3cc', '#b5651d'],
    cozinha: ['#f4f4f4', '#2b2b2b'], escritorio: ['#fff', '#2b2b2b'], acesso: ['#fff', '#2b2b2b'], zona: ['#fbf2d9', '#b07d1f'], texto: ['none', 'none'], outro: ['#fff', '#6b6b6b'] };
  g.innerHTML = st.elementos.map((e) => {
    const sel = st.editor.sel.has(e.id) ? 'stroke="#b07d1f" stroke-width="3"' : '';
    if (e.tipo === 'parede' && e.pontos) {
      const pts = e.pontos.map(([x, y]) => `${x * S},${y * S}`).join(' ');
      const fina = e.nome === 'fina', trac = e.nome === 'tracejada';
      return `<g class="elemento-svg" data-id="${e.id}"><polyline points="${pts}" fill="none" stroke="${trac ? '#9a9a9a' : '#2b2b2b'}" stroke-width="${fina ? 1.2 : trac ? 2 : 6}" ${trac ? 'stroke-dasharray="10,8"' : ''} stroke-linejoin="round" ${sel}/>
        ${editor ? `<polyline points="${pts}" fill="none" stroke="transparent" stroke-width="14"/>` : ''}</g>`;
    }
    const [f, s] = cores[e.tipo] || cores.outro; const x = e.x * S, y = e.y * S, w = e.largura * S, h = e.altura * S;
    const rot = e.rotacao ? `transform="rotate(${e.rotacao} ${x + w / 2} ${y + h / 2})"` : '';
    const vertical = h > w * 1.6; const fs = Math.min(16, Math.max(9, Math.min(w, h) / 2.2));
    const txt = e.nome ? `<text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" dominant-baseline="central" font-size="${fs}" fill="${e.tipo === 'exterior' ? '#6b6b6b' : '#2b2b2b'}" ${vertical ? `transform="rotate(-90 ${x + w / 2} ${y + h / 2})"` : ''}>${esc(e.nome)}</text>` : '';
    const tri = e.tipo === 'acesso' ? `<polygon points="${x},${y + h} ${x + w / 2},${y} ${x + w},${y + h}" fill="#fff" stroke="#2b2b2b" stroke-width="1.4"/>` : '';
    return `<g class="elemento-svg movel" data-id="${e.id}" ${rot}>${e.tipo === 'acesso' ? tri : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${e.tipo === 'palco' || e.tipo === 'pista' ? 14 : 0}" fill="${f}" stroke="${s}" stroke-width="${e.tipo === 'bar' || e.tipo === 'buffet' ? 2 : 1.4}" ${e.tipo === 'exterior' ? 'stroke="none"' : ''} ${sel}/>`}${e.tipo === 'exterior' ? `<text x="${x + 8}" y="${y + 14}" font-size="12" fill="#6b6b6b">${esc(e.nome)}</text>` : txt}</g>`;
  }).join('');
}
function desenharSVGMesas() {
  const g = $('#g-mesas'); if (!g) return;
  const cores = { livre: 'var(--livre)', parcial: 'var(--parcial)', cheia: 'var(--cheia)', provisoria: 'var(--provisoria)', bloqueada: 'var(--bloqueada)' };
  const sel = st.grupoSel ? grupoPorId(st.grupoSel) : null;
  g.innerHTML = st.mesas.map((m) => {
    const x = m.x * S, y = m.y * S, w = m.comprimento * S, h = m.largura * S, cx = x + w / 2, cy = y + h / 2;
    const ocup = {}; for (const gr of m.grupos || []) for (const l of gr.lugares || []) ocup[l] = gr.grupo_id;
    const r = 0.21 * S, off = 0.32 * S;
    let cadeiras = '';
    const cad = (px, py, n) => `<circle cx="${px}" cy="${py}" r="${r}" fill="${ocup[n] ? corGrupo(ocup[n]) : '#fff'}" stroke="${ocup[n] ? corGrupo(ocup[n]) : '#6b6b6b'}" stroke-width="1.1"/>${m.modo === 'mista' && !ocup[n] ? `<text x="${px}" y="${py}" font-size="7" text-anchor="middle" dominant-baseline="central" fill="#8a8a8a">${n}</text>` : ''}`;
    if (m.forma === 'redonda') {
      for (let n = 1; n <= m.lugares; n++) { const a = (n - 1) / m.lugares * 2 * Math.PI - Math.PI / 2; cadeiras += cad(cx + Math.cos(a) * (w / 2 + off), cy + Math.sin(a) * (h / 2 + off), n); }
    } else if (m.forma === 'lounge') {
      const np = Math.max(1, Math.ceil(m.lugares / 2) - 1);
      for (let n = 1; n <= m.lugares; n++) {
        if (n <= np + 1) { cadeiras += `<rect x="${x + (n - 0.5) * (w / (np + 1)) - 0.15 * S}" y="${y + 0.15 * S}" width="${0.3 * S}" height="${0.45 * S}" rx="3" fill="${ocup[n] ? corGrupo(ocup[n]) : '#fff'}" stroke="#6b6b6b"/>`; }
        else { const k = n - np - 1, tot = m.lugares - np - 1; cadeiras += `<rect x="${x + (k + 0.5) * (w / tot) - 0.4 * S}" y="${y + h - 0.45 * S}" width="${0.8 * S}" height="${0.35 * S}" rx="4" fill="${ocup[n] ? corGrupo(ocup[n]) : '#fff'}" stroke="#2b2b2b"/>`; }
      }
    } else {
      const npares = Math.ceil(m.lugares / 2), passo = w / npares;
      for (let n = 1; n <= m.lugares; n++) { const p = Math.ceil(n / 2), px = x + passo * (p - 0.5); cadeiras += cad(px, n % 2 === 1 ? y - off : y + h + off, n); }
    }
    const nome = (m.grupos || []).map((gr) => gr.cliente_nome).join(' / ');
    const fs = Math.min(13, Math.max(8, w / 7));
    const corpo = m.forma === 'redonda' ? `<ellipse class="corpo" cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}"` : m.forma === 'lounge' ? `<rect class="corpo" x="${x}" y="${y}" width="${w}" height="${h}" rx="4" stroke-dasharray="3,3"` : `<rect class="corpo" x="${x}" y="${y}" width="${w}" height="${h}" rx="4"`;
    const cabe = sel ? (!m.bloqueada && m.lugares - m.ocupados >= sel.pessoas && (m.modo === 'mista' ? sel.pessoas <= st.evento.max_grupo_mista : m.ocupados === 0)) : null;
    const classes = ['mesa-svg', st.mesaSel === m.id || st.editor.sel.has(m.id) ? 'seleccionada' : '', st.destaque === m.id ? 'destaque' : ''].join(' ');
    return `<g class="${classes}" data-id="${m.id}" transform="rotate(${m.rotacao} ${cx} ${cy})" ${sel && !cabe ? 'opacity="0.35"' : ''}>${cadeiras}
      ${corpo} fill="${cores[m.estado] || '#fff'}" stroke="${m.modo === 'mista' ? 'var(--mista)' : '#2b2b2b'}" stroke-width="${m.modo === 'mista' ? 2 : 1.6}"/>
      <text x="${cx}" y="${cy - (nome ? fs * 0.45 : 0)}" text-anchor="middle" dominant-baseline="central" font-size="${fs}" font-weight="700" ${Math.abs(m.rotacao) === 90 ? `transform="rotate(-90 ${cx} ${cy})"` : ''}>${esc(m.codigo)} (${m.lugares})</text>
      ${nome ? `<text x="${cx}" y="${cy + fs * 0.6}" text-anchor="middle" dominant-baseline="central" font-size="${fs * 0.72}" fill="#2b2b2b" ${Math.abs(m.rotacao) === 90 ? `transform="rotate(-90 ${cx} ${cy})"` : ''}>${esc(nome.length > 26 ? nome.slice(0, 24) + '...' : nome)}</text>` : ''}
      ${m.bloqueada ? `<line x1="${x}" y1="${y}" x2="${x + w}" y2="${y + h}" stroke="#888" stroke-width="2"/>` : ''}</g>`;
  }).join('');
}
function aplicarZoom() { const g = $('#g-zoom'); if (g) g.setAttribute('transform', `translate(${st.zoom.x} ${st.zoom.y}) scale(${st.zoom.k})`); }
function zoomAo(f, px, py) {
  const svg = $('#svg-planta'); if (!svg) return;
  const r = svg.getBoundingClientRect(); const W = svg.viewBox.baseVal.width; const esc = W / r.width;
  const cx = px == null ? W / 2 : (px - r.left) * esc, cy = py == null ? svg.viewBox.baseVal.height / 2 : (py - r.top) * esc;
  const k2 = Math.min(8, Math.max(0.4, st.zoom.k * f));
  st.zoom.x = cx - (cx - st.zoom.x) * (k2 / st.zoom.k); st.zoom.y = cy - (cy - st.zoom.y) * (k2 / st.zoom.k); st.zoom.k = k2; aplicarZoom();
}
function ligarPanZoom(area, editor) {
  const svg = $('#svg-planta', area); const pts = new Map(); let arrasto = null, distIni = 0, kIni = 1, moveu = false;
  const paraSVG = (cx, cy) => { const r = svg.getBoundingClientRect(); const esc = svg.viewBox.baseVal.width / r.width; return [(cx - r.left) * esc, (cy - r.top) * esc]; };
  svg.addEventListener('wheel', (e) => { e.preventDefault(); zoomAo(e.deltaY < 0 ? 1.15 : 0.87, e.clientX, e.clientY); }, { passive: false });
  svg.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, e); svg.setPointerCapture(e.pointerId); moveu = false;
    if (pts.size === 2) { const [a, b] = [...pts.values()]; distIni = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); kIni = st.zoom.k; arrasto = null; return; }
    const alvo = e.target.closest('.mesa-svg, .elemento-svg');
    if (editor && alvo && (alvo.classList.contains('mesa-svg') || alvo.classList.contains('movel'))) {
      const [sx, sy] = paraSVG(e.clientX, e.clientY);
      const id = alvo.dataset.id; const obj = alvo.classList.contains('mesa-svg') ? mesaPorId(id) : st.elementos.find((x) => x.id === id);
      arrasto = { tipo: 'objecto', alvo, obj, mesa: alvo.classList.contains('mesa-svg'), x0: sx, y0: sy, ox: Number(obj.x), oy: Number(obj.y) };
    } else { arrasto = { tipo: 'pan', alvo, x0: e.clientX, y0: e.clientY, zx: st.zoom.x, zy: st.zoom.y }; svg.classList.add('a-arrastar'); }
  });
  svg.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, e);
    if (pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); const f = (d / distIni) * kIni / st.zoom.k; if (isFinite(f) && f > 0) zoomAo(f, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2); return; }
    if (!arrasto) return;
    if (arrasto.tipo === 'pan') {
      const r = svg.getBoundingClientRect(); const esc = svg.viewBox.baseVal.width / r.width;
      if (Math.abs(e.clientX - arrasto.x0) + Math.abs(e.clientY - arrasto.y0) > 3) moveu = true;
      st.zoom.x = arrasto.zx + (e.clientX - arrasto.x0) * esc; st.zoom.y = arrasto.zy + (e.clientY - arrasto.y0) * esc; aplicarZoom();
    } else {
      const [sx, sy] = paraSVG(e.clientX, e.clientY); moveu = true;
      const nx = Math.round((arrasto.ox + (sx - arrasto.x0) / st.zoom.k / S) * 10) / 10, ny = Math.round((arrasto.oy + (sy - arrasto.y0) / st.zoom.k / S) * 10) / 10;
      arrasto.nx = nx; arrasto.ny = ny; arrasto.obj.x = nx; arrasto.obj.y = ny;
      if (arrasto.mesa) desenharSVGMesas(); else desenharSVGElementos(true);
    }
  });
  const fim = async (e) => {
    pts.delete(e.pointerId); svg.classList.remove('a-arrastar');
    if (pts.size > 0) { arrasto = null; return; }
    const a = arrasto; arrasto = null;
    if (!a) return;
    if (a.tipo === 'objecto' && moveu && a.nx != null) {
      const fn = a.mesa ? 'mesas_guardar_mesa' : 'mesas_guardar_elemento';
      try { await rpc(fn, { p: { id: a.obj.id, evento_id: st.evento.id, x: a.nx, y: a.ny } }); } catch (err) { aviso(err.message, true); await recarregar(); }
      return;
    }
    if (moveu) return;
    const alvo = a.alvo;   // com captura do ponteiro, e.target seria o svg
    if (editor) { editorClique(alvo, e.shiftKey || e.ctrlKey); return; }
    if (alvo && alvo.classList.contains('mesa-svg')) {
      const id = alvo.dataset.id;
      if (st.grupoSel && podeAlocar()) { const m = mesaPorId(id), gsel = grupoPorId(st.grupoSel); if (m && gsel && !m.bloqueada && m.lugares - m.ocupados >= gsel.pessoas) return sentarEm(st.grupoSel, id); }
      st.mesaSel = st.mesaSel === id ? null : id; st.destaque = null; desenharSVGMesas(); desenharPainel();
    }
  };
  svg.addEventListener('pointerup', fim); svg.addEventListener('pointercancel', fim);
}

// ------------------------------------------------ pesquisa
function pesquisar(texto, saltar = false) {
  const t = texto.trim().toLowerCase(); st.destaque = null;
  if (!t) { desenharSVGMesas(); return; }
  const m = st.mesas.find((x) => x.codigo.toLowerCase() === t);
  let grupo = null;
  if (!m) {
    grupo = st.grupos.find((g) => g.estado !== 'cancelado' && (g.cliente_nome.toLowerCase().includes(t) || (g.cliente_telefone || '').replace(/\s/g, '').includes(t.replace(/\s/g, ''))
      || (st.bilhetes[g.id] || []).some((b) => (b.numero || '').toLowerCase() === t) || (st.bilhetes[g.id] || []).some((b) => (b.nome_pessoa || '').toLowerCase().includes(t))));
  }
  const alvo = m || (grupo && mesaDoGrupo(grupo));
  if (alvo) { st.destaque = alvo.id; if (saltar || st.vista === 'planta') { st.mesaSel = alvo.id; desenharPainel(); } }
  else if (grupo && saltar) { aviso(`${grupo.cliente_nome}: ${nomeEstadoGrupo(grupo.estado)}, ainda sem mesa.`); }
  desenharSVGMesas();
}

// ------------------------------------------------ grupos
function vistaGrupos(v) {
  v.innerHTML = `<div class="pagina">
    <div class="filtros"><label>Estado <select id="f-estado"><option value="">Todos</option><option value="por_sentar">Por sentar</option><option value="provisorio">Provisórios</option><option value="sentado">Sentados</option><option value="cancelado">Cancelados</option></select></label>
      <label>Procurar <input id="f-texto" placeholder="nome, telefone, bilhete"></label>
      ${podeAlocar() ? '<button class="btn primario" id="btn-novo-grupo">Novo grupo</button>' : ''}
      <button class="btn" id="btn-exportar-grupos">Exportar CSV</button></div>
    <div id="lista-grupos"></div></div>`;
  const render = () => {
    const e = $('#f-estado').value, t = $('#f-texto').value.trim().toLowerCase();
    const lista = st.grupos.filter((g) => (!e || g.estado === e) && (!t || g.cliente_nome.toLowerCase().includes(t) || (g.cliente_telefone || '').includes(t) || (st.bilhetes[g.id] || []).some((b) => (b.numero || '').toLowerCase().includes(t))));
    $('#lista-grupos').innerHTML = lista.length ? lista.map((g) => cartaoGrupo(g)).join('') : '<p class="suave">Sem grupos.</p>';
    $$('.cartao-grupo').forEach((c) => c.onclick = () => fichaGrupo(c.dataset.id));
  };
  $('#f-estado').onchange = render; $('#f-texto').oninput = render; render();
  if ($('#btn-novo-grupo')) $('#btn-novo-grupo').onclick = () => formGrupo();
  $('#btn-exportar-grupos').onclick = () => exportarCSV('grupos', ['Cliente', 'Telefone', 'Pessoas', 'Tipo', 'Estado', 'Mesa', 'Lugares', 'Bilhetes', 'Valor', 'Registado por', 'Registado em', 'Observações'],
    st.grupos.map((g) => { const m = mesaDoGrupo(g); const al = m && m.grupos.find((x) => x.grupo_id === g.id); const bs = st.bilhetes[g.id] || [];
      return [g.cliente_nome, g.cliente_telefone, g.pessoas, g.tipo_bilhete, nomeEstadoGrupo(g.estado), m ? m.codigo : '', al ? al.lugares.join(' ') : '', bs.map((b) => b.numero).join(' '), bs.reduce((s, b) => s + Number(b.valor), 0), nomeUtilizador(g.registado_por), dh(g.registado_em), g.observacoes]; }));
}

function formGrupo(g = null) {
  const soContacto = daEncomenda(g);
  const precos = st.evento.precos || {}; const tipos = ['Normal', ...Object.keys(precos).filter((k) => k !== 'Normal' && k !== 'zonas' && k !== 'Convite'), 'Convite'];
  const bs = g ? (st.bilhetes[g.id] || []) : [];
  const c = modal(`<h2>${g ? 'Corrigir grupo' : 'Novo grupo'}</h2><form id="form-grupo">
    <div class="grelha2"><label>Nome do cliente <input name="cliente_nome" required value="${esc(g?.cliente_nome)}"></label>
      <label>Telefone <input name="cliente_telefone" value="${esc(g?.cliente_telefone)}" inputmode="tel"></label>
      <label>Pessoas <input name="pessoas" type="number" min="1" max="60" required value="${g?.pessoas || 2}" ${soContacto ? 'readonly' : ''}></label>
      <label>Tipo de bilhete <select name="tipo_bilhete" ${soContacto ? 'disabled' : ''}>${tipos.map((t) => `<option ${g?.tipo_bilhete === t ? 'selected' : ''} ${t === 'Convite' && !gestao() ? 'disabled' : ''}>${esc(t)}</option>`).join('')}</select></label></div>
    <label class="so-convite escondido">Convidado por <input name="convidado_por" value="${esc(g?.convidado_por)}"></label>
    <label>Observações (aniversário, crianças, cadeira de rodas) <input name="observacoes" value="${esc(g?.observacoes)}"></label>
    <label>Quer ficar perto de <select name="perto_de_grupo_id"><option value="">ninguém em especial</option>${st.grupos.filter((x) => x.estado !== 'cancelado' && x.id !== g?.id).map((x) => `<option value="${x.id}" ${g?.perto_de_grupo_id === x.id ? 'selected' : ''}>${esc(x.cliente_nome)}</option>`).join('')}</select></label>
    ${soContacto ? '<p class="suave">Os bilhetes e valores vêm da encomenda e não se alteram aqui; para isso use o painel de vendas (reemitir, transferir, cancelar).</p>' : `<h3>Bilhetes e valores cobrados</h3>
    <div id="bilhetes"></div>
    <div class="linha-btns"><label style="margin:0"><input type="checkbox" id="chk-mesmo" style="width:auto" checked> Mesmo valor e pagamento em todos</label></div>`}
    ${g ? '<label>Motivo da correcção <input name="motivo" required></label>' : ''}
    <div class="linha-btns"><button class="btn primario" type="submit">${g ? 'Guardar correcção' : 'Registar grupo'}</button><button class="btn" type="button" id="cancelar-grupo">Cancelar</button></div>
    <p class="erro" id="erro-grupo"></p></form>`);
  const f = $('#form-grupo', c);
  const linhasBilhetes = () => {
    const n = Number(f.pessoas.value) || 0; const tipo = f.tipo_bilhete.value; const preco = precos[tipo];
    const existentes = $$('.bilhete-linha', f).map(lerBilhete);
    $('#bilhetes', f).innerHTML = Array.from({ length: n }, (_, i) => { const b = existentes[i] || bs[i] || {}; const v = b.valor ?? (tipo === 'Convite' ? 0 : preco ?? '');
      return `<div class="bilhete-linha"><label>Bilhete ${i + 1} <input name="numero" value="${esc(b.numero)}" placeholder="n.º"></label>
        <label>Nome (opcional) <input name="nome_pessoa" value="${esc(b.nome_pessoa)}"></label>
        <label>Valor (MT) <input name="valor" type="number" step="0.01" min="0" value="${esc(v)}" ${tipo === 'Convite' ? 'readonly' : ''}></label>
        <label>Pagamento <select name="forma_pagamento"><option value="">...</option>${['Numerário', 'POS', 'M-Pesa', 'e-Mola', 'Transferência'].map((p) => `<option ${b.forma_pagamento === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
        <label>Referência <input name="referencia" value="${esc(b.referencia)}"></label><label>Doc. fiscal <input name="documento_fiscal" value="${esc(b.documento_fiscal)}"></label>
        <label class="so-motivo ${preco != null && Number(v) !== Number(preco) ? '' : 'escondido'}">Motivo do valor <input name="motivo_valor" value="${esc(b.motivo_valor)}"></label></div>`; }).join('');
    $$('.bilhete-linha', f).forEach((l, i) => {
      l.querySelector('[name=valor]').oninput = (e) => { const mo = l.querySelector('.so-motivo'); mo.classList.toggle('escondido', preco == null || Number(e.target.value) === Number(preco)); if (i === 0 && $('#chk-mesmo', f).checked) copiarPrimeiro(); };
      l.querySelector('[name=forma_pagamento]').onchange = () => { if (i === 0 && $('#chk-mesmo', f).checked) copiarPrimeiro(); };
    });
    $('.so-convite', f).classList.toggle('escondido', tipo !== 'Convite');
  };
  const copiarPrimeiro = () => { const ls = $$('.bilhete-linha', f); if (ls.length < 2) return; const a = lerBilhete(ls[0]);
    ls.slice(1).forEach((l) => { l.querySelector('[name=valor]').value = a.valor; l.querySelector('[name=forma_pagamento]').value = a.forma_pagamento; l.querySelector('[name=referencia]').value = a.referencia; l.querySelector('[name=documento_fiscal]').value = a.documento_fiscal; l.querySelector('[name=motivo_valor]').value = a.motivo_valor; }); };
  if (soContacto) { f.cliente_nome.readOnly = true; } else { f.pessoas.oninput = linhasBilhetes; f.tipo_bilhete.onchange = linhasBilhetes; linhasBilhetes(); }
  $('#cancelar-grupo', c).onclick = fecharModal;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const p = soContacto
      ? { cliente_telefone: f.cliente_telefone.value, observacoes: f.observacoes.value, perto_de_grupo_id: f.perto_de_grupo_id.value || null }
      : { evento_id: st.evento.id, cliente_nome: f.cliente_nome.value, cliente_telefone: f.cliente_telefone.value, pessoas: Number(f.pessoas.value),
          tipo_bilhete: f.tipo_bilhete.value, convidado_por: f.convidado_por.value, observacoes: f.observacoes.value, perto_de_grupo_id: f.perto_de_grupo_id.value || null,
          bilhetes: $$('.bilhete-linha', f).map(lerBilhete) };
    try {
      if (g) { await rpc('mesas_corrigir_grupo', { p_grupo: g.id, p: p, p_motivo: f.motivo.value }); fecharModal(); aviso('Grupo corrigido.'); await recarregar(); return; }
      const id = await rpc('mesas_registar_grupo', { p });
      fecharModal(); await recarregar(); st.grupoSel = id;
      if (st.vista !== 'planta') location.hash = '#planta'; else desenharPainel();
      sugerirESentar(id);
    } catch (err) { $('#erro-grupo', c).textContent = err.message; }
  };
}
const lerBilhete = (l) => ({ numero: l.querySelector('[name=numero]').value.trim(), nome_pessoa: l.querySelector('[name=nome_pessoa]').value.trim(), valor: Number(l.querySelector('[name=valor]').value || 0),
  forma_pagamento: l.querySelector('[name=forma_pagamento]').value, referencia: l.querySelector('[name=referencia]').value.trim(), documento_fiscal: l.querySelector('[name=documento_fiscal]').value.trim(), motivo_valor: l.querySelector('[name=motivo_valor]').value.trim() });

async function fichaGrupo(id) {
  const g = grupoPorId(id); if (!g) return;
  const m = mesaDoGrupo(g); const al = m && m.grupos.find((x) => x.grupo_id === g.id); const bs = st.bilhetes[g.id] || [];
  let hist = []; try { const r = await sb.from('mesas_historico').select('*').eq('grupo_id', g.id).order('em', { ascending: false }).limit(30); hist = r.data || []; } catch {}
  const c = modal(`<h2>${esc(g.cliente_nome)} <span class="etiqueta ${g.estado}">${nomeEstadoGrupo(g.estado)}</span>${badgeEnc(g)}</h2>
    ${daEncomenda(g) ? `<p class="suave">Grupo criado pela compra no sistema de bilhetes. As pessoas, os bilhetes e os valores acompanham a encomenda (reemissões, transferências e cancelamentos reflectem-se aqui). ${gestao() ? `<a href="../admin/#vendas/${esc(st.evento.bilhetes_evento_id || '')}" target="_blank">Abrir as vendas</a>` : ''}</p>` : ''}
    <p>${g.pessoas} pessoas, ${esc(g.tipo_bilhete)}${g.convidado_por ? ' (convidado por ' + esc(g.convidado_por) + ')' : ''}${g.cliente_telefone ? ', ' + telefone(g.cliente_telefone) : ''}</p>
    <p>${m ? `Mesa <b>${esc(m.codigo)}</b>, lugares ${al.lugares.join(', ')}${g.estado === 'provisorio' ? ', reserva provisória até ' + dh(g.prazo_provisorio) : ''}` : 'Ainda sem mesa.'}</p>
    ${g.observacoes ? `<p>${esc(g.observacoes)}</p>` : ''}
    <p class="suave">Registado por ${esc(nomeUtilizador(g.registado_por))} em ${dh(g.registado_em)}${g.chegou_em ? '. Chegou às ' + dh(g.chegou_em) : ''}</p>
    ${bs.length ? `<table class="dados"><tr><th>Bilhete</th><th>Nome</th><th>Valor</th><th>Pagamento</th><th>Ref.</th></tr>${bs.map((b) => `<tr><td>${esc(b.numero)}</td><td>${esc(b.nome_pessoa)}</td><td>${mt(b.valor)}${b.motivo_valor ? ' (' + esc(b.motivo_valor) + ')' : ''}</td><td>${esc(b.forma_pagamento)}</td><td>${esc(b.referencia)}${b.documento_fiscal ? ' / ' + esc(b.documento_fiscal) : ''}</td></tr>`).join('')}
      <tr><td colspan="2"><b>Total</b></td><td colspan="3"><b>${mt(bs.reduce((s, b) => s + Number(b.valor), 0))}</b></td></tr></table>` : '<p class="suave">Sem bilhetes registados' + (gestao() || meu(g) ? '.' : ' visíveis.') + '</p>'}
    <div class="linha-btns">
      ${g.estado === 'por_sentar' && podeAlocar() ? `<button class="btn primario" id="g-sentar">Sentar</button>` : ''}
      ${m && podeAlocar() && (gestao() || meu(g)) ? `<button class="btn" id="g-mudar">Mudar de mesa</button>` : ''}
      ${g.estado === 'provisorio' && podeAlocar() ? `<button class="btn" id="g-confirmar">Confirmar reserva</button>` : ''}
      ${m && gestao() ? `<button class="btn" id="g-trocar">Trocar com outro grupo</button>` : ''}
      ${gestao() ? `<button class="btn" id="g-corrigir">Corrigir</button>` : ''}
      ${g.estado !== 'cancelado' ? `<button class="btn" id="g-chegou">${g.chegou_em ? 'Anular chegada' : 'Marcar chegada'}</button>` : ''}
      ${gestao() && g.estado !== 'cancelado' && !daEncomenda(g) ? `<button class="btn perigo" id="g-cancelar">Cancelar grupo</button>` : ''}
      <button class="btn" id="g-fechar">Fechar</button></div>
    ${hist.length ? `<h3>Histórico</h3><table class="dados">${hist.map((h) => `<tr><td>${dh(h.em)}</td><td>${esc(h.utilizador_nome || 'sistema')}</td><td>${esc(nomeAccao(h.accao))}${h.mesa_codigo ? ', mesa ' + esc(h.mesa_codigo) : ''}${h.motivo ? ': ' + esc(h.motivo) : ''}</td></tr>`).join('')}</table>` : ''}`);
  const irParaPlanta = () => { fecharModal(); st.grupoSel = g.id; st.mesaSel = null; if (st.vista !== 'planta') location.hash = '#planta'; else { desenharPainel(); desenharSVGMesas(); } };
  if ($('#g-sentar', c)) $('#g-sentar', c).onclick = () => { fecharModal(); st.grupoSel = g.id; if (st.vista !== 'planta') location.hash = '#planta'; sugerirESentar(g.id); };
  if ($('#g-mudar', c)) $('#g-mudar', c).onclick = irParaPlanta;
  if ($('#g-confirmar', c)) $('#g-confirmar', c).onclick = () => { fecharModal(); tentar(() => rpc('mesas_confirmar_provisoria', { p_grupo: g.id }), 'Reserva confirmada.'); };
  if ($('#g-trocar', c)) $('#g-trocar', c).onclick = () => {
    const outros = st.grupos.filter((x) => x.id !== g.id && ['sentado', 'provisorio'].includes(x.estado));
    const c2 = modal(`<h2>Trocar ${esc(g.cliente_nome)} de mesa com...</h2><label>Grupo <select id="tr-outro">${outros.map((x) => { const mx = mesaDoGrupo(x); return `<option value="${x.id}">${esc(x.cliente_nome)} (${x.pessoas}), mesa ${mx ? esc(mx.codigo) : '?'}</option>`; }).join('')}</select></label>
      <p class="suave">Cada grupo passa para a mesa do outro. Os dois têm de caber.</p><div class="linha-btns"><button class="btn primario" id="tr-ok">Trocar</button><button class="btn" id="tr-nao">Cancelar</button></div>`);
    $('#tr-nao', c2).onclick = fecharModal;
    $('#tr-ok', c2).onclick = () => { const o = $('#tr-outro', c2).value; if (!o) return; fecharModal(); tentar(() => rpc('mesas_trocar', { p_grupo_a: g.id, p_grupo_b: o }), 'Grupos trocados.'); };
  };
  if ($('#g-corrigir', c)) $('#g-corrigir', c).onclick = () => formGrupo(g);
  if ($('#g-chegou', c)) $('#g-chegou', c).onclick = () => { fecharModal(); tentar(() => rpc('mesas_marcar_chegada', { p_grupo: g.id, p_chegou: !g.chegou_em }), g.chegou_em ? 'Chegada anulada.' : 'Chegada marcada.'); };
  if ($('#g-cancelar', c)) $('#g-cancelar', c).onclick = async () => { fecharModal(); const mo = await confirmar('Cancelar grupo', 'O grupo sai da lista e a mesa fica livre. Os bilhetes ficam no histórico.', 'Cancelar grupo', true); if (mo) tentar(() => rpc('mesas_cancelar_grupo', { p_grupo: g.id, p_motivo: mo }), 'Grupo cancelado.'); };
  $('#g-fechar', c).onclick = fecharModal;
}
const nomeAccao = (a) => ({ grupo_registado: 'grupo registado', grupo_corrigido: 'grupo corrigido', alocado: 'sentado', reserva_provisoria: 'reserva provisória', reserva_confirmada: 'reserva confirmada',
  reserva_expirada: 'reserva expirada', alocacao_anulada: 'alocação anulada', mudou_de_mesa: 'mudou de mesa', troca_de_grupos: 'troca de grupos', grupo_cancelado: 'grupo cancelado', chegou: 'chegou', chegada_anulada: 'chegada anulada',
  mesa_criada: 'mesa criada', mesa_alterada: 'mesa alterada', mesa_apagada: 'mesa apagada', mesa_bloqueada: 'mesa bloqueada', mesa_desbloqueada: 'mesa desbloqueada', mesas_juntas: 'mesas juntas', mesas_separadas: 'mesas separadas',
  tipo_criado: 'tipo de mesa criado', tipo_alterado: 'tipo de mesa alterado', planta_fechada: 'planta fechada', planta_reaberta: 'planta reaberta', versao_guardada: 'versão guardada', versao_reposta: 'versão reposta',
  evento_criado: 'evento criado', evento_alterado: 'evento alterado', planta_copiada: 'planta copiada' }[a] || a);

// ------------------------------------------------ listas e relatórios
function vistaListas(v) {
  const r = st.resumo || {};
  const sentados = st.grupos.filter((g) => ['sentado', 'provisorio'].includes(g.estado));
  const porMesa = st.mesas.filter((m) => (m.grupos || []).length);
  const pessoas = []; for (const g of st.grupos) if (g.estado !== 'cancelado') { const m = mesaDoGrupo(g); pessoas.push([g.cliente_nome, m ? m.codigo : '', g.pessoas, g]); for (const b of st.bilhetes[g.id] || []) if (b.nome_pessoa) pessoas.push([b.nome_pessoa, m ? m.codigo : '', '', g]); }
  pessoas.sort((a, b) => a[0].localeCompare(b[0], 'pt'));
  v.innerHTML = `<div class="pagina">
    <div class="filtros"><label>Lista <select id="l-tipo"><option value="mesa">Por mesa (chefe de sala e garçons)</option><option value="alfabetica">Alfabética (porta)</option><option value="cozinha">Contagens (cozinha e bares)</option><option value="fecho">Relatório de fecho</option><option value="material">Material (mesas e cadeiras)</option></select></label>
      <button class="btn" id="l-imprimir">Imprimir</button><button class="btn" id="l-csv">Exportar CSV</button><a class="btn" href="#planta" id="l-planta">Imprimir planta</a></div>
    <h1 class="so-impressao">${esc(st.evento.nome)}</h1>
    <div id="l-conteudo"></div></div>`;
  const render = () => {
    const t = $('#l-tipo').value; let html = '', csv = null;
    if (t === 'mesa') {
      html = `<h2>Lista por mesa</h2><table class="dados"><tr><th>Mesa</th><th>Lugares</th><th>Grupo</th><th>Pessoas</th><th>Nomes</th><th>Observações</th></tr>` + porMesa.map((m) => (m.grupos).map((x, i) => { const g = grupoPorId(x.grupo_id) || {}; const nomes = (st.bilhetes[x.grupo_id] || []).map((b) => b.nome_pessoa).filter(Boolean).join(', ');
        return `<tr>${i === 0 ? `<td rowspan="${m.grupos.length}"><b>${esc(m.codigo)}</b>${m.modo === 'mista' ? ' (mista)' : ''}</td>` : ''}<td>${x.lugares.join(', ')}</td><td>${esc(x.cliente_nome)}${x.estado === 'provisoria' ? ' (provisório)' : ''}</td><td>${x.pessoas}</td><td>${esc(nomes)}</td><td>${esc(g.observacoes)}</td></tr>`; }).join('')).join('') + '</table>';
      csv = ['mesa', ['Mesa', 'Lugares', 'Grupo', 'Pessoas', 'Nomes', 'Observações'], porMesa.flatMap((m) => m.grupos.map((x) => [m.codigo, x.lugares.join(' '), x.cliente_nome, x.pessoas, (st.bilhetes[x.grupo_id] || []).map((b) => b.nome_pessoa).filter(Boolean).join(', '), (grupoPorId(x.grupo_id) || {}).observacoes]))];
    } else if (t === 'alfabetica') {
      html = `<h2>Lista alfabética</h2><table class="dados"><tr><th>Nome</th><th>Mesa</th><th>Pessoas</th><th>Estado</th><th>Chegou</th></tr>` + pessoas.map(([n, m, p, g]) => `<tr><td>${esc(n)}</td><td><b>${esc(m) || '(sem mesa)'}</b></td><td>${p}</td><td>${nomeEstadoGrupo(g.estado)}</td><td>${g.chegou_em ? 'sim' : ''}</td></tr>`).join('') + '</table>';
      csv = ['alfabetica', ['Nome', 'Mesa', 'Pessoas', 'Estado'], pessoas.map(([n, m, p, g]) => [n, m, p, nomeEstadoGrupo(g.estado)])];
    } else if (t === 'cozinha') {
      const obs = st.grupos.filter((g) => g.estado !== 'cancelado' && g.observacoes);
      html = `<h2>Contagens</h2><p>Pessoas registadas: <b>${r.pessoas_registadas}</b>. Sentadas: <b>${r.pessoas_sentadas}</b>. Lugares na sala: <b>${r.lugares}</b>.</p>
        <h3>Por sector</h3><table class="dados"><tr><th>Sector</th><th>Mesas</th><th>Lugares</th><th>Pessoas sentadas</th></tr>${Object.entries(st.mesas.reduce((a, m) => { const k = m.sector || 'sem sector'; a[k] ||= [0, 0, 0]; a[k][0]++; a[k][1] += m.lugares; a[k][2] += m.ocupados; return a; }, {})).map(([k, [n, l, o]]) => `<tr><td>${esc(k)}</td><td>${n}</td><td>${l}</td><td>${o}</td></tr>`).join('')}</table>
        <h3>Pedidos especiais</h3>${obs.length ? `<table class="dados"><tr><th>Mesa</th><th>Grupo</th><th>Observação</th></tr>${obs.map((g) => { const m = mesaDoGrupo(g); return `<tr><td>${m ? esc(m.codigo) : ''}</td><td>${esc(g.cliente_nome)} (${g.pessoas})</td><td>${esc(g.observacoes)}</td></tr>`; }).join('')}</table>` : '<p class="suave">Nenhum.</p>'}`;
    } else if (t === 'fecho') {
      const porCaixa = {}; for (const g of st.grupos) if (g.estado !== 'cancelado') { const k = nomeUtilizador(g.registado_por); porCaixa[k] ||= { grupos: 0, pessoas: 0, valor: 0 }; porCaixa[k].grupos++; porCaixa[k].pessoas += g.pessoas; porCaixa[k].valor += (st.bilhetes[g.id] || []).reduce((s, b) => s + Number(b.valor), 0); }
      html = `<h2>Relatório de fecho</h2><p>Gerado em ${dh(new Date())}.</p>
        <table class="dados"><tr><th>Indicador</th><th>Valor</th></tr><tr><td>Grupos registados</td><td>${r.grupos}</td></tr><tr><td>Pessoas registadas</td><td>${r.pessoas_registadas}</td></tr><tr><td>Pessoas sentadas</td><td>${r.pessoas_sentadas}</td></tr><tr><td>Lugares na planta</td><td>${r.lugares}</td></tr><tr><td>Ocupação</td><td>${r.lugares ? Math.round(100 * r.ocupados / r.lugares) : 0}%</td></tr><tr><td>Receita registada${gestao() ? '' : ' (minha)'}</td><td><b>${mt(r.receita)}</b></td></tr></table>
        <h3>Receita por forma de pagamento</h3><table class="dados">${Object.entries(r.receita_por_pagamento || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${mt(v)}</td></tr>`).join('') || '<tr><td>Sem dados</td></tr>'}</table>
        <h3>Receita por tipo de bilhete</h3><table class="dados">${Object.entries(r.receita_por_tipo || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${mt(v)}</td></tr>`).join('') || '<tr><td>Sem dados</td></tr>'}</table>
        <h3>Por caixa</h3><table class="dados"><tr><th>Caixa</th><th>Grupos</th><th>Pessoas</th><th>Valor registado</th></tr>${Object.entries(porCaixa).map(([k, x]) => `<tr><td>${esc(k)}</td><td>${x.grupos}</td><td>${x.pessoas}</td><td>${mt(x.valor)}</td></tr>`).join('')}</table>
        <h3>Ocupação por mesa</h3><table class="dados"><tr><th>Mesa</th><th>Lugares</th><th>Ocupados</th><th>Estado</th></tr>${st.mesas.map((m) => `<tr><td>${esc(m.codigo)}</td><td>${m.lugares}</td><td>${m.ocupados}</td><td>${nomeEstadoMesa(m.estado)}</td></tr>`).join('')}</table>`;
      csv = ['fecho_mesas', ['Mesa', 'Lugares', 'Ocupados', 'Estado'], st.mesas.map((m) => [m.codigo, m.lugares, m.ocupados, nomeEstadoMesa(m.estado)])];
    } else {
      html = `<h2>Material necessário</h2><table class="dados resumo-material"><tr><th>Tipo de mesa</th><th>Mesas na planta</th><th>Lugares</th><th>Em inventário</th><th>Faltam alugar</th></tr>${(r.por_tipo || []).map((t) => `<tr><td>${esc(t.nome)}</td><td>${t.mesas}</td><td>${t.lugares}</td><td>${t.inventario}</td><td>${t.faltam ? '<b>' + t.faltam + '</b>' : '0'}</td></tr>`).join('')}
        <tr><td><b>Cadeiras</b></td><td></td><td><b>${r.cadeiras}</b></td><td colspan="2">mais 5% de reserva: ${Math.ceil(r.cadeiras * 1.05)}</td></tr></table><p class="suave">O inventário por tipo define-se em Definições.</p>`;
      csv = ['material', ['Tipo', 'Mesas', 'Lugares', 'Inventário', 'Faltam'], (r.por_tipo || []).map((t) => [t.nome, t.mesas, t.lugares, t.inventario, t.faltam])];
    }
    $('#l-conteudo').innerHTML = html; $('#l-csv').onclick = () => csv ? exportarCSV(...csv) : aviso('Esta lista não tem exportação.');
  };
  $('#l-tipo').onchange = render; render();
  $('#l-imprimir').onclick = () => window.print();
  $('#l-planta').onclick = () => setTimeout(() => window.print(), 600);
}
function exportarCSV(nome, cabecalho, linhas) {
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = '﻿' + [cabecalho, ...linhas].map((l) => l.map(q).join(';')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = `${nome}_${st.evento.nome.replace(/\W+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
}

// ------------------------------------------------ histórico
async function vistaHistorico(v) {
  v.innerHTML = `<div class="pagina"><div class="filtros"><label>Procurar <input id="h-texto" placeholder="cliente, mesa, bilhete, utilizador"></label>
    <label>Acção <select id="h-accao"><option value="">Todas</option></select></label><label>De <input type="date" id="h-de"></label><label>Até <input type="date" id="h-ate"></label>
    <button class="btn" id="h-csv">Exportar CSV</button></div><p class="suave">${gestao() ? 'Todas as acções do evento, das mais recentes para as mais antigas (até 2 000).' : 'As suas acções e as dos seus grupos.'}</p><div id="h-lista"></div></div>`;
  const { data, error } = await sb.from('mesas_historico').select('*').eq('evento_id', st.evento.id).order('em', { ascending: false }).limit(2000);
  if (error) return $('#h-lista').textContent = error.message;
  const accoes = [...new Set(data.map((h) => h.accao))]; $('#h-accao').innerHTML += accoes.map((a) => `<option value="${a}">${esc(nomeAccao(a))}</option>`).join('');
  const linha = (h) => [dh(h.em), h.utilizador_nome || 'sistema', nomeAccao(h.accao), h.mesa_codigo, h.cliente_nome, (h.bilhetes || []).join(' '), h.valor, h.motivo, h.antes ? JSON.stringify(h.antes) : '', h.depois ? JSON.stringify(h.depois) : ''];
  const render = () => {
    const t = $('#h-texto').value.trim().toLowerCase(), a = $('#h-accao').value, de = $('#h-de').value, ate = $('#h-ate').value;
    const lista = data.filter((h) => (!a || h.accao === a) && (!de || h.em >= de) && (!ate || h.em <= ate + 'T23:59:59') && (!t || [h.cliente_nome, h.mesa_codigo, h.utilizador_nome, (h.bilhetes || []).join(' '), h.motivo].join(' ').toLowerCase().includes(t)));
    $('#h-lista').innerHTML = `<table class="dados"><tr><th>Quando</th><th>Quem</th><th>Acção</th><th>Mesa</th><th>Cliente</th><th>Bilhetes</th><th>Valor</th><th>Motivo / detalhe</th></tr>${lista.map((h) => `<tr class="${h.grupo_id ? 'clicavel' : ''}" data-g="${h.grupo_id || ''}"><td>${dh(h.em)}</td><td>${esc(h.utilizador_nome || 'sistema')}</td><td>${esc(nomeAccao(h.accao))}</td><td>${esc(h.mesa_codigo)}</td><td>${esc(h.cliente_nome)}</td><td>${esc((h.bilhetes || []).join(', '))}</td><td>${h.valor != null ? mt(h.valor) : ''}</td><td>${esc(h.motivo)}${detalhe(h)}</td></tr>`).join('')}</table>`;
    $$('tr.clicavel', $('#h-lista')).forEach((tr) => tr.onclick = () => grupoPorId(tr.dataset.g) && fichaGrupo(tr.dataset.g));
    $('#h-csv').onclick = () => exportarCSV('historico', ['Quando', 'Quem', 'Acção', 'Mesa', 'Cliente', 'Bilhetes', 'Valor', 'Motivo', 'Antes', 'Depois'], lista.map(linha));
  };
  ['h-texto', 'h-accao', 'h-de', 'h-ate'].forEach((id) => $('#' + id).oninput = render); render();
}
const detalhe = (h) => { if (h.accao === 'mudou_de_mesa' && h.antes && h.depois) return `<span class="suave"> de ${esc(h.antes.mesa)} para ${esc(h.depois.mesa)}</span>`; if (h.depois && h.depois.lugares) return `<span class="suave"> lugares ${h.depois.lugares.join(', ')}</span>`; return ''; };

// ------------------------------------------------ editor da planta (gestão)
function vistaEditor(v) {
  v.innerHTML = `<div class="ecra-editor"><div class="barra-editor">
      <select id="e-tipo">${st.tipos.filter((t) => t.activo).map((t) => `<option value="${t.id}">${esc(t.nome)}</option>`).join('')}</select>
      <button class="btn" id="e-add-mesa">Acrescentar mesa</button>
      <select id="e-elem"><option value="bar">Bar</option><option value="buffet">Buffet</option><option value="palco">Palco</option><option value="pista">Pista</option><option value="cozinha">Cozinha</option><option value="escritorio">Escritório</option><option value="acesso">Acesso</option><option value="zona">Zona</option><option value="outro">Outro</option></select>
      <button class="btn" id="e-add-elem">Acrescentar elemento</button>
      <button class="btn" id="e-juntar" disabled>Juntar mesas</button>
      <button class="btn" id="e-versao">Guardar versão</button><button class="btn" id="e-versoes">Versões</button>
      <button class="btn ${st.evento.planta_fechada ? 'primario' : ''}" id="e-fechar">${st.evento.planta_fechada ? 'Reabrir planta' : 'Fechar planta'}</button>
      <span class="suave">Arraste para mover (grelha de 10 cm). Toque para seleccionar; com Shift selecciona várias.</span></div>
    <div class="ecra-planta"><div class="area-planta" id="area-planta"><div class="zoom"><button class="btn" id="z-mais">+</button><button class="btn" id="z-menos">-</button><button class="btn" id="z-tudo">&#8982;</button></div></div><aside class="painel" id="painel-editor"></aside></div></div>`;
  st.editor.sel.clear(); desenharSVG($('#area-planta'), true);
  $('#z-mais').onclick = () => zoomAo(1.25); $('#z-menos').onclick = () => zoomAo(0.8); $('#z-tudo').onclick = () => { st.zoom = { k: 1, x: 0, y: 0 }; aplicarZoom(); };
  $('#e-add-mesa').onclick = () => tentar(() => rpc('mesas_guardar_mesa', { p: { evento_id: st.evento.id, tipo_id: $('#e-tipo').value, x: centroVisivel()[0], y: centroVisivel()[1] } }), 'Mesa acrescentada. Arraste-a para o sítio.');
  $('#e-add-elem').onclick = () => { const t = $('#e-elem').value; tentar(() => rpc('mesas_guardar_elemento', { p: { evento_id: st.evento.id, tipo: t, nome: $('#e-elem').selectedOptions[0].text, x: centroVisivel()[0], y: centroVisivel()[1], largura: t === 'zona' ? 6 : 3, altura: t === 'zona' ? 6 : 1.5 } }), 'Elemento acrescentado.'); };
  $('#e-juntar').onclick = () => tentar(() => rpc('mesas_juntar', { p_mesas: [...st.editor.sel].filter(mesaPorId), p_codigo: null }), 'Mesas juntas.');
  $('#e-versao').onclick = async () => { const c = modal('<h2>Guardar versão da planta</h2><label>Nome <input id="v-nome" placeholder="ex. v3 depois das medições"></label><div class="linha-btns"><button class="btn primario" id="v-ok">Guardar</button><button class="btn" id="v-nao">Cancelar</button></div>'); $('#v-nao', c).onclick = fecharModal; $('#v-ok', c).onclick = () => { const n = $('#v-nome', c).value.trim(); if (!n) return; fecharModal(); tentar(() => rpc('mesas_guardar_versao', { p_evento: st.evento.id, p_nome: n }), 'Versão guardada.'); }; };
  $('#e-versoes').onclick = async () => {
    const { data } = await sb.from('mesas_planta_versoes').select('id,nome,criada_em,criada_por').eq('evento_id', st.evento.id).order('criada_em', { ascending: false });
    const c = modal(`<h2>Versões da planta</h2>${(data || []).length ? data.map((x) => `<div class="cartao"><b>${esc(x.nome)}</b> <span class="suave">${dh(x.criada_em)}, ${esc(nomeUtilizador(x.criada_por))}</span><div class="linha-btns"><button class="btn pequeno v-repor" data-id="${x.id}">Repor esta versão</button></div></div>`).join('') : '<p class="suave">Ainda não há versões guardadas.</p>'}<div class="linha-btns"><button class="btn" id="v-fechar">Fechar</button></div>`);
    $('#v-fechar', c).onclick = fecharModal;
    $$('.v-repor', c).forEach((b) => b.onclick = async () => { fecharModal(); if (await confirmar('Repor versão', 'A planta actual é substituída. Mesas com pessoas sentadas mantêm-se.', 'Repor')) tentar(() => rpc('mesas_repor_versao', { p_versao: b.dataset.id }), 'Versão reposta.'); });
  };
  $('#e-fechar').onclick = async () => { const f = !st.evento.planta_fechada; if (await confirmar(f ? 'Fechar planta' : 'Reabrir planta', f ? 'Depois de fechada só se alocam grupos; a disposição não muda.' : 'A planta volta a poder ser alterada.', f ? 'Fechar' : 'Reabrir')) tentar(() => rpc('mesas_fechar_planta', { p_evento: st.evento.id, p_fechar: f }), f ? 'Planta fechada.' : 'Planta reaberta.'); };
  painelEditor();
}
function centroVisivel() { const svg = $('#svg-planta'); const W = svg.viewBox.baseVal.width, H = svg.viewBox.baseVal.height; return [Math.round(((W / 2 - st.zoom.x) / st.zoom.k / S) * 10) / 10, Math.round(((H / 2 - st.zoom.y) / st.zoom.k / S) * 10) / 10]; }
function editorClique(alvo, multi) {
  if (!alvo) { if (!multi) st.editor.sel.clear(); }
  else { const id = alvo.dataset.id; if (multi) { st.editor.sel.has(id) ? st.editor.sel.delete(id) : st.editor.sel.add(id); } else { const so = st.editor.sel.size === 1 && st.editor.sel.has(id); st.editor.sel.clear(); if (!so) st.editor.sel.add(id); } }
  desenharSVGMesas(); desenharSVGElementos(true); painelEditor();
}
function painelEditor() {
  const p = $('#painel-editor'); if (!p) return;
  const ids = [...st.editor.sel]; const mesas = ids.map(mesaPorId).filter(Boolean); const elems = ids.map((i) => st.elementos.find((e) => e.id === i)).filter(Boolean);
  $('#e-juntar').disabled = mesas.length < 2;
  const r = st.resumo || {};
  if (!mesas.length && !elems.length) {
    p.innerHTML = `<h3>Planta: ${r.mesas || 0} mesas, ${r.lugares || 0} lugares</h3>
      <table class="dados resumo-material"><tr><th>Tipo</th><th>Mesas</th><th>Lugares</th><th>Faltam</th></tr>${(r.por_tipo || []).map((t) => `<tr><td>${esc(t.nome)}</td><td>${t.mesas}</td><td>${t.lugares}</td><td>${t.faltam || ''}</td></tr>`).join('')}</table>
      <p class="suave">Lugares em mesas mistas: ${r.lugares_mistas || 0}. Bloqueados: ${r.lugares_bloqueados || 0}. Lotação-alvo: ${st.evento.lotacao_alvo}.</p>
      <p class="suave">Toque numa mesa ou elemento para o alterar.</p>`; return;
  }
  if (mesas.length > 1) { p.innerHTML = `<h3>${mesas.length} mesas seleccionadas</h3><p>${mesas.map((m) => m.codigo).join(', ')}: ${mesas.reduce((s, m) => s + m.lugares, 0)} lugares.</p><div class="linha-btns"><button class="btn primario" id="pe-juntar">Juntar numa só</button><button class="btn" id="pe-mista">Todas mistas</button><button class="btn" id="pe-excl">Todas exclusivas</button></div>`;
    $('#pe-juntar').onclick = () => $('#e-juntar').click();
    $('#pe-mista').onclick = () => tentar(async () => { for (const m of mesas) await rpc('mesas_guardar_mesa', { p: { id: m.id, evento_id: st.evento.id, modo: 'mista' } }); }, 'Mesas passadas a mistas.');
    $('#pe-excl').onclick = () => tentar(async () => { for (const m of mesas) await rpc('mesas_guardar_mesa', { p: { id: m.id, evento_id: st.evento.id, modo: 'exclusiva' } }); }, 'Mesas passadas a exclusivas.');
    return; }
  if (mesas.length === 1) {
    const m = mesas[0];
    p.innerHTML = `<h3>Mesa ${esc(m.codigo)} <span class="etiqueta">${nomeEstadoMesa(m.estado)}</span></h3><form id="f-mesa">
      <div class="grelha2"><label>Código <input name="codigo" value="${esc(m.codigo)}"></label>
      <label>Tipo <select name="tipo_id">${st.tipos.map((t) => `<option value="${t.id}" ${t.id === m.tipo_id ? 'selected' : ''}>${esc(t.nome)}</option>`).join('')}</select></label>
      <label>Lugares <input name="lugares" type="number" min="1" max="60" value="${m.lugares}"></label><label>Máximo <input name="lugares_max" type="number" min="1" value="${m.lugares_max}"></label>
      <label>Modo <select name="modo"><option value="exclusiva" ${m.modo === 'exclusiva' ? 'selected' : ''}>exclusiva</option><option value="mista" ${m.modo === 'mista' ? 'selected' : ''}>mista</option></select></label>
      <label>Rotação <input name="rotacao" type="number" step="15" value="${m.rotacao}"></label>
      <label>Comprimento (m) <input name="comprimento" type="number" step="0.1" value="${m.comprimento}"></label><label>Largura (m) <input name="largura" type="number" step="0.1" value="${m.largura}"></label>
      <label>Sector <input name="sector" value="${esc(m.sector)}"></label><label>Zona (opcional) <input name="zona" value="${esc(m.zona)}"></label>
      <label>Ordem na sugestão <input name="ordem_sugestao" type="number" value="${m.ordem_sugestao}"></label></div>
      <div class="linha-btns"><button class="btn primario" type="submit">Guardar</button><button class="btn" type="button" id="pe-rodar">Rodar 90</button><button class="btn" type="button" id="pe-dup">Duplicar</button>
      ${m.juncao_de ? '<button class="btn" type="button" id="pe-separar">Separar</button>' : ''}<button class="btn" type="button" id="pe-bloq">${m.bloqueada ? 'Desbloquear' : 'Bloquear'}</button><button class="btn perigo" type="button" id="pe-apagar">Apagar</button></div></form>
      <p class="suave">${m.ocupados} lugares ocupados. ${m.ocupados ? 'Com gente sentada só se pode mover, rodar ou aumentar.' : ''}</p>`;
    const f = $('#f-mesa');
    f.onsubmit = (e) => { e.preventDefault(); const fd = Object.fromEntries(new FormData(f)); tentar(() => rpc('mesas_guardar_mesa', { p: { id: m.id, evento_id: st.evento.id, codigo: fd.codigo, tipo_id: fd.tipo_id, lugares: Number(fd.lugares), lugares_max: Number(fd.lugares_max), modo: fd.modo, rotacao: Number(fd.rotacao), comprimento: Number(fd.comprimento), largura: Number(fd.largura), sector: fd.sector, zona: fd.zona, ordem_sugestao: Number(fd.ordem_sugestao) } }), 'Mesa guardada.'); };
    $('#pe-rodar').onclick = () => tentar(() => rpc('mesas_guardar_mesa', { p: { id: m.id, evento_id: st.evento.id, rotacao: (Number(m.rotacao) + 90) % 360 } }));
    $('#pe-dup').onclick = () => tentar(() => rpc('mesas_guardar_mesa', { p: { evento_id: st.evento.id, tipo_id: m.tipo_id, lugares: m.lugares, lugares_max: m.lugares_max, x: Number(m.x) + 0.5, y: Number(m.y) + 0.5, comprimento: m.comprimento, largura: m.largura, rotacao: m.rotacao, modo: m.modo, sector: m.sector } }), 'Mesa duplicada.');
    if ($('#pe-separar')) $('#pe-separar').onclick = async () => { try { await rpc('mesas_separar', { p_mesa: m.id, p_forcar: false }); aviso('Mesas separadas.'); await recarregar(); } catch (e) { if (e.message.includes('não cabe') && await confirmar('Separar mesas', e.message, 'Separar na mesma')) tentar(() => rpc('mesas_separar', { p_mesa: m.id, p_forcar: true }), 'Mesas separadas; o grupo voltou à lista por sentar.'); else aviso(e.message, true); } };
    $('#pe-bloq').onclick = async () => { if (m.bloqueada) return tentar(() => rpc('mesas_bloquear', { p_mesa: m.id, p_bloquear: false, p_motivo: null }), 'Desbloqueada.'); const mo = await confirmar('Bloquear mesa', 'Casa, patrocinadores, artistas...', 'Bloquear', true); if (mo) tentar(() => rpc('mesas_bloquear', { p_mesa: m.id, p_bloquear: true, p_motivo: mo }), 'Bloqueada.'); };
    $('#pe-apagar').onclick = async () => { if (await confirmar('Apagar mesa ' + m.codigo, 'A mesa sai da planta.', 'Apagar')) { st.editor.sel.clear(); tentar(() => rpc('mesas_apagar_mesa', { p_mesa: m.id }), 'Mesa apagada.'); } };
    return;
  }
  const e = elems[0];
  p.innerHTML = `<h3>${esc(e.nome || e.tipo)}</h3><form id="f-elem"><div class="grelha2"><label>Nome <input name="nome" value="${esc(e.nome)}"></label><label>Tipo <input name="tipo" value="${esc(e.tipo)}" readonly></label>
    <label>Largura (m) <input name="largura" type="number" step="0.1" value="${e.largura}"></label><label>Altura (m) <input name="altura" type="number" step="0.1" value="${e.altura}"></label><label>Rotação <input name="rotacao" type="number" step="15" value="${e.rotacao}"></label></div>
    <div class="linha-btns"><button class="btn primario" type="submit">Guardar</button><button class="btn perigo" type="button" id="pe-apagar-el">Apagar</button></div></form>`;
  $('#f-elem').onsubmit = (ev) => { ev.preventDefault(); const fd = Object.fromEntries(new FormData($('#f-elem'))); tentar(() => rpc('mesas_guardar_elemento', { p: { id: e.id, evento_id: st.evento.id, nome: fd.nome, largura: Number(fd.largura), altura: Number(fd.altura), rotacao: Number(fd.rotacao) } }), 'Elemento guardado.'); };
  $('#pe-apagar-el').onclick = async () => { if (await confirmar('Apagar elemento', e.nome || e.tipo, 'Apagar')) { st.editor.sel.clear(); tentar(() => rpc('mesas_apagar_elemento', { p_id: e.id }), 'Elemento apagado.'); } };
}

// ------------------------------------------------ definições (gestão e admin)
function vistaDefinicoes(v) {
  const ev = st.evento; const precos = ev.precos || {};
  v.innerHTML = `<div class="pagina">
    <h2>Evento</h2><form id="f-evento" class="cartao"><div class="grelha3">
      <label>Nome <input name="nome" value="${esc(ev.nome)}"></label><label>Data <input name="data" type="date" value="${ev.data}"></label>
      <label>Estado <select name="estado">${['preparacao', 'vendas', 'fechado'].map((s) => `<option value="${s}" ${ev.estado === s ? 'selected' : ''}>${{ preparacao: 'em preparação', vendas: 'em vendas', fechado: 'fechado' }[s]}</option>`).join('')}</select></label>
      <label>Lotação-alvo <input name="lotacao_alvo" type="number" value="${ev.lotacao_alvo}"></label>
      <label>Reserva provisória (horas) <input name="prazo_provisoria_horas" type="number" value="${ev.prazo_provisoria_horas}"></label>
      <label>Grupo máximo em mesa mista <input name="max_grupo_mista" type="number" value="${ev.max_grupo_mista}"></label>
      <label>Preço em vigor, bilhete Normal (MT) <input name="preco_normal" type="number" step="0.01" value="${esc(precos.Normal ?? '')}" placeholder="sem verificação"></label>
      <label>Sala: largura (m) <input name="largura_m" type="number" step="0.5" value="${ev.largura_m}"></label><label>Sala: altura (m) <input name="altura_m" type="number" step="0.5" value="${ev.altura_m}"></label></div>
      <div class="linha-btns"><button class="btn primario">Guardar evento</button>${st.eu.nivel === 'admin' ? '<button class="btn" type="button" id="d-novo-evento">Novo evento a partir desta planta</button>' : ''}</div></form>
    <h2>Sistema de bilhetes</h2><div class="cartao" id="lig-bilhetes"><p class="suave">A carregar...</p></div>
    ${st.eventos.length > 1 ? `<p>Mudar de evento: <select id="d-evento">${st.eventos.map((e) => `<option value="${e.id}" ${e.id === ev.id ? 'selected' : ''}>${esc(e.nome)} (${e.data})</option>`).join('')}</select></p>` : ''}
    <h2>Tipos de mesa</h2><table class="dados"><tr><th>Código</th><th>Nome</th><th>Forma</th><th>Comp. x larg. (m)</th><th>Lugares</th><th>Máx.</th><th>Inventário próprio</th><th>Alugado</th><th></th></tr>
      ${st.tipos.map((t) => `<tr class="${t.activo ? '' : 'suave'}"><td>${esc(t.codigo)}</td><td>${esc(t.nome)}</td><td>${esc(t.forma)}</td><td>${t.comprimento_m} x ${t.largura_m}</td><td>${t.lugares}</td><td>${t.lugares_max}</td><td>${t.inventario_proprio}</td><td>${t.inventario_alugado}</td><td><button class="btn pequeno d-tipo" data-id="${t.id}">Alterar</button></td></tr>`).join('')}</table>
    <div class="linha-btns"><button class="btn" id="d-novo-tipo">Novo tipo de mesa</button></div>
    ${st.eu.nivel === 'admin' ? `<h2>Equipa</h2><table class="dados"><tr><th>Nome</th><th>Email</th><th>Perfil</th><th>Activo</th><th></th></tr>${st.utilizadores.map((u) => `<tr><td>${esc(u.nome)}</td><td>${esc(u.email)}</td><td>${nomeNivel(u.nivel)}</td><td>${u.activo ? 'sim' : 'não'}</td><td><button class="btn pequeno d-util" data-id="${u.id}">Alterar</button></td></tr>`).join('')}</table>
      <div class="linha-btns"><button class="btn" id="d-novo-util">Adicionar pessoa</button></div><p class="suave">Cada pessoa cria a sua conta na página de entrada (Criar conta) com o mesmo email que está aqui.</p>` : ''}</div>`;
  $('#f-evento').onsubmit = (e) => { e.preventDefault(); const fd = Object.fromEntries(new FormData(e.target)); const np = { ...precos }; if (fd.preco_normal === '') delete np.Normal; else np.Normal = Number(fd.preco_normal);
    tentar(() => rpc('mesas_guardar_evento', { p: { id: ev.id, nome: fd.nome, data: fd.data, estado: fd.estado, lotacao_alvo: Number(fd.lotacao_alvo), prazo_provisoria_horas: Number(fd.prazo_provisoria_horas), max_grupo_mista: Number(fd.max_grupo_mista), precos: np, largura_m: Number(fd.largura_m), altura_m: Number(fd.altura_m) } }), 'Evento guardado.'); };
  if ($('#d-evento')) $('#d-evento').onchange = (e) => { localStorage.setItem('mesas_evento', e.target.value); location.reload(); };
  ligacaoBilhetes();
  if ($('#d-novo-evento')) $('#d-novo-evento').onclick = () => { const c = modal('<h2>Novo evento</h2><label>Nome <input id="ne-nome"></label><label>Data <input id="ne-data" type="date"></label><label>Lotação-alvo <input id="ne-lot" type="number" value="300"></label><label><input type="checkbox" id="ne-copiar" checked style="width:auto"> Copiar a planta deste evento</label><div class="linha-btns"><button class="btn primario" id="ne-ok">Criar</button><button class="btn" id="ne-nao">Cancelar</button></div>');
    $('#ne-nao', c).onclick = fecharModal; $('#ne-ok', c).onclick = async () => { try { const id = await rpc('mesas_guardar_evento', { p: { nome: $('#ne-nome', c).value, data: $('#ne-data', c).value, lotacao_alvo: Number($('#ne-lot', c).value) } }); if ($('#ne-copiar', c).checked) await rpc('mesas_copiar_planta', { p_de: ev.id, p_para: id }); localStorage.setItem('mesas_evento', id); location.reload(); } catch (e) { aviso(e.message, true); } }; };
  const formTipo = (t = {}) => { const c = modal(`<h2>${t.id ? 'Alterar' : 'Novo'} tipo de mesa</h2><form id="f-tipo"><div class="grelha2">
      <label>Código <input name="codigo" required value="${esc(t.codigo)}"></label><label>Nome <input name="nome" required value="${esc(t.nome)}"></label>
      <label>Forma <select name="forma">${['rect', 'redonda', 'lounge'].map((f) => `<option value="${f}" ${t.forma === f ? 'selected' : ''}>${{ rect: 'rectangular', redonda: 'redonda', lounge: 'lounge' }[f]}</option>`).join('')}</select></label>
      <label>Lugares <input name="lugares" type="number" min="1" required value="${t.lugares || 4}"></label><label>Lugares máximo <input name="lugares_max" type="number" min="1" required value="${t.lugares_max || 5}"></label>
      <label>Comprimento (m) <input name="comprimento_m" type="number" step="0.1" required value="${t.comprimento_m || 1.2}"></label><label>Largura (m) <input name="largura_m" type="number" step="0.1" required value="${t.largura_m || 0.8}"></label>
      <label>Inventário próprio <input name="inventario_proprio" type="number" value="${t.inventario_proprio || 0}"></label><label>Alugado <input name="inventario_alugado" type="number" value="${t.inventario_alugado || 0}"></label>
      <label>Ordem <input name="ordem" type="number" value="${t.ordem || 0}"></label>${t.id ? `<label>Activo <select name="activo"><option value="true" ${t.activo ? 'selected' : ''}>sim</option><option value="false" ${!t.activo ? 'selected' : ''}>não</option></select></label>` : ''}</div>
      <div class="linha-btns"><button class="btn primario">Guardar</button><button class="btn" type="button" id="ft-nao">Cancelar</button></div></form>`);
    $('#ft-nao', c).onclick = fecharModal;
    $('#f-tipo', c).onsubmit = (e) => { e.preventDefault(); const fd = Object.fromEntries(new FormData(e.target)); for (const k of ['lugares', 'lugares_max', 'comprimento_m', 'largura_m', 'inventario_proprio', 'inventario_alugado', 'ordem']) fd[k] = Number(fd[k]); if (fd.activo != null) fd.activo = fd.activo === 'true'; fecharModal(); tentar(() => rpc('mesas_guardar_tipo', { p: { ...fd, id: t.id, evento_id: ev.id } }), 'Tipo guardado.'); }; };
  $('#d-novo-tipo').onclick = () => formTipo(); $$('.d-tipo').forEach((b) => b.onclick = () => formTipo(st.tipos.find((t) => t.id === b.dataset.id)));
  const formUtil = (u = {}) => { const c = modal(`<h2>${u.id ? 'Alterar' : 'Adicionar'} pessoa</h2><form id="f-util"><label>Nome <input name="nome" required value="${esc(u.nome)}"></label><label>Email <input name="email" type="email" required value="${esc(u.email)}"></label>
      <label>Perfil <select name="nivel">${['admin', 'gestao', 'caixa', 'consulta'].map((n) => `<option value="${n}" ${u.nivel === n ? 'selected' : ''}>${nomeNivel(n)}</option>`).join('')}</select></label>
      ${u.id ? `<label>Activo <select name="activo"><option value="true" ${u.activo ? 'selected' : ''}>sim</option><option value="false" ${!u.activo ? 'selected' : ''}>não</option></select></label>` : ''}
      <div class="linha-btns"><button class="btn primario">Guardar</button><button class="btn" type="button" id="fu-nao">Cancelar</button></div></form>`);
    $('#fu-nao', c).onclick = fecharModal;
    $('#f-util', c).onsubmit = (e) => { e.preventDefault(); const fd = Object.fromEntries(new FormData(e.target)); if (fd.activo != null) fd.activo = fd.activo === 'true'; fecharModal(); tentar(() => rpc('mesas_guardar_utilizador', { p: { ...fd, id: u.id } }), 'Pessoa guardada.'); }; };
  if ($('#d-novo-util')) { $('#d-novo-util').onclick = () => formUtil(); $$('.d-util').forEach((b) => b.onclick = () => formUtil(st.utilizadores.find((u) => u.id === b.dataset.id))); }
}

arrancar().catch((e) => { console.error(e); $('#app').innerHTML = `<div class="centro"><div class="caixa"><h1>Não foi possível arrancar</h1><p>${esc(e.message)}</p><p class="suave">Verifique o ficheiro config.js e a ligação.</p></div></div>`; });


// ------------------------------------------------ ligação ao sistema de bilhetes (Definições)
async function ligacaoBilhetes() {
  const caixa = $('#lig-bilhetes'); if (!caixa) return;
  let evs = [];
  try { evs = await rpc('mesas_eventos_bilhetes'); } catch (e) { caixa.innerHTML = `<p class="erro">${esc(e.message)}</p>`; return; }
  const ligado = evs.find((e) => e.id === st.evento.bilhetes_evento_id);
  const nGrupos = st.grupos.filter((g) => daEncomenda(g) && g.estado !== 'cancelado').length;
  caixa.innerHTML = `
    <p>${ligado ? `Ligado ao evento <b>${esc(ligado.nome)}</b> (${dh(ligado.inicio_em)}): ${ligado.encomendas_pagas} encomendas pagas, ${ligado.bilhetes} bilhetes. Neste momento há ${nGrupos} grupos vindos das encomendas.`
                : 'Este evento ainda não está ligado a nenhum evento do sistema de bilhetes. Enquanto não estiver, os grupos registam-se à mão.'}</p>
    <p class="suave">Quando está ligado, cada encomenda paga aparece aqui como grupo por sentar, com os bilhetes e valores reais; o caixa só escolhe a mesa. A porta vê a mesa ao ler o QR e a leitura marca a chegada do grupo.</p>
    <div class="grelha2">
      <label>Evento de bilhetes <select id="lig-ev"><option value="">nenhum (sem ligação)</option>${evs.map((e) => `<option value="${e.id}" ${e.id === st.evento.bilhetes_evento_id ? 'selected' : ''}>${esc(e.nome)}, ${dh(e.inicio_em)} (${e.encomendas_pagas} pagas)</option>`).join('')}</select></label>
      <label style="align-self:end"><input type="checkbox" id="lig-wa" style="width:auto" ${st.evento.avisar_mesa_whatsapp ? 'checked' : ''}> Avisar o cliente por WhatsApp quando o grupo fica sentado (modelo cnb_mesa, só depois de aprovado na Meta)</label>
    </div>
    <div class="linha-btns"><button class="btn primario" id="lig-ok">${ligado ? 'Guardar e voltar a importar as encomendas' : 'Ligar e importar as encomendas pagas'}</button></div>`;
  $('#lig-ok').onclick = async () => {
    const ev = $('#lig-ev').value || null, wa = $('#lig-wa').checked;
    if (!ev && st.evento.bilhetes_evento_id && !await confirmar('Desligar do sistema de bilhetes', 'Os grupos já criados ficam como estão, mas deixam de acompanhar as encomendas.', 'Desligar')) return;
    const n = await tentar(() => rpc('mesas_ligar_evento', { p_mesas_evento: st.evento.id, p_evento_bilhetes: ev, p_avisar_whatsapp: wa }));
    if (n !== undefined) { aviso(ev ? `Ligado. ${n} encomendas sincronizadas.` : 'Ligação removida.'); desenharVista(); }
  };
}
