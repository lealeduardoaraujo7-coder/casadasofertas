/* ===== Checkout — Casa das Ofertas ===== */

const $ = (id) => document.getElementById(id);
const etapas = {
  dados: $('etapaDados'),
  pagamento: $('etapaPagamento'),
  pix: $('etapaPix'),
  ok: $('etapaOk'),
};

const PRECO = 68.90;
const FRETE = 19.90; // fixo, qualquer CEP
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

/* ---------- Quantidade ---------- */
const real = (v) => `R$ ${v.toFixed(2).replace('.', ',')}`;

function pintarQuantidade() {
  const subtotal = PRECO * quantidade;
  const total = subtotal + FRETE;
  $('qtdValor').textContent = quantidade;
  $('valorItem').textContent = real(subtotal);
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
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
        // origem da campanha, para conferir a atribuição depois
        utms: JSON.parse(sessionStorage.getItem('utms') || '{}'),
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro || 'Não foi possível concluir o pagamento.');

    pedidoId = d.pedidoId;
    $('passo3').classList.add('ativo');
    etapas.pagamento.hidden = true;
    // valor já cobrado: não deixa mexer na quantidade depois do Pix gerado
    $('qtdMenos').disabled = true;
    $('qtdMais').disabled = true;

    if (d.aprovado) {
      rastrear.comprar(pedidoId);
      etapas.ok.hidden = false;
    } else {
      $('idPedido').textContent = d.pedidoId;
      $('codigoPix').value = d.pixCopiaECola;
      $('qrArea').innerHTML = d.qrCodeImagem
        ? `<img src="${d.qrCodeImagem}" alt="QR Code PIX" width="300" height="300" class="rounded-xl">`
        : '<p class="text-muted text-sm text-center">Use o código Copia e Cola abaixo para pagar.</p>';
      etapas.pix.hidden = false;
      iniciarPolling();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch { /* tenta de novo no próximo ciclo */ }
  }, 5000);
}
