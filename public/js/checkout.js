/* ===== Checkout — Casa das Ofertas ===== */

const $ = (id) => document.getElementById(id);
const etapas = {
  dados: $('etapaDados'),
  pagamento: $('etapaPagamento'),
  pix: $('etapaPix'),
  ok: $('etapaOk'),
  upsell: $('etapaUpsell'),
  upsellPix: $('etapaUpsellPix'),
};

const PRECO = 6.00;
const FRETE = 0; // fixo, qualquer CEP
const QTD_MAXIMA = 5;

let quantidade = 1;
// O frete só entra no resumo depois que o CEP é informado: antes disso o cliente
// não tem como saber de onde veio o valor.
let freteConfirmado = false;
let dadosCliente = null;
const metodo = 'pix';
let pedidoId = null;
let poll = null;

const so = (v) => v.replace(/\D/g, '');

// Chegou no checkout: esse é o momento seguro para o evento, com a página
// já carregada e sem navegação em curso para cortar a requisição.
rastrear.iniciarCheckout();

/* ---------- Order bumps ----------
   O catálogo vem de /api/bumps, não fica escrito aqui: preço só existe no
   servidor, que é quem cobra. O navegador manda apenas os ids marcados.      */
const real = (v) => `R$ ${v.toFixed(2).replace('.', ',')}`;

let bumpsDisponiveis = [];
const bumpsMarcados = new Set();

const totalBumps = () => bumpsDisponiveis
  .filter((b) => bumpsMarcados.has(b.id))
  .reduce((s, b) => s + Number(b.preco || 0), 0);

let upsellsDisponiveis = [];
const upsellsMarcados = new Set();

async function carregarBumps() {
  try {
    const r = await fetch('/api/bumps');
    if (!r.ok) return;
    const d = await r.json();
    bumpsDisponiveis = d.bumps || [];
    upsellsDisponiveis = d.upsells || [];
  } catch {
    return; // sem bump o checkout segue normal
  }
  if (!bumpsDisponiveis.length) return;

  $('bumpsLista').innerHTML = bumpsDisponiveis.map((b) => `
    <label class="flex items-center gap-3 border-2 border-dashed border-brand/40 bg-brand/5 rounded-xl p-2.5 cursor-pointer" data-bump="${b.id}">
      <input type="checkbox" class="w-5 h-5 shrink-0 accent-brand" data-bump-check="${b.id}">
      <img src="/img/${b.imagem}" alt="" onerror="this.remove()"
           class="w-12 h-12 object-contain rounded-lg bg-white shrink-0">
      <span class="leading-tight min-w-0">
        <span class="block text-[13px] font-bold text-ink">${b.nome}</span>
        <span class="block text-[11px] text-muted">${b.descricao || ''}</span>
        <span class="block text-[13px] font-extrabold text-brandDk mt-0.5">+ ${real(Number(b.preco))}</span>
      </span>
    </label>`).join('');

  $('bumpsLista').querySelectorAll('[data-bump-check]').forEach((cx) => {
    cx.addEventListener('change', () => {
      const id = cx.getAttribute('data-bump-check');
      if (cx.checked) bumpsMarcados.add(id); else bumpsMarcados.delete(id);
      // Destaca o card escolhido para o cliente enxergar o que somou.
      cx.closest('[data-bump]').classList.toggle('border-solid', cx.checked);
      cx.closest('[data-bump]').classList.toggle('border-brand', cx.checked);
      pintarQuantidade();
    });
  });

  $('bumpsBox').hidden = false;
}

/* ---------- Quantidade ---------- */

function pintarQuantidade() {
  const subtotal = PRECO * quantidade + totalBumps();
  const total = subtotal + FRETE;
  $('qtdValor').textContent = quantidade;
  $('valorItem').textContent = real(PRECO * quantidade);
  $('valorSubtotal').textContent = real(subtotal);

  if (freteConfirmado) {
    $('valorFrete').textContent = real(FRETE);
    $('valorFrete').className = 'text-ink font-semibold';
    $('valorTotal').textContent = real(total);
  } else {
    // Deixa claro que falta calcular, em vez de esconder que existe frete.
    $('valorFrete').textContent = 'informe o CEP';
    $('valorFrete').className = 'text-muted text-[12px]';
    $('valorTotal').textContent = real(subtotal);
  }
  // Na etapa de pagamento o valor é sempre o cobrado de verdade, com frete —
  // o CEP é obrigatório para chegar até lá.
  $('totalPagamento').textContent = real(total);
  $('qtdMenos').disabled = quantidade <= 1;
  $('qtdMais').disabled = quantidade >= QTD_MAXIMA;
  $('qtdAviso').hidden = quantidade < QTD_MAXIMA;
}

$('qtdMenos').addEventListener('click', () => {
  if (quantidade > 1) { quantidade--; pintarQuantidade(); }
});
$('qtdMais').addEventListener('click', () => {
  if (quantidade < QTD_MAXIMA) { quantidade++; pintarQuantidade(); }
});
pintarQuantidade();
carregarBumps(); // busca o catálogo e repinta o resumo quando o cliente marcar

/* ---------- Máscaras ---------- */
function mascara(input, fn) {
  input.addEventListener('input', () => { input.value = fn(input.value); });
}
mascara($('cpf'), (v) => so(v).slice(0, 11)
  .replace(/(\d{3})(\d)/, '$1.$2')
  .replace(/(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
  .replace(/(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4'));

mascara($('telefone'), (v) => so(v).slice(0, 11)
  .replace(/(\d{2})(\d)/, '($1) $2')
  .replace(/(\(\d{2}\) \d{5})(\d)/, '$1-$2'));

mascara($('cep'), (v) => so(v).slice(0, 8).replace(/(\d{5})(\d)/, '$1-$2'));

$('uf').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
});

/* ---------- Endereço pelo CEP (ViaCEP) ---------- */
const ICONE_OK = '<svg viewBox="0 0 24 24" class="ic w-4 h-4 shrink-0"><path d="M3 7h11v9H3z"/><path d="M14 10h4l3 3v3h-7z"/><circle cx="7.5" cy="17.3" r="1.4"/><circle cx="17.5" cy="17.3" r="1.4"/></svg>';

/** Mostra frete e prazo embaixo do CEP. O frete é fixo, então nunca falha. */
function mostrarFrete(destino) {
  const cx = $('freteInfo');
  cx.hidden = false;
  cx.className = 'text-[13px] -mt-1 mb-3 flex items-center gap-1.5 text-success font-semibold';
  cx.innerHTML = `${ICONE_OK}<span>${destino ? `Entrega para ${destino} · ` : ''}Frete ${real(FRETE)} · até 7 dias úteis</span>`;
  freteConfirmado = true;
  pintarQuantidade(); // agora o resumo lá em cima pode mostrar o frete e o total
}

function erroFrete(msg) {
  const cx = $('freteInfo');
  cx.hidden = false;
  cx.className = 'text-[13px] -mt-1 mb-3 flex items-center gap-1.5 text-brandDk font-semibold';
  cx.textContent = msg;
  // CEP inválido volta o resumo ao estado sem frete, para não mostrar um total
  // baseado num endereço que não existe.
  freteConfirmado = false;
  pintarQuantidade();
}

$('cep').addEventListener('blur', async () => {
  const cep = so($('cep').value);
  if (!cep) return; // campo vazio: nada a dizer ainda
  if (cep.length !== 8) return erroFrete('CEP incompleto — digite os 8 números.');
  try {
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    const d = await r.json();
    if (d.erro) return erroFrete('CEP não encontrado. Confira os números.');
    if (d.logradouro) $('endereco').value = d.logradouro;
    if (d.localidade) $('cidade').value = d.localidade;
    if (d.uf) $('uf').value = d.uf;
    mostrarFrete(d.localidade && d.uf ? `${d.localidade}/${d.uf}` : '');
    $('numero').focus();
  } catch {
    // offline: o cliente preenche na mão, mas o frete é fixo e já dá para informar
    mostrarFrete('');
  }
});

/* ---------- Validações ---------- */
function cpfValido(cpf) {
  cpf = so(cpf);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (let t = 9; t < 11; t++) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(cpf[i]) * (t + 1 - i);
    let d = (soma * 10) % 11;
    if (d === 10) d = 0;
    if (d !== Number(cpf[t])) return false;
  }
  return true;
}

function erro(el, msg) {
  el.textContent = msg;
  el.hidden = false;
}

/* ---------- Etapa 1 → 2 ---------- */
$('formDados').addEventListener('submit', (e) => {
  e.preventDefault();
  const cx = $('erroDados');
  cx.hidden = true;
  document.querySelectorAll('.invalido').forEach((i) => i.classList.remove('invalido'));

  const campos = ['nome', 'email', 'cpf', 'telefone', 'cep', 'numero', 'endereco', 'cidade', 'uf'];
  const vazios = campos.filter((c) => !$(c).value.trim());
  if (vazios.length) {
    vazios.forEach((c) => $(c).classList.add('invalido'));
    return erro(cx, 'Preencha todos os campos para continuar.');
  }
  if ($('nome').value.trim().split(/\s+/).length < 2) {
    $('nome').classList.add('invalido');
    return erro(cx, 'Digite seu nome completo (nome e sobrenome).');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test($('email').value.trim())) {
    $('email').classList.add('invalido');
    return erro(cx, 'Digite um e-mail válido.');
  }
  if (!cpfValido($('cpf').value)) {
    $('cpf').classList.add('invalido');
    return erro(cx, 'CPF inválido. Confira os números.');
  }
  if (so($('telefone').value).length < 10) {
    $('telefone').classList.add('invalido');
    return erro(cx, 'Digite um celular válido com DDD.');
  }

  dadosCliente = {
    nome: $('nome').value.trim(),
    email: $('email').value.trim(),
    cpf: so($('cpf').value),
    telefone: so($('telefone').value),
    endereco: {
      cep: so($('cep').value),
      rua: $('endereco').value.trim(),
      numero: $('numero').value.trim(),
      cidade: $('cidade').value.trim(),
      uf: $('uf').value.trim(),
    },
  };

  etapas.dados.hidden = true;
  etapas.pagamento.hidden = false;
  $('passo2').classList.add('ativo');
  rastrear.escolherPagamento('pix');
  // Rola até a etapa de pagamento, e não para o topo da página: acima dela fica
  // o resumo do pedido, então mandar para o topo obrigava o cliente a descer de
  // novo para achar o botão — atrito bem na hora de pagar.
  etapas.pagamento.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('btnVoltar').addEventListener('click', () => {
  etapas.pagamento.hidden = true;
  etapas.dados.hidden = false;
  $('passo2').classList.remove('ativo');
});

/* ---------- Finalizar ---------- */
$('btnFinalizar').addEventListener('click', async () => {
  const btn = $('btnFinalizar');
  const cx = $('erroPagamento');
  cx.hidden = true;

  const pagamento = { metodo };

  btn.disabled = true;
  btn.textContent = 'GERANDO SEU PIX...';

  try {
    const r = await fetch('/api/pedidos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente: dadosCliente,
        pagamento,
        quantidade,
        // Só os ids: o preço de cada bump quem sabe é o servidor.
        bumps: [...bumpsMarcados],
        // origem da campanha, para conferir a atribuição depois
        utms: JSON.parse(sessionStorage.getItem('utms') || '{}'),
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro || 'Não foi possível concluir o pagamento.');

    pedidoId = d.pedidoId;
    $('passo3').classList.add('ativo');
    etapas.pagamento.hidden = true;
    // Valor já cobrado: nada que altere o total pode mudar depois do Pix gerado,
    // senão a tela mostraria um valor diferente do que o Pix vai cobrar.
    $('qtdMenos').disabled = true;
    $('qtdMais').disabled = true;
    document.querySelectorAll('[data-bump-check]').forEach((cx) => {
      cx.disabled = true;
      cx.closest('[data-bump]').classList.add('opacity-60', 'pointer-events-none');
    });

    if (d.aprovado) {
      rastrear.comprar(pedidoId);
      etapas.ok.hidden = false;
      mostrarUpsell();
    } else {
      $('idPedido').textContent = d.pedidoId;
      $('codigoPix').value = d.pixCopiaECola;
      $('qrArea').innerHTML = d.qrCodeImagem
        ? `<img src="${d.qrCodeImagem}" alt="QR Code PIX" width="300" height="300" class="rounded-xl">`
        : '<p class="text-muted text-sm text-center">Use o código Copia e Cola abaixo para pagar.</p>';
      etapas.pix.hidden = false;
      iniciarPolling();
    }
    // Leva direto ao QR Code (ou à confirmação), não ao topo: o resumo do pedido
    // fica acima e esconderia justamente o que o cliente precisa ver agora.
    (d.aprovado ? etapas.ok : etapas.pix)
      .scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    erro(cx, e.message);
    btn.disabled = false;
    btn.textContent = 'FINALIZAR COMPRA';
  }
});

/* ---------- Copiar código PIX ---------- */
$('btnCopiar').addEventListener('click', async () => {
  const txt = $('codigoPix');
  try {
    await navigator.clipboard.writeText(txt.value);
  } catch {
    txt.select();
    document.execCommand('copy');
  }
  $('btnCopiar').textContent = 'CÓDIGO COPIADO!';
  setTimeout(() => { $('btnCopiar').textContent = 'COPIAR CÓDIGO PIX'; }, 2500);
});

/* ---------- Verifica pagamento a cada 5s ---------- */
function iniciarPolling() {
  poll = setInterval(async () => {
    try {
      const r = await fetch(`/api/pedidos/${pedidoId}/status`);
      const d = await r.json();
      if (d.pago) {
        clearInterval(poll);
        rastrear.comprar(pedidoId);
        etapas.pix.hidden = true;
        etapas.ok.hidden = false;
        etapas.ok.scrollIntoView({ behavior: 'smooth', block: 'start' });
        mostrarUpsell();
      }
    } catch { /* tenta de novo no próximo ciclo */ }
  }, 5000);
}

/* ---------- Upsell pós-compra ----------
   Só entra depois do pagamento confirmado: a venda principal já está garantida,
   então oferecer aqui não arrisca a conversão. Como o Pix já foi pago, aceitar
   gera uma cobrança nova — não existe "um clique" com Pix.                   */
const totalUpsell = () => upsellsDisponiveis
  .filter((u) => upsellsMarcados.has(u.id))
  .reduce((s, u) => s + Number(u.preco || 0), 0);

function pintarUpsell() {
  const t = totalUpsell();
  $('upsellTotal').textContent = real(t);
  $('btnUpsell').disabled = t <= 0;
}

function mostrarUpsell() {
  if (!upsellsDisponiveis.length || !dadosCliente) return;

  $('upsellLista').innerHTML = upsellsDisponiveis.map((u) => `
    <label class="flex items-center gap-3 border border-line rounded-xl p-2.5 cursor-pointer" data-up="${u.id}">
      <input type="checkbox" class="w-5 h-5 shrink-0 accent-brand" data-up-check="${u.id}">
      <img src="/img/${u.imagem}" alt="" onerror="this.remove()"
           class="w-12 h-12 object-contain rounded-lg bg-white shrink-0">
      <span class="leading-tight min-w-0">
        <span class="block text-[13px] font-bold text-ink">${u.nome}</span>
        <span class="block text-[11px] text-muted">${u.descricao || ''}</span>
        <span class="block text-[13px] font-extrabold text-brandDk mt-0.5">+ ${real(Number(u.preco))}</span>
      </span>
    </label>`).join('');

  $('upsellLista').querySelectorAll('[data-up-check]').forEach((cx) => {
    cx.addEventListener('change', () => {
      const id = cx.getAttribute('data-up-check');
      if (cx.checked) upsellsMarcados.add(id); else upsellsMarcados.delete(id);
      cx.closest('[data-up]').classList.toggle('border-brand', cx.checked);
      cx.closest('[data-up]').classList.toggle('bg-brand/5', cx.checked);
      pintarUpsell();
    });
  });

  pintarUpsell();
  etapas.upsell.hidden = false;
}

$('btnRecusarUpsell')?.addEventListener('click', () => {
  etapas.upsell.hidden = true;
});

$('btnUpsell')?.addEventListener('click', async () => {
  const btn = $('btnUpsell');
  const cxErro = $('upsellErro');
  cxErro.hidden = true;
  btn.disabled = true;
  btn.textContent = 'GERANDO PIX...';

  try {
    const r = await fetch('/api/upsell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente: dadosCliente,
        itens: [...upsellsMarcados],
        pedidoOriginal: pedidoId,
        utms: JSON.parse(sessionStorage.getItem('utms') || '{}'),
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro || 'Não consegui gerar o Pix.');

    $('upsellQr').innerHTML = d.qrCodeImagem
      ? `<img src="${d.qrCodeImagem}" alt="QR Code PIX" width="260" height="260" class="rounded-xl">`
      : '<p class="text-muted text-sm">Use o código Copia e Cola abaixo.</p>';
    $('upsellCodigo').value = d.pixCopiaECola;

    etapas.upsell.hidden = true;
    etapas.upsellPix.hidden = false;
    etapas.upsellPix.scrollIntoView({ behavior: 'smooth', block: 'start' });
    acompanharUpsell(d.pedidoId);
  } catch (e) {
    cxErro.textContent = e.message;
    cxErro.hidden = false;
    btn.disabled = false;
    btn.textContent = 'GERAR PIX DO ADICIONAL';
  }
});

$('btnCopiarUpsell')?.addEventListener('click', async () => {
  const campo = $('upsellCodigo');
  campo.select();
  try { await navigator.clipboard.writeText(campo.value); } catch { document.execCommand('copy'); }
  const btn = $('btnCopiarUpsell');
  btn.textContent = 'CÓDIGO COPIADO!';
  setTimeout(() => { btn.textContent = 'COPIAR CÓDIGO PIX'; }, 2000);
});

function acompanharUpsell(id) {
  const t = setInterval(async () => {
    try {
      const r = await fetch(`/api/pedidos/${id}/status`);
      if ((await r.json()).pago) {
        clearInterval(t);
        $('upsellStatus').className = 'flex items-center justify-center gap-2 bg-success/10 text-success rounded-xl py-3 mt-3 text-sm font-bold';
        $('upsellStatus').textContent = 'Adicional confirmado! Vai junto do seu pedido.';
      }
    } catch { /* tenta de novo */ }
  }, 5000);
}
