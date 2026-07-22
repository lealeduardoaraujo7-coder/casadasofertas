/* ===== Checkout — Casa das Ofertas ===== */

const $ = (id) => document.getElementById(id);
const etapas = {
  dados: $('etapaDados'),
  pagamento: $('etapaPagamento'),
  pix: $('etapaPix'),
  ok: $('etapaOk'),
};

const PRECO = 68.90;

let dadosCliente = null;
const metodo = 'pix';
let pedidoId = null;
let poll = null;

const so = (v) => v.replace(/\D/g, '');

// Chegou no checkout: esse é o momento seguro para o evento, com a página
// já carregada e sem navegação em curso para cortar a requisição.
rastrear.iniciarCheckout();

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
        // origem da campanha, para conferir a atribuição depois
        utms: JSON.parse(sessionStorage.getItem('utms') || '{}'),
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro || 'Não foi possível concluir o pagamento.');

    pedidoId = d.pedidoId;
    $('passo3').classList.add('ativo');
    etapas.pagamento.hidden = true;

    if (d.aprovado) {
      rastrear.comprar(pedidoId);
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
        rastrear.comprar(pedidoId);
        etapas.pix.hidden = true;
        etapas.ok.hidden = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch { /* tenta de novo no próximo ciclo */ }
  }, 5000);
}
