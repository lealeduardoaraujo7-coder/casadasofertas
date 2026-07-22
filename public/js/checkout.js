/* ===== Checkout — Casa das Ofertas ===== */

const $ = (id) => document.getElementById(id);
const etapas = {
  dados: $('etapaDados'),
  pagamento: $('etapaPagamento'),
  pix: $('etapaPix'),
  ok: $('etapaOk'),
};

const PRECO = 89.90;
const MAX_PARCELAS = 10;

let dadosCliente = null;
let metodo = 'pix';
let pedidoId = null;
let poll = null;

const so = (v) => v.replace(/\D/g, '');
const brl = (n) => 'R$ ' + n.toFixed(2).replace('.', ',');

// Carga escolhida lá na página do produto
const variacao = sessionStorage.getItem('variacao');
if (variacao) $('variacaoTxt').textContent = `Carga: ${variacao}`;

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
$('cep').addEventListener('blur', async () => {
  const cep = so($('cep').value);
  if (cep.length !== 8) return;
  try {
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    const d = await r.json();
    if (d.erro) return;
    if (d.logradouro) $('endereco').value = d.logradouro;
    if (d.localidade) $('cidade').value = d.localidade;
    if (d.uf) $('uf').value = d.uf;
    $('numero').focus();
  } catch { /* offline: o cliente preenche na mão */ }
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

// Luhn — mesma checagem que a operadora faz
function cartaoValido(num) {
  num = so(num);
  if (num.length < 13) return false;
  let soma = 0, dobra = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (dobra) { d *= 2; if (d > 9) d -= 9; }
    soma += d;
    dobra = !dobra;
  }
  return soma % 10 === 0;
}

function bandeiraDe(num) {
  num = so(num);
  if (/^4/.test(num)) return 'VISA';
  if (/^(5[1-5]|2[2-7])/.test(num)) return 'MASTER';
  if (/^3[47]/.test(num)) return 'AMEX';
  if (/^(4011|4312|4389|5041|5067|6277|6362|6363|650|651|655)/.test(num)) return 'ELO';
  if (/^(30[0-5]|36|38)/.test(num)) return 'DINERS';
  if (/^(38|60)/.test(num)) return 'HIPERCARD';
  return '';
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
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

$('btnVoltar').addEventListener('click', () => {
  etapas.pagamento.hidden = true;
  etapas.dados.hidden = false;
  $('passo2').classList.remove('ativo');
});

/* ---------- Alternar PIX / Cartão ---------- */
document.querySelectorAll('.ck-metodo').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelector('.ck-metodo.selecionado').classList.remove('selecionado');
    btn.classList.add('selecionado');
    metodo = btn.dataset.metodo;
    $('painelPix').hidden = metodo !== 'pix';
    $('painelCartao').hidden = metodo !== 'cartao';
    $('erroPagamento').hidden = true;
  });
});

/* ---------- Campos do cartão ---------- */
$('numeroCartao').addEventListener('input', (e) => {
  e.target.value = so(e.target.value).slice(0, 16).replace(/(\d{4})(?=\d)/g, '$1 ');
  $('bandeiraDetectada').textContent = bandeiraDe(e.target.value);
});
$('validadeCartao').addEventListener('input', (e) => {
  e.target.value = so(e.target.value).slice(0, 4).replace(/(\d{2})(\d)/, '$1/$2');
});
$('cvvCartao').addEventListener('input', (e) => {
  e.target.value = so(e.target.value).slice(0, 4);
});
$('nomeCartao').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase();
});

// Monta as opções de parcelamento (sem juros)
const sel = $('parcelas');
for (let i = 1; i <= MAX_PARCELAS; i++) {
  const o = document.createElement('option');
  o.value = i;
  o.textContent = i === 1
    ? `À vista — ${brl(PRECO)}`
    : `${i}x de ${brl(PRECO / i)} sem juros`;
  sel.appendChild(o);
}

/* ---------- Finalizar ---------- */
$('btnFinalizar').addEventListener('click', async () => {
  const btn = $('btnFinalizar');
  const cx = $('erroPagamento');
  cx.hidden = true;

  let pagamento = { metodo };

  if (metodo === 'cartao') {
    const num = $('numeroCartao').value;
    const val = $('validadeCartao').value;
    if (!cartaoValido(num)) return erro(cx, 'Número do cartão inválido. Confira os dígitos.');
    if ($('nomeCartao').value.trim().length < 3) return erro(cx, 'Digite o nome impresso no cartão.');
    if (!/^\d{2}\/\d{2}$/.test(val)) return erro(cx, 'Validade inválida. Use o formato MM/AA.');
    const [mes, ano] = val.split('/').map(Number);
    if (mes < 1 || mes > 12) return erro(cx, 'Mês de validade inválido.');
    const hoje = new Date();
    if (2000 + ano < hoje.getFullYear() || (2000 + ano === hoje.getFullYear() && mes < hoje.getMonth() + 1)) {
      return erro(cx, 'Esse cartão está vencido.');
    }
    if ($('cvvCartao').value.length < 3) return erro(cx, 'CVV inválido.');

    pagamento.cartao = {
      numero: so(num),
      titular: $('nomeCartao').value.trim(),
      mes, ano: 2000 + ano,
      cvv: $('cvvCartao').value,
      parcelas: Number(sel.value),
    };
  }

  btn.disabled = true;
  btn.textContent = metodo === 'pix' ? 'GERANDO SEU PIX...' : 'PROCESSANDO PAGAMENTO...';

  try {
    const r = await fetch('/api/pedidos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliente: dadosCliente, pagamento }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro || 'Não foi possível concluir o pagamento.');

    pedidoId = d.pedidoId;
    $('passo3').classList.add('ativo');
    etapas.pagamento.hidden = true;

    if (d.aprovado) {
      etapas.ok.hidden = false;
    } else {
      $('idPedido').textContent = d.pedidoId;
      $('codigoPix').value = d.pixCopiaECola;
      $('qrArea').innerHTML = `<img src="${d.qrCodeImagem}" alt="QR Code PIX">`;
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
        etapas.pix.hidden = true;
        etapas.ok.hidden = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch { /* tenta de novo no próximo ciclo */ }
  }, 5000);
}
