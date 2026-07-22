/**
 * Integração com a AmploPay — https://app.amplopay.com/docs
 *
 * Autenticação: dois headers, x-public-key e x-secret-key.
 * URL base:     https://app.amplopay.com/api/v1
 * Receber Pix:  POST /gateway/pix/receive
 * Consultar:    GET  /gateway/transactions?id=...
 *
 * ATENÇÃO ao valor: a AmploPay trabalha em REAIS (100.5 = R$ 100,50),
 * não em centavos. Mandar 8990 aqui cobraria R$ 8.990,00 do cliente.
 *
 * Sem credenciais no .env o sistema roda em MODO SIMULADO, para testar o
 * visual do checkout sem cobrar ninguém.
 */

const BASE = (process.env.AMPLOPAY_BASE_URL || 'https://app.amplopay.com/api/v1').replace(/\/$/, '');
const PIX_PATH = process.env.AMPLOPAY_PIX_PATH || '/gateway/pix/receive';
const CARD_PATH = process.env.AMPLOPAY_CARD_PATH || '/gateway/card/receive';
const STATUS_PATH = process.env.AMPLOPAY_STATUS_PATH || '/gateway/transactions';
const PUBLIC_KEY = process.env.AMPLOPAY_PUBLIC_KEY || '';
const SECRET_KEY = process.env.AMPLOPAY_SECRET_KEY || '';

const modoSimulado = () => !PUBLIC_KEY || !SECRET_KEY;

function headers() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-public-key': PUBLIC_KEY,
    'x-secret-key': SECRET_KEY,
  };
}

/** Status de transação que significam "o dinheiro entrou". */
function statusPago(status) {
  return ['COMPLETED', 'PAID', 'APPROVED'].includes(String(status || '').toUpperCase());
}

async function chamar(url, opcoes) {
  const resp = await fetch(url, opcoes);
  const texto = await resp.text();
  let dados;
  try { dados = JSON.parse(texto); } catch { dados = { raw: texto }; }
  return { ok: resp.ok, status: resp.status, texto, dados };
}

/** Monta o bloco `client` exigido pela AmploPay. */
function clienteAmplo(c) {
  return {
    name: c.nome,
    email: c.email,
    phone: c.telefone,
    document: c.cpf,
  };
}

/**
 * Cria uma cobrança Pix.
 * @returns {{ transacaoId, pixCopiaECola, qrCodeImagem, simulado }}
 */
async function criarPix({ valor, descricao, cliente, referencia, callbackUrl }) {
  if (modoSimulado()) {
    const fake = `00020126SIMULADO-${referencia}-${Date.now()}5204000053039865802BR6009SAO PAULO62070503***6304ABCD`;
    return { transacaoId: `sim_${referencia}`, pixCopiaECola: fake, qrCodeImagem: null, simulado: true };
  }

  const corpo = {
    identifier: referencia,
    amount: valor, // em REAIS
    client: clienteAmplo(cliente),
    products: [{ id: 'kit-halteres-6em1', name: descricao, quantity: 1, price: valor }],
    metadata: { origem: 'site', pedido: referencia },
    ...(callbackUrl ? { callbackUrl } : {}),
  };

  const r = await chamar(BASE + PIX_PATH, { method: 'POST', headers: headers(), body: JSON.stringify(corpo) });

  if (!r.ok) {
    console.error('[AmploPay] erro ao criar Pix:', r.status, r.texto);
    const msg = r.dados?.message || 'Não foi possível gerar o Pix agora.';
    throw new Error(msg);
  }

  // A criação devolve status OK / PENDING / FAILED / REJECTED / CANCELED
  if (['FAILED', 'REJECTED', 'CANCELED'].includes(String(r.dados.status || '').toUpperCase())) {
    throw new Error(r.dados.errorDescription || 'A cobrança Pix foi recusada.');
  }

  const pix = r.dados.pix || {};
  if (!pix.code) {
    console.error('[AmploPay] resposta sem código Pix:', r.texto);
    throw new Error('A AmploPay respondeu, mas não veio o código Pix.');
  }

  return {
    transacaoId: r.dados.transactionId,
    pixCopiaECola: pix.code,
    qrCodeImagem: pix.base64 ? `data:image/png;base64,${pix.base64}` : (pix.image || null),
    simulado: false,
  };
}

/**
 * Cobra no cartão de crédito.
 * O corpo segue o mesmo padrão do Pix, com o bloco `card` a mais.
 * >>> A página "Receber cartão" da doc ainda não foi conferida: se a rota ou
 *     os nomes dos campos forem outros, é só ajustar aqui e no .env. <<<
 * @returns {{ transacaoId, aprovado, motivo, simulado }}
 */
async function cobrarCartao({ valor, descricao, cliente, referencia, callbackUrl, cartao }) {
  if (modoSimulado()) {
    const aprovado = !cartao.numero.endsWith('0000');
    return {
      transacaoId: `sim_${referencia}`,
      aprovado,
      motivo: aprovado ? null : 'Pagamento recusado pelo emissor (simulação).',
      simulado: true,
    };
  }

  const corpo = {
    identifier: referencia,
    amount: valor,
    client: clienteAmplo(cliente),
    products: [{ id: 'kit-halteres-6em1', name: descricao, quantity: 1, price: valor }],
    installments: cartao.parcelas,
    card: {
      number: cartao.numero,
      holderName: cartao.titular,
      expirationMonth: String(cartao.mes).padStart(2, '0'),
      expirationYear: String(cartao.ano),
      cvv: cartao.cvv,
    },
    metadata: { origem: 'site', pedido: referencia },
    ...(callbackUrl ? { callbackUrl } : {}),
  };

  const r = await chamar(BASE + CARD_PATH, { method: 'POST', headers: headers(), body: JSON.stringify(corpo) });

  if (!r.ok) {
    console.error('[AmploPay] erro ao cobrar cartão:', r.status, r.texto);
    throw new Error(r.dados?.message || 'Não foi possível processar o cartão. Tente pagar com Pix.');
  }

  const status = String(r.dados.status || '').toUpperCase();
  const aprovado = ['OK', 'COMPLETED', 'APPROVED', 'PAID'].includes(status);

  return {
    transacaoId: r.dados.transactionId,
    aprovado,
    motivo: aprovado ? null : (r.dados.errorDescription || 'Pagamento não autorizado pelo emissor.'),
    simulado: false,
  };
}

/**
 * Consulta a transação. A doc pede para NÃO usar isso como polling frequente
 * (a confirmação boa vem pelo callbackUrl), então quem chama aqui controla o
 * intervalo — ver o limite em server.js.
 */
async function consultarPago(transacaoId) {
  if (modoSimulado()) return false;

  const url = `${BASE}${STATUS_PATH}?id=${encodeURIComponent(transacaoId)}`;
  const r = await chamar(url, { headers: headers() });
  if (!r.ok) {
    console.error('[AmploPay] erro ao consultar transação:', r.status, r.texto);
    return false;
  }
  return statusPago(r.dados.status);
}

module.exports = { criarPix, cobrarCartao, consultarPago, statusPago, modoSimulado };
